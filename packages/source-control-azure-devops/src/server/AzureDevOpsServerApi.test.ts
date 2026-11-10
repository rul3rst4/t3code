import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import * as AzureDevOpsServerApi from "./AzureDevOpsServerApi.ts";

const REMOTE = "https://tfs.example/Contoso%20Apps/Shared%20Tools/_git/web";
const COLLECTION = "https://tfs.example/Contoso%20Apps";

const vstsInfo = {
  serverUrl: "https://tfs.example",
  collection: { name: "Contoso Apps" },
  repository: { name: "web", project: { name: "Shared Tools" } },
};

const pullRequestRow = {
  pullRequestId: 42,
  title: "Add the page",
  status: "active",
  sourceRefName: "refs/heads/feat/page",
  targetRefName: "refs/heads/main",
  creationDate: "2026-07-01T00:00:00Z",
  createdBy: { displayName: "Ana", uniqueName: "CORP\\ana" },
  lastMergeSourceCommit: { commitId: "a".repeat(40) },
  url: `${COLLECTION}/0d1c/_apis/git/repositories/9f2e/pullRequests/42`,
  repository: { id: "9f2e", name: "web", project: { name: "Shared Tools" } },
};

function setup(input: {
  readonly hostSettings?: Record<string, unknown>;
  readonly respond: (url: URL, request: HttpClientRequest.HttpClientRequest) => Response;
}) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const http = HttpClient.make((request) => {
    requests.push(request);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, input.respond(new URL(request.url), request)),
    );
  });
  const remotes = () =>
    Effect.succeed(
      Effect.succeed({
        remotes: [{ name: "origin", url: REMOTE, pushUrl: Option.none(), isPrimary: true }],
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("2026-07-01T00:00:00Z"),
          expiresAt: Option.none(),
        },
      }),
    );
  const host = Layer.mergeAll(
    TestSourceControlHost.layer({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        sourceControlHosts: {
          "azure-devops": input.hostSettings ?? {
            serverUrl: "https://tfs.example",
            serverToken: "pat",
          },
        },
      },
      git: { remotes },
    }),
    NodeServices.layer,
    Layer.succeed(HttpClient.HttpClient, http),
  );
  const layer = AzureDevOpsPullRequestCli.layer.pipe(
    Layer.provideMerge(AzureDevOpsServerApi.layer),
    Layer.provide(
      Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
        execute: () => Effect.die("an Azure DevOps Server checkout ran `az`"),
      }),
    ),
    Layer.provide(host),
  );
  return { requests, layer };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

