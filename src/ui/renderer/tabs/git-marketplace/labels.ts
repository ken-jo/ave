/**
 * Copy for the git marketplace views (design §15). Every label is a literal
 * `t("…")` call so the used-keys gate proves it exists in the catalog.
 */
import type { TranslateFn as Translate } from "../../../../i18n/translate.js";
import type { ClaudeDesktopImportFailure } from "../../../../mcp/claude-desktop-import.js";
import { packageVocabularyKind } from "../../../../shared/marketplace-package-sections.js";
import { hasRedaction, type CredentialIssuer, type ReservedPrefix } from "../../../../shared/dlp.js";
import {
  parseMarketplaceErrorDetail,
  type GitMarketplaceFailure,
  type MarketplaceErrorDetail,
  type InstallActionView,
  type PackageKind,
  type PackageStateView,
  type SourceBadge,
  type SourceOriginKind,
  type SourceStatusView,
  type EnteredTargetWarningView,
  type SourceWarning,
  type SourceView,
  type UpdatePackageState,
  type VersionExclusionView,
} from "../../../../shared/git-marketplace.js";

/** The kind tabs, in the order of design §15.1. */
export const KIND_ORDER: readonly PackageKind[] = ["agent-plugin", "plugin", "mcp", "skill", "agent", "theme", "font", "language", "provider", "messaging-connection"];

export function kindLabel(t: Translate, kind: PackageKind): string {
  switch (kind) {
    case "plugin":
    case "agent-plugin":
      return packageVocabularyKind(kind) === "extension"
        ? t("gitMarketplace.kind.plugin")
        : t("gitMarketplace.kind.agentPlugin");
    case "mcp": return t("gitMarketplace.kind.mcp");
    case "skill": return t("gitMarketplace.kind.skill");
    case "agent": return t("gitMarketplace.kind.agent");
    case "theme": return t("gitMarketplace.kind.theme");
    case "font": return t("gitMarketplace.kind.font");
    case "language": return t("gitMarketplace.kind.language");
    case "provider": return t("gitMarketplace.kind.provider");
    case "messaging-connection": return t("gitMarketplace.kind.messaging");
  }
}

/** Whose credential a reserved prefix looks like (§18.8), as a sentence names it. */
function credentialIssuerLabel(t: Translate, issuer: CredentialIssuer): string {
  switch (issuer) {
    case "github": return t("gitMarketplace.credentialIssuer.github");
    case "gitlab": return t("gitMarketplace.credentialIssuer.gitlab");
    case "npm": return t("gitMarketplace.credentialIssuer.npm");
    case "slack": return t("gitMarketplace.credentialIssuer.slack");
    case "aws": return t("gitMarketplace.credentialIssuer.aws");
    case "google": return t("gitMarketplace.credentialIssuer.google");
    case "openai": return t("gitMarketplace.credentialIssuer.openai");
    case "anthropic": return t("gitMarketplace.credentialIssuer.anthropic");
    case "stripe": return t("gitMarketplace.credentialIssuer.stripe");
    case "jwt": return t("gitMarketplace.credentialIssuer.jwt");
  }
  return unhandled(issuer);
}

/**
 * The sentence for a source id that uses a reserved prefix (§18.8): it names
 * the prefix and what it looks like, and asks for another id. Shown under the
 * Add dialog's id field as it is typed, and for `SOURCE_ID_INVALID`
 * `reserved-prefix`.
 */
export function reservedIdText(t: Translate, reserved: ReservedPrefix): string {
  return t("gitMarketplace.error.idInvalid.reservedPrefix", { prefix: reserved.prefix, issuer: credentialIssuerLabel(t, reserved.issuer) });
}

export function originLabel(t: Translate, origin: SourceOriginKind): string {
  switch (origin) {
    case "official": return t("gitMarketplace.origin.official");
    case "managed": return t("gitMarketplace.origin.managed");
    case "custom": return t("gitMarketplace.origin.custom");
    case "direct": return t("gitMarketplace.origin.direct");
  }
}

/** The state chip of a card (design §15.1). */
export function stateLabel(t: Translate, state: PackageStateView): string {
  switch (state.state) {
    case "install": return t("gitMarketplace.state.install");
    case "installed": return t("gitMarketplace.state.installed");
    case "update": return t("gitMarketplace.state.update", { version: state.to });
    case "requires-app": return t("gitMarketplace.state.requiresApp", { version: state.minAppVersion });
    case "yanked": return t("gitMarketplace.state.yanked");
    case "revoked": return t("gitMarketplace.state.revoked");
    case "unavailable": return t("gitMarketplace.state.unavailable");
    case "installed-elsewhere":
      return state.sourceId === null ? t("gitMarketplace.state.installedWithoutSource") : t("gitMarketplace.state.installedFrom", { source: state.sourceId });
    case "source-removed": return t("gitMarketplace.state.sourceRemoved");
    case "unbound": return t("gitMarketplace.state.unbound");
  }
}

/** An update's state (design §18.7.5), as the Updates card shows it. */
export function updateStateLabel(t: Translate, state: UpdatePackageState): string {
  switch (state) {
    case "automatic": return t("gitMarketplace.updates.state.automatic");
    case "waiting": return t("gitMarketplace.updates.state.waiting");
    case "needs-review": return t("gitMarketplace.updates.state.needsReview");
    case "manual": return t("gitMarketplace.updates.state.manual");
    case "failed": return t("gitMarketplace.updates.state.failed");
    case "applied": return t("gitMarketplace.updates.state.applied");
    case "applied-not-running": return t("gitMarketplace.updates.state.appliedNotRunning");
    case "approval-pending": return t("gitMarketplace.updates.state.approvalPending");
  }
}

export function sourceStatusLabel(t: Translate, status: SourceStatusView): string {
  switch (status.state) {
    case "up-to-date": return t("gitMarketplace.sources.status.upToDate");
    case "syncing": return t("gitMarketplace.sources.status.syncing");
    case "never-synced": return t("gitMarketplace.sources.status.neverSynced");
    case "unreachable": {
      // Every failed sync but sign-in and rewritten history lands here; the chip names what failed, not always the network.
      const label = failedSyncLabel(t, status.code, status.detail);
      return status.cached ? t("gitMarketplace.sources.status.withCached", { status: label }) : label;
    }
    case "auth-required": return t("gitMarketplace.sources.status.authRequired");
    case "history-rewritten":
      return status.reviewable ? t("gitMarketplace.sources.status.rewrittenReview") : t("gitMarketplace.sources.status.rewrittenKept");
    case "broken": return t("gitMarketplace.sources.status.broken");
    case "id-holds-credential": return t("gitMarketplace.sources.status.idHoldsCredential");
  }
}

