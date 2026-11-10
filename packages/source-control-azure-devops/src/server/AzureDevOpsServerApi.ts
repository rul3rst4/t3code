import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { requireSettingsSecretLiteral } from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  parseGitRemoteHost,
  readSourceControlHostSettings,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/shared/definition";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Result from "effect/Result";

import { definition, isAzureDevOpsServicesHost, settings } from "../shared/definition.ts";

/** Azure DevOps Server 2020 serves 6.0; every route used here exists there. */
const API_VERSION = "6.0";
const REQUEST_TIMEOUT = Duration.seconds(30);
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const REMOTE_CACHE_TTL = Duration.minutes(1);
const SERVER_CACHE_TTL = Duration.hours(1);
const CACHE_CAPACITY = 256;
// fetch would carry the token to wherever a redirect points.
const NO_REDIRECT: RequestInit = { redirect: "manual" };
const IDENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const AzureDevOpsServerFailure = Schema.Literals([
  "missing-token",
  "unauthenticated",
  "not-found",
  "rate-limited",
  "failed",
]);

export class AzureDevOpsServerError extends Schema.TaggedError<AzureDevOpsServerError>()(
  "AzureDevOpsServerError",
  {
    operation: Schema.String,
    reason: AzureDevOpsServerFailure,
    status: Schema.optional(Schema.Int),
    /** The server's own sentence, such as which branch policy refused a completion. */
    serverMessage: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  get command(): string {
    return "Azure DevOps Server REST API";
  }

  get detail(): string {
    switch (this.reason) {
      case "missing-token":
        return "Add this Azure DevOps Server's URL and a personal access token in Settings › Source control.";
      case "unauthenticated":
        return "Azure DevOps Server refused the personal access token. Replace it in Settings › Source control.";
      case "not-found":
        return this.serverMessage ?? "Azure DevOps Server could not find it.";
      case "rate-limited":
        return "Azure DevOps Server rate limit exceeded.";
      case "failed":
        return (
          this.serverMessage ??
          `Azure DevOps Server request failed${this.status ? ` (${this.status})` : ""}.`
        );
    }
  }

  override get message(): string {
    return `Azure DevOps Server failed in ${this.operation}: ${this.detail}`;
  }
}

/** One repository on an Azure DevOps Server, as its checkout's remote names it. */
export interface AzureDevOpsServerRepository {
  /** `https://server[/virtual-dir]/Collection`, without a trailing slash. */
  readonly collectionUrl: string;
  readonly project: string;
  readonly repository: string;
  readonly remoteName: string;
}

export interface AzureDevOpsServerViewer {
  readonly id: string;
  /** In the spelling pull requests carry as `uniqueName`, such as `DOMAIN\account`. */
  readonly login: string;
}

export interface AzureDevOpsServerRequest {
  readonly collectionUrl: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Segments below the collection; each is encoded here. */
  readonly path: ReadonlyArray<string | number>;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  readonly maxBytes?: number;
  readonly apiVersion?: string;
}

export class AzureDevOpsServerApi extends Context.Service<
  AzureDevOpsServerApi,
  {
    /** Null for a checkout `az` reads: no Azure remote, or one on Azure DevOps Services. */
    readonly resolve: (
      cwd: string,
    ) => Effect.Effect<AzureDevOpsServerRepository | null, AzureDevOpsServerError>;
    /** The response body, JSON for every route used here. */
    readonly request: (
      input: AzureDevOpsServerRequest,
    ) => Effect.Effect<string, AzureDevOpsServerError>;
    readonly viewer: (
      collectionUrl: string,
    ) => Effect.Effect<AzureDevOpsServerViewer, AzureDevOpsServerError>;
    /** An identity id as given, or the one identity a login, email or name finds. */
    readonly identityId: (
      collectionUrl: string,
      name: string,
    ) => Effect.Effect<string | null, AzureDevOpsServerError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsServerApi") {}

interface ServerRemote {
  readonly name: string;
  readonly hostname: string;
  /** The remote's path, `/Collection/Project/_git/Repo`. */
  readonly path: string;
}

function remotePath(remoteUrl: string): string | null {
  const url = URL.parse(remoteUrl);
  if (url !== null && /^(?:https?|ssh):$/u.test(url.protocol)) return url.pathname;
  // `user@host:path`, which is not a URL.
  const scp = /^(?:[^@/]+@)?[^:/]+:(.+)$/u.exec(remoteUrl)?.[1];
  return scp === undefined ? null : `/${scp.replace(/^\/+/u, "")}`;
}

function serverRemote(remote: {
  readonly name: string;
  readonly url: string;
}): ServerRemote | null {
  const host = parseGitRemoteHost(remote.url);
  const path = remotePath(remote.url)?.replace(/\/+$/u, "");
  if (host === null || !path || isAzureDevOpsServicesHost(host.hostname)) return null;
  return { name: remote.name, hostname: host.hostname, path };
}

function configuredOrigin(serverUrl: string): URL | null {
  const url = URL.parse(serverUrl.trim());
  return url !== null && (url.protocol === "https:" || url.protocol === "http:") ? url : null;
}

const VstsInfoSchema = Schema.Struct({
  serverUrl: Schema.String,
  collection: Schema.Struct({ name: Schema.String }),
  repository: Schema.Struct({
    name: Schema.String,
    project: Schema.Struct({ name: Schema.String }),
  }),
});
const decodeVstsInfo = decodeJsonResult(VstsInfoSchema);

const ConnectionDataSchema = Schema.Struct({
  authenticatedUser: Schema.Struct({ id: Schema.String }),
});
const decodeConnectionData = decodeJsonResult(ConnectionDataSchema);

const IdentityProperty = Schema.optional(
  Schema.NullOr(Schema.Struct({ $value: Schema.optional(Schema.NullOr(Schema.String)) })),
);
const IdentityPageSchema = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      providerDisplayName: Schema.optional(Schema.NullOr(Schema.String)),
      properties: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            Account: IdentityProperty,
            Domain: IdentityProperty,
            Mail: IdentityProperty,
          }),
        ),
      ),
    }),
  ),
});
const decodeIdentityPage = decodeJsonResult(IdentityPageSchema);

