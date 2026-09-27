/**
 * Copy for the git marketplace views (design §15). Every label is a literal
 * `t("…")` call so the used-keys gate proves it exists in the catalog.
 */
import type { TranslateFn as Translate } from "../../../../i18n/translate.js";
import type {
  GitMarketplaceErrorCode,
  InstallActionView,
  PackageKind,
  PackageStateView,
  SourceOriginKind,
  SourceStatusView,
  VersionExclusionView,
} from "../../../../shared/git-marketplace.js";

/** The kind tabs, in the order of design §15.1. */
export const KIND_ORDER: readonly PackageKind[] = ["agent-plugin", "plugin", "mcp", "skill", "agent", "theme", "font", "language", "provider", "messaging-connection"];

export function kindLabel(t: Translate, kind: PackageKind): string {
  switch (kind) {
    case "agent-plugin": return t("gitMarketplace.kind.agentPlugin");
    case "plugin": return t("gitMarketplace.kind.plugin");
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

export function sourceStatusLabel(t: Translate, status: SourceStatusView): string {
  switch (status.state) {
    case "up-to-date": return t("gitMarketplace.sources.status.upToDate");
    case "syncing": return t("gitMarketplace.sources.status.syncing");
    case "never-synced": return t("gitMarketplace.sources.status.neverSynced");
    case "unreachable": return status.cached ? t("gitMarketplace.sources.status.unreachableCached") : t("gitMarketplace.sources.status.unreachable");
    case "auth-required": return t("gitMarketplace.sources.status.authRequired");
    case "history-rewritten":
      return status.reviewable ? t("gitMarketplace.sources.status.rewrittenReview") : t("gitMarketplace.sources.status.rewrittenKept");
    case "broken": return t("gitMarketplace.sources.status.broken");
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

/** A failure the view shows: the code's sentence when it has one, else main's message. */
export function failureText(t: Translate, failure: { code: GitMarketplaceErrorCode; message: string }): string {
  switch (failure.code) {
    case "PLAN_EXPIRED": return t("gitMarketplace.error.planExpired");
    case "GIT_RUNTIME_MISSING": return t("gitMarketplace.error.gitMissing");
    case "GIT_RUNTIME_TOO_OLD": return t("gitMarketplace.error.gitTooOld");
    case "SOURCE_AUTH_REQUIRED": return t("gitMarketplace.error.authRequired", { message: failure.message });
    case "SOURCE_NOT_A_MARKETPLACE": return t("gitMarketplace.error.notAMarketplace", { message: failure.message });
    case "PACKAGE_ID_CONFLICT": return t("gitMarketplace.error.idConflict", { message: failure.message });
    case "PACKAGE_POLICY_BLOCKED": return t("gitMarketplace.error.policyBlocked", { message: failure.message });
    case "SOURCE_DISABLED": return t("gitMarketplace.error.sourceDisabled");
    case "process-entry-unsupported": return t("formatIpcError.processEntryUnsupported");
    case "unavailable": return t("gitMarketplace.error.unavailable", { message: failure.message });
    default: return `${failure.code} · ${failure.message}`;
  }
}

export function shortSha(commit: string): string {
  return commit.slice(0, 7);
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