/**
 * The status chip of a source whose last sync failed with `code` (§15.4):
 * "Unreachable" only when the host was not reached, otherwise what went
 * wrong, and "Update failed" for a code no sync is expected to record.
 */
function failedSyncLabel(t: Translate, code: Extract<SourceStatusView, { state: "unreachable" }>["code"], detail: MarketplaceErrorDetail | undefined): string {
  switch (code) {
    case "SOURCE_UNREACHABLE": {
      const reason = parseMarketplaceErrorDetail(code, detail)?.reason;
      // The host answered: it reports no repository at the address.
      if (reason === "not-found" || reason === "not-found-ssh") return t("gitMarketplace.sources.status.repositoryNotFound");
      return t("gitMarketplace.sources.status.unreachable");
    }
    case "SOURCE_NOT_A_MARKETPLACE": return t("gitMarketplace.sources.status.notAMarketplace");
    case "SOURCE_REF_NOT_FOUND": return t("gitMarketplace.sources.status.refNotFound");
    case "SOURCE_INDEX_INVALID":
    case "CONTENT_RULE_VIOLATION":
      return t("gitMarketplace.sources.status.indexInvalid");
    case "SOURCE_SSH_HOST_UNKNOWN": return t("gitMarketplace.sources.status.hostKeyUnverified");
    case "SOURCE_AUTH_REQUIRED": return t("gitMarketplace.sources.status.authRequired");
    case "SOURCE_POLICY_BLOCKED": return t("gitMarketplace.sources.status.policyBlocked");
    case "SOURCE_CONFIRMATION_REQUIRED": return t("gitMarketplace.sources.status.confirmationRequired");
    case "SOURCE_URL_REJECTED": return t("gitMarketplace.sources.status.addressRefused");
    case "SOURCE_LOCAL_DATA_DAMAGED": return t("gitMarketplace.sources.status.broken");
    case "SOURCE_LOCAL_UNREADABLE": {
      const reason = parseMarketplaceErrorDetail(code, detail)?.reason;
      if (reason === "not-found") return t("gitMarketplace.sources.status.folderNotFound");
      if (reason === "moved") return t("gitMarketplace.sources.status.folderMoved");
      return t("gitMarketplace.sources.status.folderUnreadable");
    }
    case "GIT_RUNTIME_MISSING":
    case "GIT_RUNTIME_TOO_OLD":
    case "GIT_RUNTIME_INSTALL_FAILED":
      return t("gitMarketplace.sources.status.gitUnavailable");
    case "SOURCE_NAME_RESERVED":
    case "SOURCE_ID_INVALID":
    case "SOURCE_ID_TAKEN":
    case "SOURCE_HISTORY_REWRITTEN":
    case "SOURCE_DISABLED":
    case "SOURCE_LIST_UNREADABLE":
    case "PLAN_EXPIRED":
    case "PACKAGE_INCOMPATIBLE":
    case "PACKAGE_COMPAT_UNDECLARED":
    case "PACKAGE_YANKED":
    case "PACKAGE_REVOKED":
    case "PACKAGE_ID_CONFLICT":
    case "PACKAGE_REQUIRED_BY_POLICY":
    case "PACKAGE_POLICY_BLOCKED":
    case "ARTIFACT_NOT_PINNED":
    case "ARTIFACT_DIGEST_MISMATCH":
    case "MANIFEST_MISMATCH":
    case "process-entry-unconfined":
    case "process-entry-requires-pinned-artifact":
    case "NO_INSTALLABLE_ARTIFACT":
      return t("gitMarketplace.sources.status.updateFailed");
  }
  return unhandled(code);
}

/** Why a source's last sync failed, for its row under the status (§18.8), naming only what that row offers; null when it did not. */
export function sourceStatusDetail(t: Translate, source: SourceView): string | null {
  const status = source.status;
  const subject = sourceSubject(source);
  switch (status.state) {
    case "unreachable": return failureText(t, { code: status.code, message: "", ...(status.detail ? { detail: status.detail } : {}) }, subject);
    case "auth-required": return failureText(t, { code: "SOURCE_AUTH_REQUIRED", message: "", ...(status.detail ? { detail: status.detail } : {}) }, subject);
    // The sentence names the Repair the row offers.
    case "broken": return failureText(t, { code: "SOURCE_LOCAL_DATA_DAMAGED", message: "", ...(status.detail ? { detail: status.detail } : {}) }, subject);
    // The sentence names the Remove the row offers.
    case "id-holds-credential": return failureText(t, { code: "SOURCE_ID_INVALID", message: "", detail: { reason: "stored-id-holds-credential" } }, subject);
    case "up-to-date":
    case "syncing":
    case "never-synced":
    case "history-rewritten":
      return null;
  }
}

export function exclusionLabel(t: Translate, reason: VersionExclusionView): string {
  switch (reason) {
    case "min_app_version": return t("gitMarketplace.version.needsApp");
    case "host_protocol": return t("gitMarketplace.version.hostProtocol");
    case "yanked": return t("gitMarketplace.version.yanked");
    case "platform": return t("gitMarketplace.version.platform");
    case "prerelease": return t("gitMarketplace.version.prerelease");
    case "rollout": return t("gitMarketplace.version.rollout");
    case "revoked": return t("gitMarketplace.version.revoked");
  }
}

export function actionLabel(t: Translate, action: InstallActionView): string {
  switch (action.action) {
    case "install": return t("gitMarketplace.action.install");
    case "switch": return t("gitMarketplace.action.switch");
    case "replace":
      switch (action.direction) {
        case "upgrade": return t("gitMarketplace.action.upgrade");
        case "reinstall": return t("gitMarketplace.action.reinstall");
        case "downgrade": return t("gitMarketplace.action.downgrade");
        case "repair": return t("gitMarketplace.action.repair");
      }
  }
}

/** What became of one server of a pasted MCP configuration that was not refused. */
export function importActionLabel(t: Translate, action: "added" | "skipped-conflict" | "overwritten"): string {
  switch (action) {
    case "added": return t("gitMarketplace.direct.importAction.added");
    case "skipped-conflict": return t("gitMarketplace.direct.importAction.skippedConflict");
    case "overwritten": return t("gitMarketplace.direct.importAction.overwritten");
  }
}

