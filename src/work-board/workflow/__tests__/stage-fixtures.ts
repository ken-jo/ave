import { type BigIntStats, chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import type { TemplateGraph, TemplateStage, TemplateVersion, WorkItemStageRun } from "../../../shared/workflow-template-types.js";
import { graphHashOf } from "../../template-graph.js";

/** Writes one fixture file under `root`, making its folders. */
export function writeUnder(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const entryAt = (path: string): BigIntStats | undefined => lstatSync(path, { bigint: true, throwIfNoEntry: false });
const realDir = (stat: BigIntStats | undefined): stat is BigIntStats => stat?.isDirectory() === true && !stat.isSymbolicLink();
const sameDir = (stat: BigIntStats | undefined, held: BigIntStats): boolean => realDir(stat) && stat.ino !== 0n && stat.ino === held.ino && stat.dev === held.dev;

/** The folders a path names from its root down, each as the very text the path gives it up to there; the last is the path itself.
 * Refuses a path that can be read in more than one way: one that is not absolute, has a `.` or `..` part, an empty part (a doubled
 * or closing separator) or the other system's separator, and on Windows a part the system would take for another name. What is
 * checked of such a list is then what an action on the path reaches. */
function levels(path: string): string[] {
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep);
  const odd = (part: string): boolean => part === "" || part === "." || part === ".." || /[/\\]/u.test(part) || (sep === "\\" && /[. ]$|:/u.test(part));
  if (!isAbsolute(path) || !root.endsWith(sep) || root.includes(sep === "/" ? "\\" : "/") || parts.some(odd)) throw new Error(`a fixture's path can be read in more than one way: ${path}`);
  let at = root.slice(0, -1);
  return parts.map(part => (at = `${at}${sep}${part}`));
}

/** Refuses a path that is not below `base` through real folders alone: `base` is a folder the fixture made, spelled as it was made,
 * and the path names it by that very text; from it down to the path each folder is one itself and no link to one, each asked only
 * once the one above it was. Nothing above the base is asked, so no other spelling of it, a link to a folder above it included, is
 * taken. Returns the path, which is the text every one of those checks was made on. */
function below(base: string, path: string): string {
  const own = levels(base);
  if (!realDir(entryAt(base))) throw new Error(`a fixture's base is no real folder: ${base}`);
  const all = levels(path);
  if (all.length <= own.length || all[own.length - 1] !== base || !all.slice(own.length - 1, -1).every(level => realDir(entryAt(level)))) {
    throw new Error(`not below the fixture's base through real folders: ${path}`);
  }
  return path;
}

/** Removes a link to a directory as the link it is: what it points at stays. A removal that takes a path for a file or a folder can
 * refuse one. `base`: a folder of the fixture's own that the link lies below; anything else at the path, or a path that is reached
 * through another link, is refused. */
export function removeLink(path: string, base: string): void {
  const at = below(base, path);
  if (entryAt(at)?.isSymbolicLink() !== true) throw new Error(`not a link: ${at}`);
  unlinkSync(at);
}

/** Removes a fixture's folder with all it holds. A link in it goes as a link, and a file that cannot be written (git stores its objects
 * so) is made writable first: on Windows a recursive removal can stop at either. `base`: the fixture's own folder that `root` lies
 * below, when it is not `root` itself. A root that is no real folder, or is reached through a link, is refused, and so is a folder
 * that is another one by the time it has been listed. Whatever writes into the fixture has to have ended before. */
export function removeTree(root: string, base = root): void {
  const clear = (dir: string, held: BigIntStats): void => {
    const names = readdirSync(dir);
    if (!sameDir(entryAt(dir), held)) throw new Error(`a fixture's folder changed while it was removed: ${dir}`);
    for (const name of names) {
      const path = join(dir, name);
      const stat = entryAt(path);
      if (stat === undefined) continue;
      if (stat.isSymbolicLink()) unlinkSync(path);
      else if (stat.isDirectory()) clear(path, stat);
      else if ((stat.mode & 0o200n) === 0n) chmodSync(path, 0o666);
    }
  };
  const at = root === base ? levels(root).at(-1) as string : below(base, root);
  const held = entryAt(at);
  if (held === undefined) return;
  if (!realDir(held)) throw new Error(`not a real folder: ${at}`);
  clear(at, held);
  rmSync(at, { recursive: true, force: true, maxRetries: 3 });
}

/** Sets one field of a JSON file in place, making what is missing on the way to it: an array before a number, an object otherwise. */
export function setPath(file: string, path: readonly (string | number)[], value: unknown): void {
  const root = JSON.parse(readFileSync(file, "utf8")) as Record<string | number, unknown>;
  let at = root;
  path.slice(0, -1).forEach((key, index) => {
    at[key] ??= typeof path[index + 1] === "number" ? [] : {};
    at = at[key] as Record<string | number, unknown>;
  });
  at[path.at(-1) as string | number] = value;
  writeFileSync(file, JSON.stringify(root));
}

export function stageOf(id: string, over: Partial<TemplateStage> = {}): TemplateStage {
  return { id, name: `Stage ${id}`, goal: `Do ${id}`, inputs: [], toolScope: "read", allowSubAgents: false, gate: { type: "human" }, ...over };
}

/** A stage whose gate passes on its own once the stage ends well. */
export function autoStageOf(id: string, over: Partial<TemplateStage> = {}): TemplateStage {
  return stageOf(id, { gate: { type: "auto", pass: { kind: "stage_ok" } }, ...over });
}

export function graphOf(stages: TemplateStage[], setupCommands?: string[]): TemplateGraph {
  return { stages, edges: [], ...(setupCommands ? { setupCommands } : {}) };
}

export function versionOf(graph: TemplateGraph, version = 1, templateId = "tpl-1"): TemplateVersion {
  const graphHash = graphHashOf(graph);
  const confirmedAt = "2026-11-16T00:00:00.000Z";
  return { ...graph, templateId, version, graphHash, confirmedAt, confirmation: { templateId, version, graphHash, who: "alice", at: confirmedAt, origin: "local-desktop" } };
}

export function waitingRuns(graph: TemplateGraph): WorkItemStageRun[] {
  return graph.stages.map(stage => ({ stageId: stage.id, attempt: 1, status: "waiting" as const }));
}

/** A permission manager for a run's permission scope, on a rules file of its own that is never written. */
export function runScopePermissions(): PermissionManager {
  return new PermissionManager(join(tmpdir(), `ave-run-scope-${randomUUID()}`, "permissions.json"));
}