it.effect("reads a server checkout over REST, sending the token to the configured server", () => {
  const { requests, layer } = setup({
    respond: (url) =>
      url.pathname.endsWith("/vsts/info")
        ? // A public URL this machine may not reach; requests stay on the configured origin.
          json({ ...vstsInfo, serverUrl: "http://tfs01.corp.internal/" })
        : url.pathname === "/Contoso%20Apps/_apis/git/pullrequests/42"
          ? json(pullRequestRow)
          : json({ message: "unexpected" }, 500),
  });
  return Effect.gen(function* () {
    const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
    const pullRequest = yield* cli.getPullRequest({ cwd: "/repo", number: 42 });
    assert.strictEqual(pullRequest.url, `${COLLECTION}/Shared%20Tools/_git/web/pullrequest/42`);
    assert.deepStrictEqual(pullRequest.location, { project: "Shared Tools", repository: "web" });
    assert.deepStrictEqual(
      requests.map((request) => new URL(request.url).pathname),
      [
        "/Contoso%20Apps/Shared%20Tools/_git/web/vsts/info",
        "/Contoso%20Apps/_apis/git/pullrequests/42",
      ],
    );
    for (const request of requests) {
      assert.strictEqual(new URL(request.url).origin, "https://tfs.example");
      assert.strictEqual(request.headers.authorization, `Basic ${btoa(":pat")}`);
    }
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  ["no settings", {}],
  ["another server", { serverUrl: "https://elsewhere.example", serverToken: "pat" }],
  ["no token", { serverUrl: "https://tfs.example", serverToken: "" }],
] as const)("asks for the server and a token, sending nothing, with %s", ([, hostSettings]) => {
  const { requests, layer } = setup({ hostSettings, respond: () => json(vstsInfo) });
  return Effect.gen(function* () {
    const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
    const error = yield* Effect.flip(cli.getPullRequest({ cwd: "/repo", number: 42 }));
    assert.strictEqual(error._tag, "AzureDevOpsServerError");
    assert.strictEqual(error._tag === "AzureDevOpsServerError" && error.reason, "missing-token");
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  ["a refused token", new Response("", { status: 401 }), "unauthenticated"],
  [
    "a redirect, which is not followed",
    new Response("", { status: 302, headers: { location: "https://adfs.example/login" } }),
    "failed",
  ],
] as const)("reports %s", ([, response, reason]) => {
  const { requests, layer } = setup({ respond: () => response.clone() });
  return Effect.gen(function* () {
    const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
    const error = yield* Effect.flip(cli.getPullRequest({ cwd: "/repo", number: 42 }));
    assert.strictEqual(error._tag === "AzureDevOpsServerError" && error.reason, reason);
    assert.strictEqual(requests.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("lists the viewer's pull requests by identity id and names the viewer as rows do", () => {
  const { requests, layer } = setup({
    respond: (url) => {
      if (url.pathname.endsWith("/vsts/info")) return json(vstsInfo);
      if (url.pathname.endsWith("/_apis/connectionData")) {
        return json({ authenticatedUser: { id: "viewer-id" } });
      }
      if (url.pathname.endsWith("/_apis/identities")) {
        return json({
          value: [
            {
              id: "viewer-id",
              properties: { Account: { $value: "ana" }, Domain: { $value: "CORP" } },
            },
          ],
        });
      }
      return json({ value: [pullRequestRow] });
    },
  });
  return Effect.gen(function* () {
    const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
    assert.strictEqual(yield* cli.getViewer({ cwd: "/repo" }), "CORP\\ana");
    const listed = yield* cli.listPullRequests({
      cwd: "/repo",
      repository: "web",
      state: "open",
      involvement: "authored",
      viewer: "CORP\\ana",
      limit: 10,
    });
    assert.deepStrictEqual(
      listed.items.map((item) => [item.number, item.url, item.author?.login]),
      [[42, `${COLLECTION}/Shared%20Tools/_git/web/pullrequest/42`, "CORP\\ana"]],
    );
    const list = new URL(requests.at(-1)?.url ?? "");
    assert.strictEqual(
      list.pathname,
      "/Contoso%20Apps/Shared%20Tools/_apis/git/repositories/web/pullrequests",
    );
    assert.strictEqual(list.searchParams.get("searchCriteria.creatorId"), "viewer-id");
    assert.strictEqual(list.searchParams.get("searchCriteria.status"), "active");
    assert.isNull(list.searchParams.get("searchCriteria.reviewerId"));
  }).pipe(Effect.provide(layer));
});

it.effect("completes a pull request at the commit Azure last evaluated", () => {
  const patch = vi.fn((_body: unknown) => undefined);
  const { layer } = setup({
    respond: (url, request) => {
      if (url.pathname.endsWith("/vsts/info")) return json(vstsInfo);
      if (request.method === "PATCH") {
        assert.strictEqual(
          url.pathname,
          "/Contoso%20Apps/Shared%20Tools/_apis/git/repositories/9f2e/pullrequests/42",
        );
        const body = request.body;
        patch(body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(body.body)) : null);
        return json({ ...pullRequestRow, status: "completed" });
      }
      return json(pullRequestRow);
    },
  });
  return Effect.gen(function* () {
    const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
    const result = yield* cli.runPullRequestAction({
      cwd: "/repo",
      number: 42,
      action: "merge",
      mergeMethod: "squash",
    });
    assert.strictEqual(result?.state, "merged");
    assert.deepStrictEqual(patch.mock.calls, [
      [
        {
          status: "completed",
          lastMergeSourceCommit: { commitId: "a".repeat(40) },
          completionOptions: { squashMerge: true },
        },
      ],
    ]);
  }).pipe(Effect.provide(layer));
});