/** Why server `id` of a pasted MCP configuration was not added, and what to do; main's reason stays behind *Copy details*. */
export function importFailureText(t: Translate, id: string, failure: ClaudeDesktopImportFailure): string {
  switch (failure) {
    case "permission-denied": return t("gitMarketplace.direct.importFailure.permissionDenied", { id });
    case "not-found": return t("gitMarketplace.direct.importFailure.notFound", { id });
    case "unreadable": return t("gitMarketplace.direct.importFailure.unreadable", { id });
    case "other": return t("gitMarketplace.direct.importFailure.other", { id });
  }
}

/** A platform as `PACKAGE_INCOMPATIBLE` names it (`process.platform`), in the words people use. */
function platformName(platform: string): string {
  switch (platform) {
    case "darwin": return "macOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    default: return platform;
  }
}

/** The name ssh files a host key under: the bare host on port 22, else `[host]:port`. */
function knownHostName(host: string, port: number): string {
  const bare = host.replace(/^\[(.*)\]$/u, "$1");
  return port === 22 ? bare : `[${bare}]:${port}`;
}

/**
 * The command a failure asks the user to run, for *Copy command*; null when
 * it asks for none, or when main masked part of the host (it held a token's
 * shape), since a command naming a masked host would not run (§18.8).
 */
export function failureCommand(failure: GitMarketplaceFailure): string | null {
  if (failure.code !== "SOURCE_SSH_HOST_UNKNOWN") return null;
  const detail = parseMarketplaceErrorDetail(failure.code, failure.detail);
  return detail && !hasRedaction(detail.host) ? hostKeyCommand(detail) : null;
}

function hostKeyCommand(detail: MarketplaceErrorDetail<"SOURCE_SSH_HOST_UNKNOWN">): string {
  const bare = detail.host.replace(/^\[(.*)\]$/u, "$1");
  return detail.reason === "unknown"
    ? `ssh-keyscan -p ${detail.port} ${bare} >> ~/.ssh/known_hosts`
    : `ssh-keygen -R "${knownHostName(detail.host, detail.port)}"`;
}

/**
 * What a failure is about, so its sentence offers only actions the user has
 * there (§18.8):
 *   - `entry`: the address, branch, folder and sign-in the user is typing
 *     (Add marketplace, Install from Git URL), every one of them editable;
 *   - `source`: a listed source, with what its row in Sources offers: Set
 *     token… for a token source, Remove source for one the user added, and
 *     nothing that changes an official or organization source's address;
 *   - `other`: no single source (the catalog, git itself, Refresh all).
 */
export type FailureSubject =
  | { kind: "entry" }
  | { kind: "source"; source: Pick<SourceView, "origin" | "label" | "auth" | "tokenStored"> }
  | { kind: "other" };

export const ENTRY_SUBJECT: FailureSubject = { kind: "entry" };
export const OTHER_SUBJECT: FailureSubject = { kind: "other" };

export function sourceSubject(source: Pick<SourceView, "origin" | "label" | "auth" | "tokenStored">): FailureSubject {
  return { kind: "source", source: { origin: source.origin, label: source.label, auth: source.auth, tokenStored: source.tokenStored } };
}

/**
 * A source as the user sees it named: the official source by its origin's
 * name (as its row shows it), any other by its label; the id when the
 * failure is about no listed source.
 */
function sourceName(t: Translate, subject: FailureSubject, sourceId: string): string {
  if (subject.kind !== "source") return sourceId;
  return subject.source.origin === "official" ? originLabel(t, "official") : subject.source.label;
}

/**
 * Who can change what a source failure is about: the user typing the address
 * (`entry`), the user who added the source (`custom`, direct sources too), the
 * organization (`managed`), or nobody here (`owned`: the official source,
 * whose address is built into Ave, and a failure tied to no one source).
 */
type Audience = "entry" | "custom" | "managed" | "owned";

function audienceOf(subject: FailureSubject): Audience {
  if (subject.kind === "entry") return "entry";
  if (subject.kind === "other") return "owned";
  switch (subject.source.origin) {
    case "custom":
    case "direct":
      return "custom";
    case "managed": return "managed";
    case "official": return "owned";
  }
  return unhandled(subject.source.origin);
}

/**
 * The sign-in step a source failure can offer: the form's Access token
 * (`entry`), the row's Set token… to add (`set-token`) or replace
 * (`replace-token`) a token, Remove source and add it again with a token
 * (`readd`, a source the user added without one), the administrator
 * (`administrator`, an organization source set up without one), none
 * (`owned`, the official source read without a token), or the row in
 * Sources (`other`, when no one source is known).
 */
type SignIn = "entry" | "set-token" | "replace-token" | "readd" | "administrator" | "owned" | "other";

function signInOf(subject: FailureSubject): SignIn {
  if (subject.kind === "entry") return "entry";
  if (subject.kind === "other") return "other";
  const { origin, auth, tokenStored } = subject.source;
  if (auth === "token") return tokenStored ? "replace-token" : "set-token";
  switch (origin) {
    case "custom":
    case "direct":
      return "readd";
    case "managed": return "administrator";
    case "official": return "owned";
  }
  return unhandled(origin);
}

/**
 * The sentence for a failure (design §18.8): what happened and what to do,
 * from its code and, when it carries one, the detail's reason. Every code has
 * a reason-less sentence for a failure without a detail (an older state file,
 * or a detail that was dropped). A source failure's sentence also depends on
 * `subject`: it never asks the user to check a field they cannot change,
 * and names the sign-in step the row actually offers. Main's English
 * `message` never shows here, `unavailable`'s included; it is behind *Copy
 * details* (`MarketplaceProblem`), scrubbed.
 */