const ErrorBodySchema = Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) });
const decodeErrorBody = decodeJsonResult(ErrorBodySchema);

function failureFor(status: number): typeof AzureDevOpsServerFailure.Type {
  // 203 is the sign-in page a server answers an anonymous request with.
  if (status === 401 || status === 203) return "unauthenticated";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "failed";
}

function encodePath(collectionUrl: string, input: AzureDevOpsServerRequest): URL {
  const url = new URL(
    `${collectionUrl}/${input.path.map((segment) => encodeURIComponent(String(segment))).join("/")}`,
  );
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("api-version", input.apiVersion ?? API_VERSION);
  return url;
}

/** @public */
export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;

  const fail = (
    operation: string,
    reason: typeof AzureDevOpsServerFailure.Type,
    extra?: { readonly status?: number; readonly serverMessage?: string; readonly cause?: unknown },
  ) => new AzureDevOpsServerError({ operation, reason, ...extra });

  const readConfig = (operation: string) =>
    host.settings.getWithSecrets(definition.kind).pipe(
      Effect.flatMap((current) => {
        const saved = readSourceControlHostSettings(
          settings,
          current.sourceControlHosts[definition.kind],
        );
        return requireSettingsSecretLiteral(saved.serverToken, current.secretProviders).pipe(
          Effect.map((token) => ({ origin: configuredOrigin(saved.serverUrl), token })),
        );
      }),
      // No cause: a settings decode error can quote a hand-edited token.
      Effect.mapError(() => fail(operation, "missing-token")),
    );

  /** Every request carries the token, so none leaves for anywhere but the configured server. */
  const send = Effect.fn("AzureDevOpsServerApi.send")(function* (input: {
    readonly operation: string;
    readonly method: NonNullable<AzureDevOpsServerRequest["method"]>;
    readonly url: URL;
    readonly body?: unknown;
    readonly maxBytes?: number;
  }) {
    const config = yield* readConfig(input.operation);
    if (config.origin === null || config.token.length === 0) {
      return yield* fail(input.operation, "missing-token");
    }
    if (input.url.origin !== config.origin.origin) {
      return yield* fail(input.operation, "failed", {
        serverMessage: `Azure DevOps Server pointed at ${input.url.host}, outside ${config.origin.host}.`,
      });
    }
    const base = HttpClientRequest.make(input.method)(input.url.href).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.basicAuth("", config.token),
    );
    const request =
      input.body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body));
    const response = yield* httpClient.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) => fail(input.operation, "failed", { cause })),
    );
    const ok = response.status >= 200 && response.status < 300 && response.status !== 203;
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: ok ? (input.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES) : ERROR_BODY_MAX_BYTES,
    }).pipe(
      Effect.mapError((cause) =>
        fail(input.operation, "failed", { status: response.status, cause }),
      ),
    );
    if (response.status >= 300 && response.status < 400) {
      const location = URL.parse(response.headers.location ?? "", input.url.href);
      return yield* fail(input.operation, "failed", {
        status: response.status,
        serverMessage: `Azure DevOps Server redirected to ${location?.origin ?? "another address"}. Use that address in Settings › Source control.`,
      });
    }
    if (!ok) {
      const body = decodeErrorBody(collected.text);
      const serverMessage = Result.isSuccess(body)
        ? (body.success.message ?? undefined)
        : undefined;
      return yield* fail(input.operation, failureFor(response.status), {
        status: response.status,
        ...(serverMessage ? { serverMessage } : {}),
      });
    }
    if (collected.truncated) {
      return yield* fail(input.operation, "failed", {
        status: response.status,
        serverMessage: "Azure DevOps Server answered with more than T3 Code reads at once.",
      });
    }
    return collected.text;
  });

  const decoded = <A>(
    operation: string,
    raw: string,
    decode: (raw: string) => Result.Result<A, unknown>,
  ): Effect.Effect<A, AzureDevOpsServerError> => {
    const result = decode(raw);
    return Result.isSuccess(result)
      ? Effect.succeed(result.success)
      : Effect.fail(
          fail(operation, "failed", {
            serverMessage: "Azure DevOps Server returned an unreadable response.",
            cause: result.failure,
          }),
        );
  };

  // Which remote a checkout reads, re-read now and then so a changed remote is followed.
  const remoteCache = yield* Cache.makeWith(
    (cwd: string) =>
      host.git.remotes(cwd).pipe(
        Effect.flatten,
        Effect.map(({ remotes }) => {
          const azure = remotes.filter((remote) => recognizeRemoteWith(definition, remote.url));
          const chosen = azure.find((remote) => remote.name === "origin") ?? azure[0];
          return chosen === undefined ? null : serverRemote(chosen);
        }),
      ),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? REMOTE_CACHE_TTL : Duration.zero),
    },
  );

  const infoCache = yield* Cache.makeWith(
    (infoUrl: string) =>
      send({ operation: "resolveRepository", method: "GET", url: new URL(infoUrl) }).pipe(
        Effect.flatMap((raw) => decoded("resolveRepository", raw, decodeVstsInfo)),
      ),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? SERVER_CACHE_TTL : Duration.zero),
    },
  );

  const request: AzureDevOpsServerApi["Service"]["request"] = (input) =>
    send({
      operation: input.operation,
      method: input.method ?? "GET",
      url: encodePath(input.collectionUrl, input),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    });

  const identities = (collectionUrl: string, operation: string, query: Record<string, string>) =>
    request({ collectionUrl, operation, path: ["_apis", "identities"], query }).pipe(
      Effect.flatMap((raw) => decoded(operation, raw, decodeIdentityPage)),
    );

  // Keyed by token too, so replacing the token in Settings changes the account at once.
  const viewerCache = yield* Cache.makeWith(
    Effect.fn("AzureDevOpsServerApi.lookupViewer")(function* (key: string) {
      const collectionUrl = key.slice(key.indexOf("\u0000") + 1);
      const connection = yield* request({
        collectionUrl,
        operation: "getViewer",
        path: ["_apis", "connectionData"],
        // Never left preview.
        apiVersion: `${API_VERSION}-preview`,
      }).pipe(Effect.flatMap((raw) => decoded("getViewer", raw, decodeConnectionData)));
      const id = connection.authenticatedUser.id;
      const [identity] = (yield* identities(collectionUrl, "getViewer", { identityIds: id })).value;
      const account = identity?.properties?.Account?.$value?.trim();
      const domain = identity?.properties?.Domain?.$value?.trim();
      const login =
        account && domain && !account.includes("@")
          ? `${domain}\\${account}`
          : account ||
            identity?.properties?.Mail?.$value?.trim() ||
            identity?.providerDisplayName?.trim();
      if (!login) return yield* fail("getViewer", "unauthenticated");
      return { id, login } satisfies AzureDevOpsServerViewer;
    }),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? SERVER_CACHE_TTL : Duration.zero),
    },
  );

  return AzureDevOpsServerApi.of({
    resolve: Effect.fn("AzureDevOpsServerApi.resolve")(function* (cwd) {
      // Anything that cannot list remotes is left to `az`, as before.
      const remote = yield* Cache.get(remoteCache, cwd).pipe(Effect.orElseSucceed(() => null));
      if (remote === null) return null;
      const config = yield* readConfig("resolveRepository");
      if (
        config.origin === null ||
        config.token.length === 0 ||
        config.origin.hostname.toLowerCase() !== remote.hostname
      ) {
        return yield* fail("resolveRepository", "missing-token");
      }
      // An SSH remote names the same path the web server serves the repository at.
      const info = yield* Cache.get(infoCache, `${config.origin.origin}${remote.path}/vsts/info`);
      // Only the path: the server's public URL can name an alias or scheme this machine can't use.
      const serverPath = (URL.parse(info.serverUrl)?.pathname ?? "").replace(/\/+$/u, "");
      return {
        collectionUrl: `${config.origin.origin}${serverPath}/${encodeURIComponent(info.collection.name)}`,
        project: info.repository.project.name,
        repository: info.repository.name,
        remoteName: remote.name,
      };
    }),
    request,
    viewer: Effect.fn("AzureDevOpsServerApi.viewer")(function* (collectionUrl) {
      const { token } = yield* readConfig("getViewer");
      return yield* Cache.get(viewerCache, `${token}\u0000${collectionUrl}`);
    }),
    identityId: Effect.fn("AzureDevOpsServerApi.identityId")(function* (collectionUrl, name) {
      const trimmed = name.trim();
      if (IDENTITY_ID.test(trimmed)) return trimmed;
      const found = yield* identities(collectionUrl, "resolveIdentity", {
        searchFilter: "General",
        filterValue: trimmed,
      });
      return found.value.length === 1 ? (found.value[0]?.id ?? null) : null;
    }),
  });
});

export const layer = Layer.effect(AzureDevOpsServerApi, make);
