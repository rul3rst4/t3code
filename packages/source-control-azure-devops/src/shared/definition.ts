import {
  makeProviderSettingsSchema,
  SettingsSecretValue,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  isChangeRequestAuthorityOfProject,
  parseChangeRequestPath,
  parseCommitPath,
  remoteWebOrigin,
} from "@t3tools/source-control-core/shared/definition";
import { icon } from "./icon.ts";

// Azure DevOps Server runs on any hostname; its `_git` route identifies it.
const CHANGE_REQUEST_PATH = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/((?:[^/]+\/)*_git\/[^/]+)\/commit\/([0-9a-f]+)\/?$/iu;
const CHECKOUT_COMMAND = /^az\s+repos\s+pr\s+checkout\s+(.+)$/i;
const REMOTE_GIT_ROUTE = /\/_git\/[^/]+\/?$/u;

/** Azure DevOps Services, which `az` reads; any other `_git` host is an Azure DevOps Server. */
export function isAzureDevOpsServicesHost(hostname: string): boolean {
  return (
    hostname === "dev.azure.com" ||
    hostname.endsWith(".dev.azure.com") ||
    hostname.endsWith(".visualstudio.com")
  );
}

/**
 * Azure alone addresses one repository under two names that share no part: `ssh.dev.azure.com` and
 * `v3/{org}/{project}/{repo}` over SSH, against `dev.azure.com` and `{org}/{project}/_git/{repo}`
 * everywhere a person sees it. A project cloned over SSH would otherwise be a different repository
 * to every comparison made against a pull request URL, which arrives in the web spelling.
 */
function repositoryKeyFromRemote(key: string): string | null {
  const match =
    /^(ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(key);
  if (match === null) return null;
  const [, host, organization, project, repository] = match;
  return host === "ssh.dev.azure.com"
    ? `dev.azure.com/${organization}/${project}/_git/${repository}`
    : `${organization}.visualstudio.com/${project}/_git/${repository}`;
}

/** Every spelling of an Azure DevOps Services repository, on `dev.azure.com`. */
function canonicalRepositoryKey(key: string): string | null {
  const canonical = key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
  return canonical.startsWith("dev.azure.com/") ? canonical : null;
}

/**
 * `host/organization` for `host/organization/project/_git/repository`, and the server's collection
 * path for an Azure DevOps Server. Null for the short `collection/_git/repository` form. Under a
 * virtual directory that form still reads as one, so the provider checks the fetched repository.
 */
function organizationOfKey(key: string): string | null {
  const parts = key.split("/");
  const route = parts.indexOf("_git");
  return route < 3 ? null : parts.slice(0, route - 1).join("/");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function decodeUrlPathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function checkoutCommandId(args: string): string | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === "--id" || part === "-i") return parts[index + 1] ?? null;
    if (part.startsWith("--id=")) return part.slice("--id=".length) || null;
  }
  return parts.find((part) => !part.startsWith("-")) ?? null;
}

const KIND = SourceControlProviderKind.make("azure-devops");

