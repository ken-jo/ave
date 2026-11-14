import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { withFileLock } from "../lib/with-file-lock.js";
import { parseConfigurationObject } from "../shared/configuration-document.js";
import { defaultLockfilePath, diffAgainstLockfile, disableHook, readLockfile, type DiscoveredHook } from "./hook-discovery.js";
import { HOOKS_CONFIG_FILENAME, discoverHookTrustFiles } from "./hook-config-trust.js";
import type { HookConfigEntry } from "./hook-config.js";
import { acceptHookTrust, disableHookTrust, hookDefinitionSummary, listHookTrustState, type HookTrustCommandOptions, type HookTrustCommandResult, type HookTrustRow } from "./hook-trust-commands.js";
import { buildHookRegistry } from "./hook-registry.js";
import type { ScriptHookManager } from "./script-hook-manager.js";
import type { HookRuntimePolicy, HookSourceKind } from "./hook-source-policy.js";
import { disabledHookOriginalName } from "./hook-disable-state.js";
import { createHookTrustValidator } from "./hook-trust-validator.js";

export interface HookSourceLocation {
  id: string;
  kind: Exclude<HookSourceKind, "managed">;
  hooksDir: string;
  disabledDir: string;
  projectRoot?: string;
}

interface SourceController {
  sources: Map<string, HookSourceLocation>;
  policy: HookRuntimePolicy;
  lockfilePath: string;
}

const controllers = new WeakMap<ScriptHookManager, SourceController>();

function optionsFor(source: HookSourceLocation, controller: SourceController): HookTrustCommandOptions {
  return { hooksDir: source.hooksDir, disabledDir: source.disabledDir, lockfilePath: controller.lockfilePath,
    ...(source.id === "user" ? {} : { sourceId: source.id }), hookSource: source.kind };
}

function projectLocation(root: string): HookSourceLocation | undefined {
  let canonical: string;
  try { canonical = realpathSync(root); } catch { return undefined; }
  const hooksDir = join(canonical, ".ave", "hooks");
  return { id: `project:${canonical}`, kind: "project", projectRoot: canonical, hooksDir, disabledDir: join(hooksDir, ".disabled") };
}

function isProjectTrusted(source: HookSourceLocation, controller: SourceController): boolean {
  return source.projectRoot !== undefined && (readLockfile(controller.lockfilePath)?.trustedProjects ?? []).includes(source.projectRoot);
}

function userHooksDisabled(source: HookSourceLocation | undefined): boolean {
  if (!source) return false;
  const active = join(source.hooksDir, HOOKS_CONFIG_FILENAME);
  try {
    const candidates = existsSync(active) ? [active] : readdirSync(source.disabledDir)
      .filter((name) => disabledHookOriginalName(name) === HOOKS_CONFIG_FILENAME)
      .map((name) => join(source.disabledDir, name)).sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    return candidates.length > 0 && parseConfigurationObject(readFileSync(candidates[0], "utf8")).disableAllHooks === true;
  } catch { return false; }
}

function trustedSource(source: HookSourceLocation, controller: SourceController): { shHooks: DiscoveredHook[]; configEntries: HookConfigEntry[]; signature: string } {
  if (source.kind === "project" && !isProjectTrusted(source, controller)) return { shHooks: [], configEntries: [], signature: "untrusted" };
  const discovered = discoverHookTrustFiles(source.hooksDir);
  const diff = diffAgainstLockfile(discovered.hooks, readLockfile(controller.lockfilePath), source.id === "user" ? undefined : source.id);
  for (const entry of diff) {
    if (entry.state !== "new" && entry.state !== "changed") continue;
    try { disableHook(entry.hook, source.disabledDir, "system-quarantine"); }
    catch { /* Refused moves stay skipped and visible for review. */ }
  }
  const trusted = diff.filter((entry) => entry.state === "trusted").map((entry) => entry.hook);
  const validator = (fileName: string, expectedSha256: string) => createHookTrustValidator({
    hooksDir: source.hooksDir, fileName, expectedSha256, lockfilePath: controller.lockfilePath,
    ...(source.id === "user" ? {} : { sourceId: source.id }),
    ...(source.projectRoot ? { projectRoot: source.projectRoot } : {}),
  });
  return { shHooks: trusted.filter((hook) => hook.fileName !== HOOKS_CONFIG_FILENAME)
    .map((hook) => ({ ...hook, hookSource: source.kind, sourceId: source.id, validateTrust: validator(hook.fileName, hook.sha256) })),
    configEntries: trusted.some((hook) => hook.fileName === HOOKS_CONFIG_FILENAME)
      ? discovered.config.entries.map((entry) => ({ ...entry, hookSource: source.kind,
        validateTrust: validator(HOOKS_CONFIG_FILENAME, discovered.config.trustHash ?? "") })) : [],
    signature: JSON.stringify(trusted.map((hook) => [hook.fileName, hook.sha256])),
  };
}

