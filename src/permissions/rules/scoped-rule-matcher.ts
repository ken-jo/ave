import { dirname, isAbsolute, sep } from "node:path";
import { statSync } from "node:fs";
import { globMatch, containsGlobMetacharacter } from "../../lib/glob-matcher.js";
import { resolveShellFilesystemPath } from "../../shared/shell-filesystem-path.js";
import { resolveToolPathForPermission } from "../../shared/tool-path-resolution.js";
import { expandLeadingTilde } from "../../shared/home-tilde.js";
import { isPathWithin } from "../../plugins/plugin-storage-containment.js";
import { caseFoldForMatch, foldCanonicalPathSeparators, isAdmissionDeniedPath, protectedControlEntryFor } from "../sensitive-paths.js";
import { validateDirectoryAddition } from "../allowed-directories.js";
import type { PathEffect } from "../allowed-directories.js";
import type { PermissionFloorCode } from "../decision-pipeline.js";
import type { PermissionRule } from "../permission-manager.js";
import { storedRuleInvalidReason } from "./rule-files.js";
import { projectRootFor } from "./project-rule-files.js";
import { formatRuleSpecifier, isRuleSpecifier, matchesMcpTool, matchesWebFetchHost, parseRuleSpecifier, type RuleSpecifier } from "./rule-specifier.js";

export type ScopedRuleSubject =
  | { kind: "edit"; paths: readonly string[]; pathEffects?: readonly PathEffect[]; cwd: string; targets?: readonly { filePath: string; canonicalPath: string }[] }
  | { kind: "webfetch"; url: string; privateNetwork?: boolean; requiresSiteApproval?: boolean }
  | { kind: "mcp"; server: string; tool: string; nonDestructive: boolean };

export interface ScopedRuleEvaluation {
  decision?: PermissionRule["action"];
  pattern?: string;
  // Mandatory gate, independent of allow rules and mode.
  floor?: string;
  floorCode?: PermissionFloorCode;
  admissionDenial?: string;
}