export function failureText(t: Translate, failure: GitMarketplaceFailure, subject: FailureSubject): string {
  const code = failure.code;
  const audience = audienceOf(subject);
  switch (code) {
    case "GIT_RUNTIME_MISSING": return t("gitMarketplace.error.gitMissing");
    case "GIT_RUNTIME_TOO_OLD": return t("gitMarketplace.error.gitTooOld");
    case "GIT_RUNTIME_INSTALL_FAILED": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.gitInstallFailed");
      switch (detail.reason) {
        case "checking": return t("gitMarketplace.error.gitInstallFailed.checking");
        case "downloading": return t("gitMarketplace.error.gitInstallFailed.downloading");
        case "verifying": return t("gitMarketplace.error.gitInstallFailed.verifying");
        case "extracting": return t("gitMarketplace.error.gitInstallFailed.extracting");
        case "smoke-testing": return t("gitMarketplace.error.gitInstallFailed.smokeTesting");
        case "installing": return t("gitMarketplace.error.gitInstallFailed.installing");
      }
      return unhandled(detail);
    }
    case "SOURCE_URL_REJECTED": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) {
        // Without a reason it can be the network gate refusing a listed source's address.
        switch (audience) {
          case "entry":
          case "custom":
            return t("gitMarketplace.error.urlRejected");
          case "managed": return t("gitMarketplace.error.urlRejected.managed");
          case "owned": return t("gitMarketplace.error.urlRejected.owned");
        }
        return unhandled(audience);
      }
      // The normalizer's reasons: only an address being typed has them, since a stored one that fails is not served.
      switch (detail.reason) {
        case "credentials-in-url": return t("gitMarketplace.error.urlRejected.credentialsInUrl");
        case "helper-transport": return t("gitMarketplace.error.urlRejected.helperTransport", { scheme: detail.scheme });
        case "scheme-unsupported": return t("gitMarketplace.error.urlRejected.schemeUnsupported", { scheme: detail.scheme });
        case "format": return t("gitMarketplace.error.urlRejected.format");
        case "deep-link-path": return t("gitMarketplace.error.urlRejected.deepLinkPath");
        // The address a connection would use: only who can change the address is told to check it.
        case "address-metadata":
          return audience === "entry" || audience === "custom"
            ? t("gitMarketplace.error.urlRejected.addressMetadata", { host: detail.host, address: detail.address })
            : t("gitMarketplace.error.urlRejected.addressMetadata.network", { host: detail.host, address: detail.address });
        case "address-unroutable":
          return audience === "entry" || audience === "custom"
            ? t("gitMarketplace.error.urlRejected.addressUnroutable", { host: detail.host, address: detail.address })
            : t("gitMarketplace.error.urlRejected.addressUnroutable.network", { host: detail.host, address: detail.address });
        case "catalog-this-computer":
          return t("gitMarketplace.error.urlRejected.catalogThisComputer", { source: sourceName(t, subject, detail.source), host: detail.host });
        // The folder forms Ave cannot read (§18.3, §18.4.1 stage 1): each says what to enter instead.
        case "relative-path": return t("gitMarketplace.error.urlRejected.relativePath");
        case "device-path": return t("gitMarketplace.error.urlRejected.devicePath");
        case "windows-path": return t("gitMarketplace.error.urlRejected.windowsPath");
        case "network-file-url": return t("gitMarketplace.error.urlRejected.networkFileUrl");
        case "unc-without-share": return t("gitMarketplace.error.urlRejected.uncWithoutShare");
        case "unc-credentials": return t("gitMarketplace.error.urlRejected.uncCredentials");
        case "outside-root": return t("gitMarketplace.error.urlRejected.outsideRoot");
        case "folder-options": return t("gitMarketplace.error.urlRejected.folderOptions");
      }
      return unhandled(detail);
    }
    case "SOURCE_POLICY_BLOCKED": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.policy.blocked");
      switch (detail.reason) {
        case "blocked-by-pattern": return t("gitMarketplace.policy.blockedByPattern", { target: detail.target, pattern: detail.pattern, policyPath: detail.policyPath });
        case "not-in-allow-list": return t("gitMarketplace.policy.notInAllowList", { target: detail.target, policyPath: detail.policyPath });
        case "https-required": return t("gitMarketplace.policy.httpsRequired", { target: detail.target, policyPath: detail.policyPath });
        case "private-network-blocked":
          return t("gitMarketplace.policy.privateNetworkBlocked", { target: detail.target, address: detail.address, policyPath: detail.policyPath });
        case "local-sources-blocked": return t("gitMarketplace.policy.localSourcesBlocked", { target: detail.target, policyPath: detail.policyPath });
        case "direct-install-blocked": return t("gitMarketplace.policy.directInstallBlocked", { target: detail.target, policyPath: detail.policyPath });
        case "policy-invalid": return t("gitMarketplace.policy.policyInvalid", { error: detail.error });
      }
      return unhandled(detail);
    }
    case "SOURCE_CONFIRMATION_REQUIRED": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.confirmationRequired");
      switch (detail.reason) {
        case "unencrypted":
        case "token-unencrypted":
        case "internal-network":
        case "this-computer":
          return warningText(t, { warning: detail.reason, host: detail.host, address: "address" in detail ? detail.address : null });
        case "internal-downloads":
          return t("gitMarketplace.warning.internalDownloads", { source: sourceName(t, subject, detail.source), host: detail.host });
        case "network-folder":
          return warningText(t, { warning: "network-folder", host: detail.server === "" ? null : detail.server, address: detail.path });
      }
      return unhandled(detail);
    }
    case "SOURCE_NAME_RESERVED": return t("gitMarketplace.error.nameReserved");
    case "SOURCE_ID_INVALID": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.idInvalid");
      switch (detail.reason) {
        case "reserved-prefix": return reservedIdText(t, detail);
        case "holds-credential": return t("gitMarketplace.error.idInvalid.holdsCredential");
        case "stored-id-holds-credential": return t("gitMarketplace.error.idInvalid.storedIdHoldsCredential");
      }
      return unhandled(detail);
    }
    case "SOURCE_ID_TAKEN": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.idTaken");
      switch (detail.reason) {
        case "repository-already-added": return t("gitMarketplace.error.idTaken.repositoryAlreadyAdded", { url: detail.url, id: detail.existingId });
        case "folder-already-added": return t("gitMarketplace.error.idTaken.folderAlreadyAdded", { path: detail.path, id: detail.existingId });
        case "folder-inside-source":
          return t("gitMarketplace.error.idTaken.folderInsideSource", { path: detail.path, id: detail.existingId, existingPath: detail.existingPath });
        case "folder-contains-source":
          return t("gitMarketplace.error.idTaken.folderContainsSource", { path: detail.path, id: detail.existingId, existingPath: detail.existingPath });
      }
      return unhandled(detail);
    }
    case "SOURCE_AUTH_REQUIRED": return authRequiredText(t, parseMarketplaceErrorDetail(code, failure.detail), subject);
    case "SOURCE_SSH_HOST_UNKNOWN": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.sshHostUnknown");
      if (hasRedaction(detail.host)) {
        switch (detail.reason) {
          case "unknown": return t("gitMarketplace.error.sshHostUnknown.unknown.masked", { host: detail.host });
          case "changed": return t("gitMarketplace.error.sshHostUnknown.changed.masked", { host: detail.host });
        }
        return unhandled(detail);
      }
      const command = hostKeyCommand(detail);
      switch (detail.reason) {
        case "unknown": return t("gitMarketplace.error.sshHostUnknown.unknown", { host: detail.host, command });
        case "changed": return t("gitMarketplace.error.sshHostUnknown.changed", { host: detail.host, command });
      }
      return unhandled(detail);
    }
    case "SOURCE_REF_NOT_FOUND": return refNotFoundText(t, parseMarketplaceErrorDetail(code, failure.detail), audience);
    case "SOURCE_UNREACHABLE": return unreachableText(t, parseMarketplaceErrorDetail(code, failure.detail), subject);
    case "SOURCE_NOT_A_MARKETPLACE":
      switch (audience) {
        case "entry": return t("gitMarketplace.error.notAMarketplace");
        case "custom": return t("gitMarketplace.error.notAMarketplace.custom");
        case "managed": return t("gitMarketplace.error.notAMarketplace.managed");
        case "owned": return t("gitMarketplace.error.notAMarketplace.owned");
      }
      return unhandled(audience);
    case "SOURCE_INDEX_INVALID": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.indexInvalid");
      // An identifier the renderer could only see masked (§18.8): the package is not offered.
      switch (detail.reason) {
        case "name-reserved-prefix": return t("gitMarketplace.error.indexInvalid.nameReservedPrefix", { prefix: detail.prefix, issuer: credentialIssuerLabel(t, detail.issuer) });
        case "version-reserved-prefix": return t("gitMarketplace.error.indexInvalid.versionReservedPrefix", { prefix: detail.prefix, issuer: credentialIssuerLabel(t, detail.issuer) });
        case "component-reserved-prefix": return t("gitMarketplace.error.indexInvalid.componentReservedPrefix", { prefix: detail.prefix, issuer: credentialIssuerLabel(t, detail.issuer) });
        case "name-holds-credential": return t("gitMarketplace.error.indexInvalid.nameHoldsCredential");
        case "version-holds-credential": return t("gitMarketplace.error.indexInvalid.versionHoldsCredential");
        case "component-holds-credential": return t("gitMarketplace.error.indexInvalid.componentHoldsCredential");
      }
      return unhandled(detail);
    }
    case "SOURCE_HISTORY_REWRITTEN": return t("gitMarketplace.error.historyRewritten");
    case "SOURCE_DISABLED": return t("gitMarketplace.error.sourceDisabled");
    case "SOURCE_LOCAL_DATA_DAMAGED": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.localDataDamaged");
      const source = sourceName(t, subject, detail.sourceId);
      switch (detail.reason) {
        // The pin is lost: Repair trusts what the source serves then, and the sentence says so (a warning, not a refusal).
        case "state-missing": return t("gitMarketplace.error.localDataDamaged.stateMissing", { source });
        case "state-invalid": return t("gitMarketplace.error.localDataDamaged.stateInvalid", { source });
        case "state-unreadable": return t("gitMarketplace.error.localDataDamaged.stateUnreadable", { source });
        // The pin is kept.
        case "snapshot-invalid": return t("gitMarketplace.error.localDataDamaged.snapshotInvalid", { source });
        case "snapshot-unreadable": return t("gitMarketplace.error.localDataDamaged.snapshotUnreadable", { source });
        case "repository-damaged": return t("gitMarketplace.error.localDataDamaged.repositoryDamaged", { source });
        case "repair-failed": return t("gitMarketplace.error.localDataDamaged.repairFailed", { source });
        case "repair-failed-unpinned": return t("gitMarketplace.error.localDataDamaged.repairFailedUnpinned", { source });
        case "repair-write-failed": return t("gitMarketplace.error.localDataDamaged.repairWriteFailed", { source });
      }
      return unhandled(detail);
    }
    case "SOURCE_LOCAL_UNREADABLE": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.localUnreadable");
      switch (detail.reason) {
        // Only who added the folder can remove it and add another; an organization's folder is the administrator's.
        case "not-found":
          switch (audience) {
            case "entry": return t("gitMarketplace.error.localUnreadable.notFound.entry", { path: detail.path });
            case "custom": return t("gitMarketplace.error.localUnreadable.notFound", { path: detail.path });
            case "managed":
            case "owned":
              return t("gitMarketplace.error.localUnreadable.notFound.managed", { path: detail.path });
          }
          return unhandled(audience);
        case "permission": return t("gitMarketplace.error.localUnreadable.permission", { path: detail.path, message: detail.message });
        case "io": return t("gitMarketplace.error.localUnreadable.io", { path: detail.path, message: detail.message });
        case "moved":
          // The same path, another directory (its identity changed): "now leads to itself" would say nothing.
          if (detail.target === detail.path) {
            return audience === "entry" || audience === "custom"
              ? t("gitMarketplace.error.localUnreadable.replaced", { path: detail.path })
              : t("gitMarketplace.error.localUnreadable.replaced.managed", { path: detail.path });
          }
          return audience === "entry" || audience === "custom"
            ? t("gitMarketplace.error.localUnreadable.moved", { path: detail.path, target: detail.target })
            : t("gitMarketplace.error.localUnreadable.moved.managed", { path: detail.path, target: detail.target });
        case "not-a-directory": return t("gitMarketplace.error.localUnreadable.notADirectory", { path: detail.path });
        case "ambiguous-case": return t("gitMarketplace.error.localUnreadable.ambiguousCase", { path: detail.path });
        case "changed-during-read": return t("gitMarketplace.error.localUnreadable.changedDuringRead", { path: detail.path });
        case "classifier-unavailable": return t("gitMarketplace.error.localUnreadable.classifierUnavailable", { path: detail.path });
      }
      return unhandled(detail);
    }
    case "SOURCE_LIST_UNREADABLE": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.listUnreadable");
      switch (detail.reason) {
        case "unreadable": return t("gitMarketplace.error.listUnreadable.unreadable", { fsCode: detail.fsCode });
        case "invalid": return t("gitMarketplace.error.listUnreadable.invalid");
      }
      return unhandled(detail);
    }
    case "PLAN_EXPIRED": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.planExpired");
      switch (detail.reason) {
        case "policy-changed": return t("gitMarketplace.error.planExpired.policyChanged");
      }
      return unhandled(detail.reason);
    }
    case "PACKAGE_INCOMPATIBLE": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.incompatible");
      switch (detail.reason) {
        case "min_app_version": return t("gitMarketplace.error.incompatible.minAppVersion", { name: detail.name, version: detail.version });
        case "platform": return t("gitMarketplace.error.incompatible.platform", { name: detail.name, platform: platformName(detail.platform) });
        case "host_protocol": return t("gitMarketplace.error.incompatible.hostProtocol", { name: detail.name });
      }
      return unhandled(detail);
    }
    case "PACKAGE_COMPAT_UNDECLARED": return t("gitMarketplace.error.compatUndeclared");
    case "PACKAGE_YANKED": return t("gitMarketplace.error.yanked");
    case "PACKAGE_REVOKED": return t("gitMarketplace.error.revoked");
    case "PACKAGE_ID_CONFLICT": return t("gitMarketplace.error.idConflict");
    case "PACKAGE_REQUIRED_BY_POLICY": return t("gitMarketplace.error.requiredByPolicy");
    case "PACKAGE_POLICY_BLOCKED": return t("gitMarketplace.error.policyBlocked");
    case "ARTIFACT_NOT_PINNED": return t("gitMarketplace.error.artifactNotPinned");
    case "ARTIFACT_DIGEST_MISMATCH": return t("gitMarketplace.error.digestMismatch");
    case "MANIFEST_MISMATCH": return t("gitMarketplace.error.manifestMismatch");
    case "process-entry-unconfined": return t("formatIpcError.processEntryUnconfined");
    case "process-entry-requires-pinned-artifact": return t("formatIpcError.processEntryRequiresPinnedArtifact");
    case "NO_INSTALLABLE_ARTIFACT": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.noArtifact");
      switch (detail.reason) {
        case "folder-has-no-build": return t("gitMarketplace.error.noArtifact.folderHasNoBuild", { name: detail.name });
      }
      return unhandled(detail.reason);
    }
    case "CONTENT_RULE_VIOLATION": {
      const detail = parseMarketplaceErrorDetail(code, failure.detail);
      if (!detail) return t("gitMarketplace.error.contentRule");
      switch (detail.reason) {
        case "link-outside-folder": return t("gitMarketplace.error.contentRule.linkOutsideFolder", { path: detail.path, target: detail.target });
        case "link-to-network": return t("gitMarketplace.error.contentRule.linkToNetwork", { path: detail.path, target: detail.target });
        case "link-to-skipped": return t("gitMarketplace.error.contentRule.linkToSkipped", { path: detail.path, target: detail.target });
        case "special-file": return t("gitMarketplace.error.contentRule.specialFile", { path: detail.path });
        case "case-collision": return t("gitMarketplace.error.contentRule.caseCollision", { path: detail.path });
        case "limit": return t("gitMarketplace.error.contentRule.limit", { path: detail.path, limit: detail.limit });
      }
      return unhandled(detail);
    }
    case "invalid-request": return t("gitMarketplace.error.invalidRequest");
    case "unauthorized-frame": return t("gitMarketplace.error.unauthorizedFrame");
    case "unavailable": return t("gitMarketplace.error.unavailable");
  }
  return unhandled(code);
}

