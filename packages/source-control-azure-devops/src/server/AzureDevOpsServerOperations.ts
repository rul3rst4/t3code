import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { normalizeRefName } from "@t3tools/source-control-core/server/pullRequestUtils";

import {
  AzureDevOpsServerApi,
  AzureDevOpsServerError,
  type AzureDevOpsServerRepository,
} from "./AzureDevOpsServerApi.ts";
import type { AzureDevOpsRepositoryLocation } from "./azureDevOpsPullRequestJson.ts";

/**
 * Azure DevOps Server's REST routes for what `az` does on Azure DevOps Services. Each read answers
 * in the JSON `az` prints for the same command, so one decoder serves both.
 */

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

type Row = { readonly [key: PropertyKey]: unknown };

const PageSchema = Schema.Struct({ value: Schema.Array(Schema.Unknown) });
const decodePage = decodeJsonResult(PageSchema);
const decodeRow = decodeJsonResult(Schema.Unknown);
const encodeJson = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

const PullRequestRefSchema = Schema.Struct({
  sourceRefName: Schema.String,
  repository: Schema.Struct({
    id: Schema.String,
    project: Schema.Struct({ name: Schema.String }),
  }),
  lastMergeSourceCommit: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
const decodePullRequestRef = Schema.decodeUnknownResult(PullRequestRefSchema);

const RepositoryNameSchema = Schema.Struct({
  name: Schema.String,
  project: Schema.Struct({ name: Schema.String }),
});
const decodeRepositoryName = Schema.decodeUnknownResult(RepositoryNameSchema);

export type ServerPullRequestStatus = "open" | "closed" | "merged" | "all";

function searchStatus(state: ServerPullRequestStatus): string {
  switch (state) {
    case "open":
      return "active";
    case "closed":
      return "abandoned";
    case "merged":
      return "completed";
    case "all":
      return "all";
  }
}

function branchRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

function repositoryPath(project: string, repository: string): ReadonlyArray<string> {
  return [project, "_apis", "git", "repositories", repository];
}

/**
 * A pull request listed by repository carries no web link, and one read alone spells the
 * collection with a bare space. Build the link the server serves, the same way for both.
 */
function withRepositoryWebUrl(collectionUrl: string, row: unknown): unknown {
  if (!Predicate.isObject(row)) return row;
  const repository = decodeRepositoryName(row.repository);
  if (Result.isFailure(repository) || !Predicate.isObject(row.repository)) return row;
  const { name, project } = repository.success;
  const webUrl = `${collectionUrl}/${encodeURIComponent(project.name)}/_git/${encodeURIComponent(name)}`;
  return { ...row, repository: { ...row.repository, webUrl } };
}

function actionBody(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
  pullRequest: typeof PullRequestRefSchema.Type,
  viewerId: () => Effect.Effect<string, AzureDevOpsServerError>,
): Effect.Effect<Row | null, AzureDevOpsServerError> {
  const squash = { squashMerge: mergeMethod === "squash" };
  switch (action) {
    case "merge":
      return Effect.succeed({
        status: "completed",
        lastMergeSourceCommit: pullRequest.lastMergeSourceCommit,
        completionOptions: squash,
      });
    case "enable-auto-merge":
      return viewerId().pipe(
        Effect.map((id) => ({
          autoCompleteSetBy: { id },
          ...(mergeMethod === undefined ? {} : { completionOptions: squash }),
        })),
      );
    case "disable-auto-merge":
      return Effect.succeed({ autoCompleteSetBy: { id: NO_IDENTITY } });
    case "ready":
      return Effect.succeed({ isDraft: false });
    case "draft":
      return Effect.succeed({ isDraft: true });
    case "close":
      return Effect.succeed({ status: "abandoned" });
    case "reopen":
      return Effect.succeed({ status: "active" });
    case "update-branch":
      return Effect.succeed(null);
    case "revert":
    case "approve-workflows":
    case "delete-branch":
      return Effect.die(new Error(`Azure DevOps pull request action ${action} is unsupported`));
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* AzureDevOpsServerApi;
  const fileSystem = yield* FileSystem.FileSystem;
  const { git } = yield* SourceControlHost.SourceControlHost;

  const unreadable = (operation: string, cause: unknown) =>
    new AzureDevOpsServerError({
      operation,
      reason: "failed",
      serverMessage: "Azure DevOps Server returned an unreadable response.",
      cause,
    });

  const json = (operation: string, value: unknown) => {
    const encoded = encodeJson(value);
    return Result.isSuccess(encoded)
      ? Effect.succeed(encoded.success)
      : Effect.fail(unreadable(operation, encoded.failure));
  };

  const read = <A>(
    operation: string,
    raw: string,
    decode: (raw: string) => Result.Result<A, unknown>,
  ): Effect.Effect<A, AzureDevOpsServerError> => {
    const decoded = decode(raw);
    return Result.isSuccess(decoded)
      ? Effect.succeed(decoded.success)
      : Effect.fail(unreadable(operation, decoded.failure));
  };

  /** Pull request ids are unique across a collection, as `az repos pr show --id` reads them. */
  const pullRequestRow = (target: AzureDevOpsServerRepository, operation: string, number: number) =>
    api
      .request({
        collectionUrl: target.collectionUrl,
        operation,
        path: ["_apis", "git", "pullrequests", number],
      })
      .pipe(
        Effect.flatMap((raw) => read(operation, raw, decodeRow)),
        Effect.map((row) => withRepositoryWebUrl(target.collectionUrl, row)),
      );

  const pullRequestRef = (target: AzureDevOpsServerRepository, operation: string, number: number) =>
    pullRequestRow(target, operation, number).pipe(
      Effect.flatMap((row) => {
        const ref = decodePullRequestRef(row);
        return Result.isSuccess(ref)
          ? Effect.succeed({ row, ref: ref.success })
          : Effect.fail(unreadable(operation, ref.failure));
      }),
    );

  const pullRequestPath = (ref: typeof PullRequestRefSchema.Type, number: number) => [
    ...repositoryPath(ref.repository.project.name, ref.repository.id),
    "pullrequests",
    number,
  ];

  const listRows = (
    target: AzureDevOpsServerRepository,
    operation: string,
    repository: string,
    query: Readonly<Record<string, string | number | undefined>>,
  ) =>
    api
      .request({
        collectionUrl: target.collectionUrl,
        operation,
        path: [...repositoryPath(target.project, repository), "pullrequests"],
        query,
      })
      .pipe(
        Effect.flatMap((raw) => read(operation, raw, decodePage)),
        Effect.flatMap((page) =>
          json(
            operation,
            page.value.map((row) => withRepositoryWebUrl(target.collectionUrl, row)),
          ),
        ),
      );

  return {
    getPullRequestJson: (target: AzureDevOpsServerRepository, operation: string, number: number) =>
      pullRequestRow(target, operation, number).pipe(Effect.flatMap((row) => json(operation, row))),

    listPullRequestsByBranch: (
      target: AzureDevOpsServerRepository,
      input: {
        readonly branch: string;
        readonly state: ServerPullRequestStatus;
        readonly limit: number;
      },
    ) =>
      listRows(target, "listPullRequests", target.repository, {
        "searchCriteria.sourceRefName": branchRef(input.branch),
        "searchCriteria.status": searchStatus(input.state),
        $top: input.limit,
      }),

    /** An author no identity matches has no pull requests: the answer is an empty page. */
    listPullRequestPage: Effect.fn("AzureDevOpsServerOperations.listPullRequestPage")(function* (
      target: AzureDevOpsServerRepository,
      input: {
        readonly repository: string;
        readonly state: PullRequestListState;
        readonly involvement: PullRequestInvolvement;
        readonly author?: string | undefined;
        readonly skip: number;
        readonly top: number;
      },
    ) {
      const viewer = input.involvement === "all" ? null : yield* api.viewer(target.collectionUrl);
      const creatorId =
        input.involvement === "authored"
          ? viewer?.id
          : input.author === undefined
            ? undefined
            : yield* api.identityId(target.collectionUrl, input.author);
      if (creatorId === null) return "[]";
      return yield* listRows(target, "listPullRequests", input.repository, {
        "searchCriteria.status": searchStatus(input.state),
        "searchCriteria.creatorId": creatorId,
        "searchCriteria.reviewerId": input.involvement === "reviewing" ? viewer?.id : undefined,
        $skip: input.skip === 0 ? undefined : input.skip,
        $top: input.top,
      });
    }),

    getViewerLogin: (target: AzureDevOpsServerRepository) =>
      api.viewer(target.collectionUrl).pipe(Effect.map((viewer) => viewer.login)),

    /** The routes `az devops invoke` names by area and resource. */
    invoke: (
      target: AzureDevOpsServerRepository,
      input: {
        readonly operation: string;
        readonly resource:
          | "pullRequestThreads"
          | "pullRequestIterations"
          | "pullRequestIterationChanges"
          | "items";
        readonly location: AzureDevOpsRepositoryLocation;
        readonly number?: number;
        readonly iterationId?: number;
        readonly query?: Readonly<Record<string, string>>;
        readonly maxBytes?: number;
      },
    ) => {
      const repository = repositoryPath(input.location.project, input.location.repository);
      const pullRequest = [...repository, "pullRequests", input.number ?? 0];
      const path =
        input.resource === "items"
          ? [...repository, "items"]
          : input.resource === "pullRequestThreads"
            ? [...pullRequest, "threads"]
            : input.resource === "pullRequestIterations"
              ? [...pullRequest, "iterations"]
              : [...pullRequest, "iterations", input.iterationId ?? 0, "changes"];
      return api.request({
        collectionUrl: target.collectionUrl,
        operation: input.operation,
        path,
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      });
    },

    /** The pull request it left, or the one it found when there was nothing to change. */
    runPullRequestAction: Effect.fn("AzureDevOpsServerOperations.runPullRequestAction")(function* (
      target: AzureDevOpsServerRepository,
      input: {
        readonly number: number;
        readonly action: PullRequestAction;
        readonly mergeMethod?: PullRequestMergeMethod;
      },
    ) {
      const { row, ref } = yield* pullRequestRef(target, "runPullRequestAction", input.number);
      const body = yield* actionBody(input.action, input.mergeMethod, ref, () =>
        api.viewer(target.collectionUrl).pipe(Effect.map((viewer) => viewer.id)),
      );
      if (body === null) return yield* json("runPullRequestAction", row);
      const updated = yield* api.request({
        collectionUrl: target.collectionUrl,
        operation: "runPullRequestAction",
        method: "PATCH",
        path: pullRequestPath(ref, input.number),
        body,
      });
      const decoded = yield* read("runPullRequestAction", updated, decodeRow);
      return yield* json(
        "runPullRequestAction",
        withRepositoryWebUrl(target.collectionUrl, decoded),
      );
    }),

    updatePullRequest: Effect.fn("AzureDevOpsServerOperations.updatePullRequest")(function* (
      target: AzureDevOpsServerRepository,
      input: {
        readonly number: number;
        readonly title?: string | undefined;
        readonly body?: string | undefined;
      },
    ) {
      const { ref } = yield* pullRequestRef(target, "updatePullRequest", input.number);
      yield* api.request({
        collectionUrl: target.collectionUrl,
        operation: "updatePullRequest",
        method: "PATCH",
        path: pullRequestPath(ref, input.number),
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { description: input.body }),
        },
      });
    }),

    /** False when a reviewer names no single identity, before anything is changed. */
    setPullRequestReviewers: Effect.fn("AzureDevOpsServerOperations.setPullRequestReviewers")(
      function* (
        target: AzureDevOpsServerRepository,
        input: {
          readonly number: number;
          readonly reviewers: ReadonlyArray<string>;
          readonly requested: boolean;
        },
      ) {
        const ids = yield* Effect.forEach(input.reviewers, (reviewer) =>
          api.identityId(target.collectionUrl, reviewer),
        );
        if (ids.some((id) => id === null)) return false;
        const { ref } = yield* pullRequestRef(target, "setPullRequestReviewers", input.number);
        yield* Effect.forEach(ids, (id) =>
          api.request({
            collectionUrl: target.collectionUrl,
            operation: "setPullRequestReviewers",
            method: input.requested ? "PUT" : "DELETE",
            path: [...pullRequestPath(ref, input.number), "reviewers", id ?? ""],
            ...(input.requested ? { body: { vote: 0 } } : {}),
          }),
        );
        return true;
      },
    ),

    getRepositoryJson: (
      target: AzureDevOpsServerRepository,
      operation: string,
      repository: { readonly project: string | null; readonly name: string },
    ) =>
      api.request({
        collectionUrl: target.collectionUrl,
        operation,
        path: repositoryPath(repository.project ?? target.project, repository.name),
      }),

    createPullRequest: Effect.fn("AzureDevOpsServerOperations.createPullRequest")(function* (
      target: AzureDevOpsServerRepository,
      input: {
        readonly sourceBranch: string;
        readonly targetBranch: string;
        readonly title: string;
        readonly bodyFile: string;
      },
    ) {
      const description = yield* fileSystem.readFileString(input.bodyFile).pipe(
        Effect.mapError(
          (cause) =>
            new AzureDevOpsServerError({
              operation: "createPullRequest",
              reason: "failed",
              cause,
            }),
        ),
      );
      yield* api.request({
        collectionUrl: target.collectionUrl,
        operation: "createPullRequest",
        method: "POST",
        path: [...repositoryPath(target.project, target.repository), "pullrequests"],
        body: {
          sourceRefName: branchRef(input.sourceBranch),
          targetRefName: branchRef(input.targetBranch),
          title: input.title,
          description,
        },
      });
    }),

    /** What `az repos pr checkout` does: the source branch, fetched and switched to. */
    checkoutPullRequest: Effect.fn("AzureDevOpsServerOperations.checkoutPullRequest")(function* (
      target: AzureDevOpsServerRepository,
      input: { readonly cwd: string; readonly number: number; readonly remoteName?: string },
    ) {
      const { ref } = yield* pullRequestRef(target, "checkoutPullRequest", input.number);
      const remoteName = input.remoteName ?? target.remoteName;
      const branch = normalizeRefName(ref.sourceRefName);
      yield* Effect.gen(function* () {
        const local = yield* git.listLocalBranchNames(input.cwd);
        if (local.includes(branch)) {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch: branch,
          });
        } else {
          yield* git.fetchRemoteBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch: branch,
            localBranch: branch,
          });
        }
        yield* git.setBranchUpstream({ cwd: input.cwd, branch, remoteName, remoteBranch: branch });
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: branch }));
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AzureDevOpsServerError({
              operation: "checkoutPullRequest",
              reason: "failed",
              serverMessage: `Checking out ${branch} from ${remoteName} failed.`,
              cause,
            }),
        ),
      );
    }),
  };
});