export const settings = makeProviderSettingsSchema(
  {
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Azure DevOps Server URL",
        description:
          "A self-hosted Azure DevOps Server (TFS). The token is sent to this server only. Azure DevOps Services uses Azure CLI instead.",
        providerSettingsForm: { placeholder: "https://tfs.example.com" },
      }),
    ),
    serverToken: SettingsSecretValue.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Personal access token",
        description: "Created on that server, with Code read & write.",
        providerSettingsForm: { control: "password" },
      }),
    ),
  },
  { order: ["serverUrl", "serverToken"] },
);
export type AzureDevOpsSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "Azure DevOps",
  pickerLabel: "Azure DevOps",
  icon,
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "project/repository",
  // `az repos` reads need the checkout's organization and project, so a bare hostname names no
  // repository this client can act on.
  publicHost: null,
  publishDescription: "dev.azure.com",
  publishHost: () => "dev.azure.com",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) => {
    if (webUrl) return changeRequestUrlBelow(webUrl, `pullrequest/${number}`);
    const key = `${host}/${repository}`.toLowerCase();
    const [canonicalHost = host, ...path] = (canonicalRepositoryKey(key) ?? key).split("/");
    return `${remoteWebOrigin(canonicalHost, remoteUrl)}/${path.join("/")}/pullrequest/${number}`;
  },
  commitUrl: (input) => {
    const key = `${input.host}/${input.repository}`.toLowerCase();
    const [host = input.host, ...path] = (canonicalRepositoryKey(key) ?? key).split("/");
    return buildCommitUrl({ ...input, host, repository: path.join("/") }, "commit");
  },
  parseCommitUrl: (url) => parseCommitPath(url, COMMIT_PATH),
  // Servers on different ports are different servers, so a port stays in the link.
  parseChangeRequestUrl: (url) => {
    const link = parseChangeRequestPath(url, CHANGE_REQUEST_PATH);
    return link === null || url.port === "" ? link : { ...link, authority: url.host.toLowerCase() };
  },
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "enable-auto-merge",
    "disable-auto-merge",
  ] as const),
  checkoutCommand: ({ number, headBranch, repositoryUrl, host }) => {
    const url = repositoryUrl ? URL.parse(repositoryUrl) : null;
    const hostname = url?.hostname ?? host?.replace(/:\d+$/u, "").toLowerCase();
    if (!hostname || isAzureDevOpsServicesHost(hostname)) {
      return `az repos pr checkout --id ${number}`;
    }
    // `az` refuses an Azure DevOps Server, so its checkout is plain git.
    return url && headBranch
      ? `git fetch ${shellQuote(url.href)} ${shellQuote(`refs/heads/${headBranch}`)} && git checkout -B pr/${number} FETCH_HEAD`
      : null;
  },
  // Completing or abandoning is a status change, the same `update` this package runs.
  changeRequestCloseCommand:
    /\baz\s+repos\s+pr\s+update\b[^;&|]*--status[\s=]+["']?(?:completed|abandoned)\b/u,
  authorProfileUrl: () => null,
  repositoryLabel: (path) => {
    const parts = path.split("/").filter((part) => part.length > 0);
    const route = parts.indexOf("_git");
    const project = parts[route - 1];
    const repository = parts[route + 1];
    return route < 1 || project === undefined || repository === undefined
      ? null
      : `${decodeUrlPathSegment(project)}/${decodeUrlPathSegment(repository)}`;
  },
  hardLineBreaks: true,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => {
    const args = CHECKOUT_COMMAND.exec(input)?.[1];
    return args ? checkoutCommandId(args) : null;
  },
  isChangeRequestReference: (url) => {
    const parsed = URL.parse(url);
    // A default Azure DevOps Server install serves plain http.
    const webLink =
      parsed?.protocol === "https:" ||
      (parsed?.protocol === "http:" && !isAzureDevOpsServicesHost(parsed.hostname));
    return webLink && parseChangeRequestPath(parsed, CHANGE_REQUEST_PATH) !== null;
  },
  checkoutChangeRequestHost: () => null,
  // `ssh.dev.azure.com` is the default SSH clone host (git@ssh.dev.azure.com:v3/org/project/repo),
  // so any `*.dev.azure.com` subdomain is Azure. Legacy hosts stay under `.visualstudio.com`,
  // including `vs-ssh.visualstudio.com`. A server on any other hostname is known by its `_git` route.
  recognizeRemote: ({ remoteUrl, host, hostname }) => {
    if (isAzureDevOpsServicesHost(hostname)) {
      return { kind: KIND, name: "Azure DevOps", baseUrl: `https://${host}` };
    }
    const url = URL.parse(remoteUrl);
    if (!REMOTE_GIT_ROUTE.test(url?.pathname ?? remoteUrl)) return null;
    return {
      kind: KIND,
      name: "Azure DevOps Server",
      baseUrl:
        url?.protocol === "http:" || url?.protocol === "https:" ? url.origin : `https://${host}`,
    };
  },
  /**
   * `az repos pr list --repository` takes a name; organisation and project come from checkout.
   * Decode the remote URL's name segment: `az` treats escapes literally and returns 404.
   */
  repositorySelector: (identity) => {
    const segments = (identity.displayName ?? "").split("/").filter((part) => part !== "_git");
    const name = identity.name || segments.at(-1);
    return name ? decodeUrlPathSegment(name) : null;
  },
  repositoryKeyFromRemote,
  canonicalRepositoryKey,
  isChangeRequestInRepository: (identity, link) => {
    if (!isChangeRequestAuthorityOfProject(identity, link)) return false;
    const projectKey = identity.canonicalKey.toLowerCase();
    const linkKey = `${link.host}/${link.repository}`.toLowerCase();
    return (
      (canonicalRepositoryKey(projectKey) ?? projectKey) ===
      (canonicalRepositoryKey(linkKey) ?? linkKey)
    );
  },
  // Pull request numbers are unique across an organization or collection, which any of its
  // checkouts can read; another organization on the same host is another account's.
  canReadChangeRequestOnHost: (identity, link) => {
    if (!isChangeRequestAuthorityOfProject(identity, link)) return false;
    const projectKey = identity.canonicalKey.toLowerCase();
    const linkKey = `${link.host}/${link.repository}`.toLowerCase();
    const organization = organizationOfKey(canonicalRepositoryKey(projectKey) ?? projectKey);
    return (
      organization !== null &&
      organization === organizationOfKey(canonicalRepositoryKey(linkKey) ?? linkKey)
    );
  },
  settings,
});