function refNotFoundText(t: Translate, detail: MarketplaceErrorDetail<"SOURCE_REF_NOT_FOUND"> | undefined, audience: Audience): string {
  if (!detail) {
    switch (audience) {
      case "entry": return t("gitMarketplace.error.refNotFound");
      case "custom": return t("gitMarketplace.error.refNotFound.custom");
      case "managed": return t("gitMarketplace.error.refNotFound.managed");
      case "owned": return t("gitMarketplace.error.refNotFound.owned");
    }
    return unhandled(audience);
  }
  switch (detail.reason) {
    case "missing": {
      const vars = { ref: detail.ref, repository: detail.repository, available: detail.available.length > 0 ? detail.available.join(", ") : "—" };
      switch (audience) {
        case "entry": return t("gitMarketplace.error.refNotFound.missing", vars);
        case "custom": return t("gitMarketplace.error.refNotFound.missing.custom", vars);
        case "managed": return t("gitMarketplace.error.refNotFound.missing.managed", vars);
        case "owned": return t("gitMarketplace.error.refNotFound.missing.owned", vars);
      }
      return unhandled(audience);
    }
  }
  return unhandled(detail.reason);
}

function unreachableText(t: Translate, detail: MarketplaceErrorDetail<"SOURCE_UNREACHABLE"> | undefined, subject: FailureSubject): string {
  const audience = audienceOf(subject);
  if (!detail) {
    switch (audience) {
      case "entry":
      case "custom":
        return t("gitMarketplace.error.unreachable");
      case "managed": return t("gitMarketplace.error.unreachable.managed");
      case "owned": return t("gitMarketplace.error.unreachable.owned");
    }
    return unhandled(audience);
  }
  switch (detail.reason) {
    case "offline": return t("gitMarketplace.error.unreachable.offline");
    case "dns":
      switch (audience) {
        case "entry":
        case "custom":
          return t("gitMarketplace.error.unreachable.dns", { host: detail.host });
        case "managed": return t("gitMarketplace.error.unreachable.dns.managed", { host: detail.host });
        case "owned": return t("gitMarketplace.error.unreachable.dns.owned", { host: detail.host });
      }
      return unhandled(audience);
    case "refused":
      switch (audience) {
        case "entry":
        case "custom":
          return t("gitMarketplace.error.unreachable.refused", { host: detail.host });
        case "managed": return t("gitMarketplace.error.unreachable.refused.managed", { host: detail.host });
        case "owned": return t("gitMarketplace.error.unreachable.refused.owned", { host: detail.host });
      }
      return unhandled(audience);
    case "timeout": return t("gitMarketplace.error.unreachable.timeout", { host: detail.host });
    case "http-status":
      switch (audience) {
        case "entry":
        case "custom":
          return t("gitMarketplace.error.unreachable.httpStatus", { host: detail.host, status: detail.status });
        case "managed": return t("gitMarketplace.error.unreachable.httpStatus.managed", { host: detail.host, status: detail.status });
        case "owned": return t("gitMarketplace.error.unreachable.httpStatus.owned", { host: detail.host, status: detail.status });
      }
      return unhandled(audience);
    case "tls": return t("gitMarketplace.error.unreachable.tls", { host: detail.host });
    case "proxy": return t("gitMarketplace.error.unreachable.proxy", { host: detail.host, proxy: detail.proxy });
    case "not-found": return notFoundText(t, detail.host, subject);
    case "not-found-ssh":
      // The remedy is the user's own key whoever owns the source; only the address advice differs.
      switch (audience) {
        case "entry": return t("gitMarketplace.error.unreachable.notFoundSsh", { host: detail.host });
        case "custom": return t("gitMarketplace.error.unreachable.notFoundSsh.custom", { host: detail.host });
        case "managed": return t("gitMarketplace.error.unreachable.notFoundSsh.managed", { host: detail.host });
        case "owned": return t("gitMarketplace.error.unreachable.notFoundSsh.owned", { host: detail.host });
      }
      return unhandled(audience);
  }
  return unhandled(detail);
}

