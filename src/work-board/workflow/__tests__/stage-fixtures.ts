import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TemplateGraph, TemplateStage, TemplateVersion, WorkItemStageRun } from "../../../shared/workflow-template-types.js";
import { graphHashOf } from "../../template-graph.js";

/** Writes one fixture file under `root`, making its folders. */
export function writeUnder(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Removes a link to a directory as the link it is: what it points at stays. A removal that takes a path for a file or a folder can refuse one. */
export function removeLink(path: string): void {
  unlinkSync(path);
}

/** Removes a fixture's folder with all it holds. A link in it goes as a link, and a file that cannot be written (git stores its objects
 * so) is made writable first: on Windows a recursive removal can stop at either. */
export function removeTree(root: string): void {
  const clear = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) removeLink(path);
      else if (stat.isDirectory()) clear(path);
      else if ((stat.mode & 0o200) === 0) chmodSync(path, 0o666);
    }
  };
  if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory() === true) clear(root);
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
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