function isWithinRoot(root: string, path: string): boolean {
  const base = caseFoldForMatch(foldCanonicalPathSeparators(root)).replace(/\//g, sep);
  const target = caseFoldForMatch(foldCanonicalPathSeparators(path)).replace(/\//g, sep);
  return isPathWithin(base, target);
}

function editPaths(subject: Extract<ScopedRuleSubject, { kind: "edit" }>, root: string) {
  if (subject.pathEffects && subject.pathEffects.length !== subject.paths.length) throw new Error("Edit path effects do not match sealed operands");
  return subject.paths.map((path, index) => {
    const lexical = foldCanonicalPathSeparators(resolveToolPathForPermission(path, subject.cwd));
    const frozen = subject.targets?.find((target) => caseFoldForMatch(foldCanonicalPathSeparators(target.filePath)) === caseFoldForMatch(lexical));
    if (subject.targets && !frozen) throw new Error("Edit target was not sealed by the host");
    const resolved = frozen?.canonicalPath ?? resolveShellFilesystemPath(expandLeadingTilde(path), subject.cwd);
    if (process.platform !== "win32" && (path.includes("\\") || subject.cwd.includes("\\") || resolved.includes("\\"))) {
      throw new Error("Write path cannot be represented by normalized rules");
    }
    const canonical = foldCanonicalPathSeparators(resolved);
    const effect = subject.pathEffects?.[index] ?? "write";
    if (effect !== "read" && effect !== "write") throw new Error("Edit target has no valid path effect");
    const control = effect === "write" ? protectedControlEntryFor(lexical) ?? protectedControlEntryFor(canonical) : undefined;
    const escaped = (isWithinRoot(root, lexical) || path.split(/[\\/]/).includes("..")) && !isWithinRoot(root, canonical);
    return { lexical, canonical, floor: escaped ? "Write path escapes the project" : control !== undefined ? `Protected control path: ${control}` : undefined,
      floorCode: escaped ? "project-escape" as const : control !== undefined ? "protected-path" as const : undefined };
  });
}

function matchesEditPattern(spec: Extract<RuleSpecifier, { kind: "edit" }>, pattern: string, path: string): boolean {
  const fullPattern = spec.recursive ? `${pattern.replace(/\/$/, "")}/**` : pattern;
  return (spec.recursive && caseFoldForMatch(path) === caseFoldForMatch(pattern)) || globMatch(path, fullPattern);
}

function editPattern(spec: Extract<RuleSpecifier, { kind: "edit" }>, root: string): string {
  return !isAbsolute(spec.path) && !/^[A-Za-z]:\//.test(spec.path) ? `${root}/${spec.path}` : spec.path;
}

function matchesEdit(spec: Extract<RuleSpecifier, { kind: "edit" }>, path: string, root: string, action: PermissionRule["action"]): boolean {
  const relative = !isAbsolute(spec.path) && !/^[A-Za-z]:\//.test(spec.path);
  // Relative patterns already start at root/ and require a root-contained canonical anchor below.
  if (relative && !isWithinRoot(root, path)) return false;
  const pattern = editPattern(spec, root);
  const wildcard = pattern.search(/[*?]/);
  const anchor = wildcard === -1 ? pattern : pattern.slice(0, pattern.lastIndexOf("/", wildcard)) || "/";
  const resolvedAnchor = resolveShellFilesystemPath(anchor, root);
  if (process.platform !== "win32" && resolvedAnchor.includes("\\")) throw new Error("Ambiguous rule path");
  const canonicalAnchor = foldCanonicalPathSeparators(resolvedAnchor);
  if ((relative || (action === "allow" && isWithinRoot(root, anchor))) && !isWithinRoot(root, canonicalAnchor)) return false;
  const canonicalPattern = canonicalAnchor + pattern.slice(anchor.length);
  return matchesEditPattern(spec, canonicalPattern, path);
}

// One precedence calculation across the existing global and project stores.
export function evaluateScopedRules(
  subject: ScopedRuleSubject,
  root: string,
  ...scopes: ReadonlyArray<readonly PermissionRule[]>
): ScopedRuleEvaluation {
  root = foldCanonicalPathSeparators(root);
  let paths: ReturnType<typeof editPaths> = [];
  let destination: URL | undefined;
  let floor: string | undefined;
  let grantable = true;
  let floorCode: PermissionFloorCode | undefined;
  if (subject.kind === "edit") {
    // Broken sealed-target contracts must fail before a human can approve them.
    paths = editPaths(subject, root);
    const protectedTarget = paths.find((path) => path.floor);
    floor = protectedTarget?.floor;
    floorCode = protectedTarget?.floorCode;
  } else if (subject.kind === "webfetch") {
    grantable = subject.requiresSiteApproval !== true;
    destination = new URL(subject.url);
    if (!["http:", "https:"].includes(destination.protocol)) {
      return { admissionDenial: "Network target must use HTTP or HTTPS" };
    }
    if (destination.username || destination.password) {
      floor = "Network target contains credentials";
      floorCode = "exfiltration";
    }
  } else {
    // Unannotated tools follow server rules and mode without scoped grants.
    grantable = subject.nonDestructive;
  }
  const rules = scopes.flat().filter((rule) => !rule.source && storedRuleInvalidReason(rule) === null && isRuleSpecifier(rule.pattern));
  const matches = (rule: PermissionRule, index = 0): boolean => {
    const spec = parseRuleSpecifier(rule.pattern);
    if (subject.kind === "edit" && spec.kind === "edit") {
      const target = paths[index];
      if (!target) return false;
      try {
        // Restrictions see both spellings; grants must cover the resolved target.
        return matchesEdit(spec, target.canonical, root, rule.action)
          || (rule.action !== "allow" && matchesEditPattern(spec, editPattern(spec, root), target.lexical));
      } catch { return rule.action !== "allow"; }
    }
    if (subject.kind === "webfetch" && spec.kind === "webfetch" && destination) {
      return matchesWebFetchHost(spec, destination.hostname, Number(destination.port || (destination.protocol === "https:" ? 443 : 80)));
    }
    return subject.kind === "mcp" && spec.kind === "mcp" && matchesMcpTool(spec, subject.server, subject.tool);
  };
  for (const action of ["deny", "ask"] as const) {
    const hit = rules.find((rule) => rule.action === action && (subject.kind === "edit" ? paths.some((_, i) => matches(rule, i)) : matches(rule)));
    if (hit) return { decision: action, pattern: hit.pattern, floor, floorCode };
  }
  if (floor) return { floor, floorCode };
  if (!grantable) return {};
  // A public host grant does not answer the separate private-network opt-in.
  if (subject.kind === "webfetch" && subject.privateNetwork) return {};
  const allowed = rules.filter((rule) => rule.action === "allow" && rule.tier !== "read");
  if (subject.kind === "edit") {
    if (paths.length === 0 || !paths.every((_, i) => allowed.some((rule) => matches(rule, i)))) return {};
  } else if (!allowed.some((rule) => matches(rule))) return {};
  return { decision: "allow", pattern: allowed.filter((rule) => subject.kind === "edit" ? paths.some((_, i) => matches(rule, i)) : matches(rule)).map((rule) => rule.pattern).join(", ") };
}

export interface EditDepthCandidate {
  depth: "file" | "parent" | "project";
  path: string;
  pattern: string;
}

// Host-resolved depth choices use ordinary Edit rules and the same store.
export function editDepthCandidates(path: string, cwd: string): EditDepthCandidate[] {
  let target: string;
  try {
    const paths = editPaths({ kind: "edit", paths: [path], cwd }, projectRootFor(cwd));
    if (paths[0]?.floor) return [];
    target = paths[0]!.canonical;
  } catch { return []; }
  if (containsGlobMetacharacter(target) || isAdmissionDeniedPath(caseFoldForMatch(target), "write")) return [];
  try { parseRuleSpecifier(formatRuleSpecifier({ kind: "edit", path: target, recursive: false })); }
  catch { return []; }
  let directory = false;
  try { directory = statSync(target).isDirectory(); } catch { /* A new target is a file candidate. */ }
  const parent = directory ? target : dirname(target);
  const project = projectRootFor(parent);
  const candidates: EditDepthCandidate[] = [];
  const add = (depth: EditDepthCandidate["depth"], candidate: string, recursive: boolean) => {
    candidate = foldCanonicalPathSeparators(candidate);
    if (recursive && !validateDirectoryAddition(candidate).ok) return;
    if (candidates.some((entry) => entry.path === candidate)) return;
    candidates.push({ depth, path: candidate, pattern: formatRuleSpecifier({ kind: "edit", path: candidate, recursive }) });
  };
  add("file", target, directory);
  add("parent", parent, true);
  add("project", project, true);
  return candidates;
}