/**
 * A host's "no repository here" without Ave's token: a wrong address and a
 * private repository look the same, so the sentence names both and never
 * claims either. With a token stored for the source it reads as that token
 * lacking access, the same as `SOURCE_AUTH_REQUIRED` `token-no-access`.
 */
function notFoundText(t: Translate, host: string, subject: FailureSubject): string {
  const signIn = signInOf(subject);
  const audience = audienceOf(subject);
  switch (signIn) {
    case "entry": return t("gitMarketplace.error.unreachable.notFound", { host });
    case "set-token":
      switch (audience) {
        case "custom": return t("gitMarketplace.error.unreachable.notFound.setToken.custom", { host });
        case "managed": return t("gitMarketplace.error.unreachable.notFound.setToken.managed", { host });
        case "entry":
        case "owned":
          return t("gitMarketplace.error.unreachable.notFound.setToken", { host });
      }
      return unhandled(audience);
    case "replace-token":
      return audience === "custom"
        ? t("gitMarketplace.error.authRequired.tokenNoAccess.custom", { host })
        : t("gitMarketplace.error.authRequired.tokenNoAccess", { host });
    case "readd": return t("gitMarketplace.error.unreachable.notFound.readd", { host });
    case "administrator": return t("gitMarketplace.error.unreachable.notFound.managed", { host });
    case "owned": return t("gitMarketplace.error.unreachable.notFound.owned", { host });
    case "other": return t("gitMarketplace.error.unreachable.notFound.other", { host });
  }
  return unhandled(signIn);
}