export function registerHookSourceController(manager: ScriptHookManager, policy: HookRuntimePolicy,
  sources: HookSourceLocation[], lockfilePath = defaultLockfilePath()): void {
  const controller: SourceController = { sources: new Map(sources.map((source) => [source.id, source])), policy, lockfilePath };
  controllers.set(manager, controller);
  const signatures = new Map<string, string>();
  manager.setSourceRegistryRefresher(() => {
    const disabled = userHooksDisabled(controller.sources.get("user"));
    for (const source of controller.sources.values()) {
      if (source.kind === "project") continue;
      const loaded = trustedSource(source, controller);
      if (signatures.get(source.id) === loaded.signature) continue;
      signatures.set(source.id, loaded.signature);
      manager.setTrustedSourceRegistry(source.id, loaded.shHooks, loaded.configEntries);
    }
    manager.setHookPolicy({ allowManagedHooksOnly: policy.allowManagedHooksOnly, disableAllHooks: disabled });
  });
  manager.setProjectHookResolver(async (cwd) => {
    let root = resolve(cwd);
    for (;;) {
      if (existsSync(join(root, ".ave", "hooks"))) {
        const source = projectLocation(root);
        if (!source) return [];
        controller.sources.set(source.id, source);
        const loaded = trustedSource(source, controller);
        return buildHookRegistry(loaded.shHooks, loaded.configEntries);
      }
      if (existsSync(join(root, ".git"))) return [];
      const parent = dirname(root);
      if (parent === root) return [];
      root = parent;
    }
  });
}

export function listRuntimeHookTrustState(manager: ScriptHookManager, projectRoot?: string): Extract<HookTrustCommandResult, { verb: "list" }> {
  const controller = controllers.get(manager);
  if (!controller) return listHookTrustState();
  if (projectRoot) {
    const source = projectLocation(projectRoot);
    if (source) controller.sources.set(source.id, source);
  }
  const active: HookTrustRow[] = [];
  const disabled: HookTrustRow[] = [];
  const currentProject = projectRoot ? projectLocation(projectRoot) : undefined;
  for (const source of controller.sources.values()) {
    if (source.kind === "project" && source.id !== currentProject?.id) continue;
    if (source.kind !== "user" && !existsSync(source.hooksDir) && !existsSync(source.disabledDir)) continue;
    const listed = listHookTrustState(optionsFor(source, controller));
    const decorate = (row: HookTrustRow): HookTrustRow => ({ ...row, sourceId: source.id, hookSource: source.kind,
      ...(row.state === "trusted" || row.state === "new" || row.state === "changed" ? { hashState: row.state } : {}),
      ...(source.kind === "project" ? { projectTrusted: isProjectTrusted(source, controller) } : {}) });
    active.push(...listed.active.map(decorate));
    disabled.push(...listed.disabled.map(decorate));
  }
  for (const entry of controller.policy.managedHooks) {
    active.push({ fileName: entry.id, hookType: entry.event === "post" || entry.event === "perm" ? entry.event : "pre",
      sha256: entry.reviewedHash ?? createHash("sha256").update(JSON.stringify(entry)).digest("hex"), state: "managed", hashState: "trusted",
      sourceId: "managed", hookSource: "managed", source: "config", entryCount: 1,
      entries: [{ id: entry.id, event: entry.event, ...(entry.matcher ? { matcher: entry.matcher } : {}), command: hookDefinitionSummary(entry) }] });
  }
  return { ok: true, verb: "list", active, disabled };
}

export async function reviewRuntimeHookTrust(manager: ScriptHookManager, request: {
  sourceId: string; fileName: string; expectedSha256: string; action: "accept" | "disable" | "trust-project";
}, currentProjectRoot?: string): Promise<HookTrustCommandResult> {
  const controller = controllers.get(manager);
  if (request.sourceId === "managed") return { ok: false, error: "managed-hook-policy" };
  if (!controller) {
    if (request.sourceId !== "user" || request.action === "trust-project") return { ok: false, error: "hook-review-failed" };
    const opts = { manager, expectedSha256: request.expectedSha256 };
    return request.action === "accept" ? acceptHookTrust(request.fileName, opts) : disableHookTrust(request.fileName, opts);
  }
  const source = controller.sources.get(request.sourceId);
  if (!source || controller.policy.allowManagedHooksOnly) return { ok: false, error: "managed-hook-policy" };
  if (source.kind === "project" && (!currentProjectRoot || projectLocation(currentProjectRoot)?.id !== source.id)) {
    return { ok: false, error: "hook-review-stale" };
  }
  const opts = optionsFor(source, controller);
  if (request.action === "trust-project") {
    if (source.kind !== "project" || !source.projectRoot) return { ok: false, error: "hook-review-failed" };
    const projectRoot = source.projectRoot;
    const listed = listHookTrustState(opts);
    const row = [...listed.active, ...listed.disabled].find((entry) => entry.fileName === request.fileName);
    if (!row || row.sha256 !== request.expectedSha256) return { ok: false, error: "hook-review-stale" };
    await withFileLock(controller.lockfilePath, async () => {
      const lockfile = readLockfile(controller.lockfilePath) ?? { schemaVersion: 1 as const, updatedAt: new Date().toISOString(), hooks: [] };
      lockfile.trustedProjects = [...new Set([...(lockfile.trustedProjects ?? []), projectRoot])];
      writeFileSync(controller.lockfilePath, JSON.stringify(lockfile, null, 2), { mode: 0o600 });
    });
    return listRuntimeHookTrustState(manager, currentProjectRoot);
  }
  if (source.kind === "project" && !isProjectTrusted(source, controller)) return { ok: false, error: "hook-project-untrusted" };
  const reviewOptions = { ...opts, expectedSha256: request.expectedSha256,
    ...(source.kind === "project" ? {} : { manager }) };
  return request.action === "accept" ? acceptHookTrust(request.fileName, reviewOptions) : disableHookTrust(request.fileName, reviewOptions);
}