function authRequiredText(t: Translate, detail: MarketplaceErrorDetail<"SOURCE_AUTH_REQUIRED"> | undefined, subject: FailureSubject): string {
  const signIn = signInOf(subject);
  if (!detail) {
    // A download's refusal carries no host (§14), so the sentence names none.
    switch (signIn) {
      case "entry": return t("gitMarketplace.error.authRequired.entry");
      case "set-token": return t("gitMarketplace.error.authRequired");
      case "replace-token": return t("gitMarketplace.error.authRequired.rejected");
      case "readd": return t("gitMarketplace.error.authRequired.readd");
      case "administrator": return t("gitMarketplace.error.authRequired.managed");
      case "owned": return t("gitMarketplace.error.authRequired.owned");
      case "other": return t("gitMarketplace.error.authRequired.other");
    }
    return unhandled(signIn);
  }
  const host = detail.host;
  switch (detail.reason) {
    case "token":
      switch (signIn) {
        case "entry": return t("gitMarketplace.error.authRequired.token.entry", { host });
        case "set-token": return t("gitMarketplace.error.authRequired.token", { host });
        case "replace-token": return t("gitMarketplace.error.authRequired.token.rejected", { host });
        case "readd": return t("gitMarketplace.error.authRequired.token.readd", { host });
        case "administrator": return t("gitMarketplace.error.authRequired.token.managed", { host });
        case "owned": return t("gitMarketplace.error.authRequired.token.owned", { host });
        case "other": return t("gitMarketplace.error.authRequired.token.other", { host });
      }
      return unhandled(signIn);
    case "token-no-access": {
      // Only a token Ave offered gets this answer, so the source signs in with one.
      const audience = audienceOf(subject);
      switch (audience) {
        case "entry": return t("gitMarketplace.error.authRequired.tokenNoAccess.entry", { host });
        case "custom": return t("gitMarketplace.error.authRequired.tokenNoAccess.custom", { host });
        case "managed":
        case "owned":
          return t("gitMarketplace.error.authRequired.tokenNoAccess", { host });
      }
      return unhandled(audience);
    }
    case "token-unencrypted":
      // Ave withheld every credential: the confirmation comes first, then the token where the row offers one.
      switch (signIn) {
        case "entry": return t("gitMarketplace.error.authRequired.tokenUnencrypted.entry", { host });
        case "set-token":
        case "replace-token":
          return t("gitMarketplace.error.authRequired.tokenUnencrypted.setToken", { host });
        case "readd":
        case "administrator":
        case "owned":
        case "other":
          return t("gitMarketplace.error.authRequired.tokenUnencrypted", { host });
      }
      return unhandled(signIn);
    case "ssh": return t("gitMarketplace.error.authRequired.ssh", { host });
  }
  return unhandled(detail);
}

/** An address in 198.18.0.0/15, the benchmarking range some proxy tools answer every name with. */
function inProxyRange(address: string | null): boolean {
  return address !== null && /^198\.1[89]\./u.test(address);
}

/**
 * The risk of a warning about a source's own address (§18.5, §18.8): what
 * happens and when to continue. The Add dialog lists these before any
 * connection; a sync or install that hits one names it with *Allow…*.
 */
export function warningText(t: Translate, view: EnteredTargetWarningView): string {
  const host = view.host ?? "";
  const address = view.address ?? "";
  switch (view.warning) {
    case "unencrypted": return t("gitMarketplace.warning.unencrypted", { host });
    case "token-unencrypted": return t("gitMarketplace.warning.tokenUnencrypted", { host });
    case "internal-network":
      return inProxyRange(view.address)
        ? t("gitMarketplace.warning.internalNetwork.proxyRange", { host, address })
        : t("gitMarketplace.warning.internalNetwork", { host, address });
    case "this-computer": return t("gitMarketplace.warning.thisComputer", { host, address });
    case "network-folder": return networkFolderText(t, view.host, address);
  }
  return unhandled(view.warning);
}

/**
 * `network-folder` (§18.4.6): a Windows share or mapped drive is read
 * signed in as the user, to the server the path or the drive's mapping names
 * (or an unnamed server when the mapping names none); an automount path on
 * macOS or Linux is read from the server it names.
 */
function networkFolderText(t: Translate, server: string | null, path: string): string {
  const windows = path.startsWith("\\") || /^[A-Za-z]:/u.test(path);
  if (!windows) return t("gitMarketplace.warning.networkFolder.automount", { server: server ?? "", path });
  return server === null || server === ""
    ? t("gitMarketplace.warning.networkFolder.unknownServer", { path })
    : t("gitMarketplace.warning.networkFolder", { server, path });
}

/** A source badge's text (§18.5). */
export function badgeLabel(t: Translate, badge: SourceBadge): string {
  switch (badge) {
    case "unencrypted": return t("gitMarketplace.badge.unencrypted");
    case "internal-network": return t("gitMarketplace.badge.internalNetwork");
    case "this-computer": return t("gitMarketplace.badge.thisComputer");
    case "internal-downloads": return t("gitMarketplace.badge.internalDownloads");
    case "local-folder": return t("gitMarketplace.badge.localFolder");
    case "network-folder": return t("gitMarketplace.badge.networkFolder");
    case "network-folder-unconfirmed": return t("gitMarketplace.badge.networkFolderUnconfirmed");
    case "folder-unclassified": return t("gitMarketplace.badge.folderUnclassified");
  }
  return unhandled(badge);
}

/** A source badge's tooltip: what it means for the user. */
export function badgeTooltip(t: Translate, badge: SourceBadge): string {
  switch (badge) {
    case "unencrypted": return t("gitMarketplace.badge.unencrypted.tooltip");
    case "internal-network": return t("gitMarketplace.badge.internalNetwork.tooltip");
    case "this-computer": return t("gitMarketplace.badge.thisComputer.tooltip");
    case "internal-downloads": return t("gitMarketplace.badge.internalDownloads.tooltip");
    case "local-folder": return t("gitMarketplace.badge.localFolder.tooltip");
    case "network-folder": return t("gitMarketplace.badge.networkFolder.tooltip");
    case "network-folder-unconfirmed": return t("gitMarketplace.badge.networkFolderUnconfirmed.tooltip");
    case "folder-unclassified": return t("gitMarketplace.badge.folderUnclassified.tooltip");
  }
  return unhandled(badge);
}

/**
 * The confirmation a failure asks for, when *Allow…* resolves it (§18.5): a
 * target that needs a warning the source does not hold, or sign-in over
 * http. Null for every other failure.
 */
export function allowableWarning(failure: Pick<GitMarketplaceFailure, "code" | "detail">): SourceWarning | null {
  if (failure.code === "SOURCE_CONFIRMATION_REQUIRED") return parseMarketplaceErrorDetail(failure.code, failure.detail)?.reason ?? null;
  if (failure.code === "SOURCE_AUTH_REQUIRED" && parseMarketplaceErrorDetail(failure.code, failure.detail)?.reason === "token-unencrypted") return "token-unencrypted";
  return null;
}

/**
 * The risk *Allow…* accepts, when the failure's own sentence does not say it.
 * A confirmation failure's sentence is already the warning's question; a
 * sign-in held back over http only says what to do, so its consent asks the
 * full `token-unencrypted` warning, as Set token… does (§18.2.2).
 */
export function allowRisk(t: Translate, failure: Pick<GitMarketplaceFailure, "code" | "detail">): string | null {
  if (failure.code !== "SOURCE_AUTH_REQUIRED") return null;
  const detail = parseMarketplaceErrorDetail(failure.code, failure.detail);
  return detail?.reason === "token-unencrypted" ? warningText(t, { warning: "token-unencrypted", host: detail.host, address: null }) : null;
}

/** Exhaustiveness, after each switch: a code or reason added without a sentence fails to compile here. */
function unhandled(value: never): never {
  throw new Error(`no sentence for ${JSON.stringify(value)}`);
}

/**
 * Whether the typed address is a folder rather than a git address, by the
 * same first characters main's lexical parse reads (§18.4.1 stage 1): `/`,
 * `~`, `\\`, `//`, a drive, a `file:` URL, or a relative `./` or `../` (which
 * main refuses with its reason). The Add dialog then asks no branch, package
 * folder or sign-in, which a folder does not take. Main decides; this only
 * shapes the form.
 */
export function looksLikeFolder(input: string): boolean {
  return /^(?:[/~\\]|\.{1,2}[/\\]|[A-Za-z]:|file:)/iu.test(input.trim());
}

/**
 * The source an add was refused for duplicating (§18.8: SOURCE_ID_TAKEN
 * `repository-already-added`, or a folder that is, lies inside or contains a
 * folder source), whose row *Show <id>* opens; null for any other failure, a
 * taken id included.
 */
export function duplicatedSourceId(failure: GitMarketplaceFailure): string | null {
  if (failure.code !== "SOURCE_ID_TAKEN") return null;
  return parseMarketplaceErrorDetail(failure.code, failure.detail)?.existingId ?? null;
}

/** The file manager *Reveal* opens on this computer, by the platform the renderer runs on. */
export function revealLabel(t: Translate, userAgent: string = globalThis.navigator?.userAgent ?? ""): string {
  if (/Macintosh|Mac OS X|darwin/iu.test(userAgent)) return t("gitMarketplace.sources.revealFinder");
  if (/Windows|win32/iu.test(userAgent)) return t("gitMarketplace.sources.revealExplorer");
  return t("gitMarketplace.sources.revealFileManager");
}

/**
 * A long path cut in the middle, keeping its start (the volume or share) and
 * its end (the folder's own name): `/Users/example/…/team/market`. The full path
 * belongs in the tooltip beside it.
 */
export function middleTruncate(text: string, max: number = 48): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const tail = Math.ceil((max - 1) * 0.6);
  const head = max - 1 - tail;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** The first seven hex digits of a commit, or of a folder's revision without its `local-` prefix (§18.4.3). */
export function shortSha(commit: string): string {
  return commit.replace(/^local-/u, "").slice(0, 7);
}

/** `62 MB`, `1.1 MB`, `640 KB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "4 min ago" in the current locale. */
export function relativeTime(iso: string, locale: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}
