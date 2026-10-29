import { AsyncLocalStorage } from "node:async_hooks";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { TerminalBlockSummary } from "../../shared/terminal-blocks.js";
import type { TerminalFileReviewSnapshot, TerminalExecutionWarning, TerminalReviewFile } from "../../shared/terminal-file-review.js";
import type { TurnReviewFile } from "../../shared/turn-change-review.js";
import { countFileChangeLines } from "../../shared/file-change-counts.js";
import { countTurnReviewLines, createTurnReviewHunks } from "../../memory/turn-review-diff.js";
import { tokenizeShell } from "../../shared/shell-tokenizer.js";
import { resolvePhysicalFilesystemPath } from "../../shared/shell-filesystem-path.js";

const MAX_INFERENCE_BYTES = 1_048_576;
const MAX_INFERENCE_STEPS = 128;
/**
 * The invocation forms that provably run their operand. A runner matches only when every option before the operand
 * is listed for it, and an option that takes a value gets one this validates. Anything else (a version or help flag,
 * a syntax check, a preload, an option that changes what runs, an invalid value, an option not listed) is uncertain:
 * no annotation. Warnings are best-effort, so precision wins over recall; the list is deliberately short.
 */
interface OptionRule { readonly flag: RegExp; readonly value?: (value: string) => boolean }
/** `set -o` names under which a shell still runs its operand. */
const SHELL_SET_OPTIONS = new Set(["errexit", "nounset", "pipefail", "xtrace"]);
/** Python warning filter actions; none changes whether the operand runs. */
const PYTHON_WARNING_ACTIONS = new Set(["ignore", "default", "error", "always", "once", "module"]);
const SHELL_RULES: readonly OptionRule[] = [
  { flag: /^-[eux]+$/ }, { flag: /^--no(?:rc|profile)$/ }, { flag: /^-o$/, value: (name) => SHELL_SET_OPTIONS.has(name) },
];
const PYTHON_RULES: readonly OptionRule[] = [{ flag: /^-[uB]+$/ }, { flag: /^-W$/, value: (action) => PYTHON_WARNING_ACTIONS.has(action) }];
const INTERPRETER_RULES: Readonly<Record<string, readonly OptionRule[]>> = {
  ".": [], source: [], sh: SHELL_RULES, bash: SHELL_RULES, zsh: SHELL_RULES,
  node: [{ flag: /^--(?:no-warnings|no-deprecation|enable-source-maps)$/ }],
  python: PYTHON_RULES, python3: PYTHON_RULES, ruby: [{ flag: /^-w$/ }], perl: [{ flag: /^-w$/ }],
};
const nonEmpty = (value: string) => value.length > 0 && !value.startsWith("-");
const MAKE_RULES: readonly OptionRule[] = [
  { flag: /^-j\d*$/ }, { flag: /^(?:-s|--silent|--no-print-directory)$/ },
  { flag: /^-C$/, value: nonEmpty }, { flag: /^-f$/, value: nonEmpty },
];
/** Options before a package runner's subcommand. */
const PACKAGE_RUNNER_RULES: readonly OptionRule[] = [{ flag: /^(?:-s|--silent)$/ }];
const NPX_RULES: readonly OptionRule[] = [{ flag: /^--no-install$/ }];

/**
 * The proven options before the first operand, with each option's value, or undefined when an option is not proven.
 * `--` ends the options. `make -j 4` reads its count as the value it takes.
 */
function provenOptions(rules: readonly OptionRule[], args: readonly string[]): { options: Array<[string, string | undefined]>; operand: number } | undefined {
  const options: Array<[string, string | undefined]> = [];
  let index = 0;
  while (index < args.length && /^[-+]/.test(args[index]!)) {
    const option = args[index]!;
    if (option === "--") return { options, operand: index + 1 };
    const rule = rules.find(each => each.flag.test(option));
    if (!rule) return undefined;
    if (rule.value) {
      const value = args[index + 1];
      if (value === undefined || !rule.value(value)) return undefined;
      options.push([option, value]);
      index += 2;
    } else if (option === "-j" && /^\d+$/.test(args[index + 1] ?? "")) {
      options.push([option, args[index + 1]]);
      index += 2;
    } else {
      options.push([option, undefined]);
      index += 1;
    }
  }
  return { options, operand: index };
}
/**
 * The file an agent write left at a path, as the writer's own descriptor saw it: the diff reads only this file,
 * whatever the path names later.
 */
export interface WrittenFileIdentity { readonly dev: bigint; readonly ino: bigint; readonly birthtimeNs: bigint }
interface ChangedFile {
  readonly path: string;
  /** From the latest attributed write's own descriptor; undefined when that write had no descriptor to report. */
  identity: WrittenFileIdentity | undefined;
  readonly sessionIds: Set<string>;
  readonly recordedAt: number;
  before?: string | null;
  lastUsed: TerminalReviewFile["lastUsed"];
}
interface ExecutionEvidence { paths: Set<string>; unresolved: boolean; steps: number; visited: Set<string> }

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
export function isTerminalReviewUnavailable(error: unknown): boolean {
  return ["EACCES", "EPERM", "ELOOP", "EBUSY", "ESTALE", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}
function textBytes(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

/** Whether `path` still names itself physically: no component, the parents included, resolves through a link. */
async function stillPhysical(path: string): Promise<boolean> {
  try { return await realpath(path) === path; }
  catch (error) {
    if (missing(error) || isTerminalReviewUnavailable(error)) return false;
    throw error;
  }
}

/** Opens without following a final link; `null` for an absent file, `undefined` for one that cannot be read. */
async function openNoFollow(path: string): Promise<FileHandle | null | undefined> {
  return open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    .catch((error: unknown) => { if (missing(error)) return null; if (isTerminalReviewUnavailable(error)) return undefined; throw error; });
}

/** Bounded text of an already opened regular file, refused when it changes while being read. */
async function readOpenedText(handle: FileHandle, opened: BigIntStats): Promise<string | undefined> {
  if (!opened.isFile() || opened.size > BigInt(MAX_INFERENCE_BYTES)) return undefined;
  const bytes = Buffer.alloc(MAX_INFERENCE_BYTES + 1);
  let size = 0;
  for (;;) {
    const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
    size += bytesRead;
    if (!bytesRead || size === bytes.length) break;
  }
  const after = await handle.stat({ bigint: true });
  if (size > MAX_INFERENCE_BYTES || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs
    || opened.ctimeNs !== after.ctimeNs || BigInt(size) !== after.size) return undefined;
  return textBytes(bytes.subarray(0, size));
}

/**
 * Bounded native text capture of a physical path, used at the successful mutation boundary and for command inference.
 * O_NOFOLLOW guards only the last component, so the path must also resolve to itself before the open and after it,
 * with the opened file the one the path names. Diffs never use this: they read only the recorded file identity.
 */
export async function readTerminalReviewText(path: string): Promise<string | null | undefined> {
  const info = await lstat(path, { bigint: true }).catch((error: unknown) => { if (missing(error)) return null; if (isTerminalReviewUnavailable(error)) return undefined; throw error; });
  if (info === null) return null;
  if (info === undefined) return undefined;
  if (!info.isFile() || info.size > BigInt(MAX_INFERENCE_BYTES)) return undefined;
  if (!await stillPhysical(path)) return undefined;
  const handle = await openNoFollow(path);
  if (handle === null) return null;
  if (handle === undefined) return undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== info.dev || opened.ino !== info.ino) return undefined;
    if (!await stillPhysical(path)) return undefined;
    const named = await lstat(path, { bigint: true }).catch((error: unknown) => { if (missing(error) || isTerminalReviewUnavailable(error)) return null; throw error; });
    if (!named || named.dev !== opened.dev || named.ino !== opened.ino) return undefined;
    return await readOpenedText(handle, opened);
  } catch (error) {
    if (isTerminalReviewUnavailable(error)) return undefined;
    throw error;
  } finally { await handle.close(); }
}

/** The identity of a file a writer holds open: `stats` is that descriptor's fstat. */
export function writtenFileIdentity(stats: BigIntStats): WrittenFileIdentity | undefined {
  return stats.isFile() ? { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs } : undefined;
}

const ownedWrites = new AsyncLocalStorage<Map<string, WrittenFileIdentity>>();

/**
 * Runs a mutation and returns, per physical path, the identities its writers reported through
 * {@link noteOwnedWrite}. A path whose writer reported nothing has no identity, and so no diff.
 */
export async function withOwnedWrites<T>(run: () => Promise<T>): Promise<{ result: T; owned: ReadonlyMap<string, WrittenFileIdentity> }> {
  const owned = new Map<string, WrittenFileIdentity>();
  const result = await ownedWrites.run(owned, run);
  return { result, owned };
}

/**
 * A writer's report from inside {@link withOwnedWrites}: `path` is where the file it wrote ends up (the rename
 * target for a temporary file), and `identity` comes from fstat on the descriptor it wrote through.
 */
export function noteOwnedWrite(path: string, identity: WrittenFileIdentity | undefined): void {
  const scope = ownedWrites.getStore();
  if (!scope) return;
  let physical: string;
  try { physical = resolvePhysicalFilesystemPath(path, process.cwd(), 64); }
  catch (error) { if (isTerminalReviewUnavailable(error)) return; throw error; }
  if (identity) scope.set(physical, identity);
  else scope.delete(physical);
}

/** The physical path evidence keys a write by, or undefined when it cannot be resolved. */
function evidencePath(path: string): string | undefined {
  try { return resolvePhysicalFilesystemPath(path, process.cwd(), 64); }
  catch (error) { if (isTerminalReviewUnavailable(error)) return undefined; throw error; }
}

/**
 * Current text of the recorded file, for its diff. Whatever the path's components resolve to at the open, the
 * descriptor must be the file the agent write left (same device, inode and birth time); any other file, including
 * one reached through a swapped parent or a save that replaced the inode, has no diff. Path checks cannot race this.
 */
async function readRecordedText(path: string, identity: WrittenFileIdentity): Promise<string | undefined> {
  const handle = await openNoFollow(path);
  if (!handle) return undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== identity.dev || opened.ino !== identity.ino || opened.birthtimeNs !== identity.birthtimeNs) return undefined;
    return await readOpenedText(handle, opened);
  } catch (error) {
    if (isTerminalReviewUnavailable(error)) return undefined;
    throw error;
  } finally { await handle.close(); }
}

async function existingFile(path: string, evidence?: ExecutionEvidence): Promise<string | null> {
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isFile() ? canonical : null;
  } catch (error) {
    if (missing(error)) return null;
    if (isTerminalReviewUnavailable(error) && evidence) { evidence.unresolved = true; return null; }
    throw error;
  }
}
async function inferenceText(path: string, evidence: ExecutionEvidence): Promise<string | null> {
  const text = await readTerminalReviewText(path);
  if (text === undefined) evidence.unresolved = true;
  return text ?? null;
}
function step(key: string, evidence: ExecutionEvidence): boolean {
  if (evidence.visited.has(key)) return false;
  if (++evidence.steps > MAX_INFERENCE_STEPS) { evidence.unresolved = true; return false; }
  evidence.visited.add(key);
  return true;
}

/** `localBins`: whether the shell running this has the package's node_modules/.bin on PATH, as inside a package script. */
async function script(path: string, cwd: string, evidence: ExecutionEvidence, localBins = false): Promise<void> {
  const physical = await existingFile(path, evidence);
  if (!physical) return;
  evidence.paths.add(physical);
  if (!step(`file:${physical}`, evidence)) return;
  const text = await inferenceText(physical, evidence);
  if (text === null) return;
  if (/\.(?:sh|bash|zsh)$/.test(physical) || /^#![^\n]*\b(?:ba|z)?sh\b/.test(text)) {
    await command(text.replace(/^#![^\n]*\n/, ""), cwd, evidence, localBins);
  } else if (/\b(?:import|require|eval|exec|spawn)\b/.test(text)) {
    evidence.unresolved = true;
  }
}

async function packageScript(cwd: string, name: string, evidence: ExecutionEvidence): Promise<void> {
  const path = await existingFile(join(cwd, "package.json"), evidence);
  if (!path) { evidence.unresolved = true; return; }
  evidence.paths.add(path);
  if (!step(`package:${path}:${name}`, evidence)) return;
  const text = await inferenceText(path, evidence);
  if (text === null) return;
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) { evidence.unresolved = true; return; } throw error; }
  const scripts = value && typeof value === "object" && "scripts" in value ? value.scripts : undefined;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) { evidence.unresolved = true; return; }
  const table = scripts as Record<string, unknown>;
  if (typeof table[name] !== "string") { evidence.unresolved = true; return; }
  // npm, pnpm, yarn and bun run scripts with node_modules/.bin first on PATH.
  for (const key of [`pre${name}`, name, `post${name}`]) if (typeof table[key] === "string") await command(table[key], cwd, evidence, true);
}

async function makeTarget(cwd: string, args: string[], evidence: ExecutionEvidence, localBins: boolean): Promise<void> {
  // Only the proven forms run recipes: `-j N`, `-s`, `-C dir`, `-f file`, then target names. Dry runs, queries,
  // variable assignments and any other option are uncertain.
  const proven = provenOptions(MAKE_RULES, args);
  const targets = proven ? args.slice(proven.operand) : [];
  if (!proven || targets.some(target => target.startsWith("-") || target.includes("="))) { evidence.unresolved = true; return; }
  let filename: string | undefined;
  for (const [option, value] of proven.options) {
    if (option === "-C") cwd = resolve(cwd, value!);
    else if (option === "-f") filename = value;
  }
  const path = filename ? await existingFile(resolve(cwd, filename), evidence)
    : await existingFile(join(cwd, "GNUmakefile"), evidence) ?? await existingFile(join(cwd, "makefile"), evidence) ?? await existingFile(join(cwd, "Makefile"), evidence);
  if (!path) { evidence.unresolved = true; return; }
  evidence.paths.add(path);
  const text = await inferenceText(path, evidence);
  if (text === null) return;
  const recipes = new Map<string, { dependencies: string[]; lines: string[] }>();
  let active: { dependencies: string[]; lines: string[] } | undefined;
  for (const line of text.replace(/\\\n/g, " ").split("\n")) {
    if (line.startsWith("\t") && active) { active.lines.push(line.slice(1).replace(/^[@+\-]+/, "")); continue; }
    if (/^\s*(?:include|-include|sinclude|define|ifeq|ifneq|ifdef|ifndef)\b/.test(line)) evidence.unresolved = true;
    const match = /^([^\s#:=][^:=]*):([^=].*)?$/.exec(line);
    active = undefined;
    if (!match) continue;
    const body = match[2] ?? "";
    const inline = body.indexOf(";");
    active = { dependencies: (inline >= 0 ? body.slice(0, inline) : body).trim().split(/\s+/).filter(Boolean),
      lines: inline >= 0 ? [body.slice(inline + 1).trim()] : [] };
    if (/[\$%]/.test(match[1]!)) evidence.unresolved = true;
    for (const target of match[1]!.trim().split(/\s+/)) recipes.set(target, active);
  }
  const requested = targets.length ? targets : [...recipes.keys()].filter(key => !key.startsWith("." )).slice(0, 1);
  const visit = async (target: string): Promise<void> => {
    if (!step(`make:${path}:${target}`, evidence)) return;
    const recipe = recipes.get(target);
    if (!recipe) return;
    for (const dependency of recipe.dependencies) {
      if (/[\$%*?]/.test(dependency)) evidence.unresolved = true;
      else await visit(dependency);
    }
    for (const line of recipe.lines) await command(line, cwd, evidence, localBins);
  };
  for (const target of requested) await visit(target);
}

async function command(source: string, cwd: string, evidence: ExecutionEvidence, localBins = false): Promise<void> {
  if (!step(`command:${cwd}:${source}`, evidence)) return;
  const parsed = tokenizeShell(source);
  if (parsed.parseError) { evidence.unresolved = true; return; }
  for (const leaf of parsed.leaves) {
    if (leaf.hasExpansion || leaf.argvHasExpandableDollar.some(Boolean)) evidence.unresolved = true;
    const [head, ...args] = leaf.argv;
    if (!head || leaf.argvHasExpandableDollar[0]) continue;
    const verb = basename(head);
    if (verb === "cd" || leaf.strippedWrappers.includes("env") && /(?:-C|--chdir)/.test(leaf.raw)) { evidence.unresolved = true; continue; }
    if (head.includes("/") || head.includes("\\")) await script(resolve(cwd, head), cwd, evidence, localBins);
    else {
      const bin = await existingFile(join(cwd, "node_modules", ".bin", head), evidence);
      // A plain name resolves to a local bin only where the runner puts .bin on PATH; elsewhere PATH decides, so a
      // local bin of that name is uncertain, not a match.
      if (bin && localBins) await script(bin, cwd, evidence, localBins);
      else if (bin) evidence.unresolved = true;
    }
    const interpreter = INTERPRETER_RULES[verb];
    if (interpreter) {
      const proven = provenOptions(interpreter, args);
      if (!proven) { evidence.unresolved = true; continue; }
      const operand = args[proven.operand];
      if (operand && !leaf.argvHasExpandableDollar[proven.operand + 1]) await script(resolve(cwd, operand), cwd, evidence, localBins);
    } else if (verb === "make" || verb === "gmake") {
      await makeTarget(cwd, args, evidence, localBins);
    } else if (["npm", "pnpm", "yarn", "bun"].includes(verb)) {
      const proven = provenOptions(PACKAGE_RUNNER_RULES, args);
      if (!proven) { evidence.unresolved = true; continue; }
      args.splice(0, proven.operand);
      const run = args[0] === "run" || args[0] === "run-script";
      const name = run ? args[1] : args[0];
      if (name && !["exec", "x"].includes(name) && !name.startsWith("-") && (run || ["yarn", "pnpm", "bun"].includes(verb) || ["start", "test", "stop", "restart"].includes(name))) {
        await packageScript(cwd, name, evidence);
      } else if (args[0] === "exec" || args[0] === "x") {
        const bin = args.slice(1).find(arg => arg !== "--");
        if (bin) await script(join(cwd, "node_modules", ".bin", bin), cwd, evidence);
        evidence.unresolved = true;
      }
    } else if (verb === "npx") {
      const proven = provenOptions(NPX_RULES, args);
      const bin = proven ? args[proven.operand] : undefined;
      if (bin && !bin.startsWith("-")) await script(join(cwd, "node_modules", ".bin", bin), cwd, evidence);
      evidence.unresolved = true;
    } else if (["eval", "exec", "sudo", "xargs"].includes(verb)) evidence.unresolved = true;
  }
}

/** Static, best-effort inference of the files a host command executes or sources. `unresolved` marks
 * indirection it could not follow; callers must not present such a command as covered or as a match. */
export async function inferExecutedPaths(source: string, cwd: string | null): Promise<{ paths: string[]; unresolved: boolean }> {
  const evidence: ExecutionEvidence = { paths: new Set(), unresolved: false, steps: 0, visited: new Set() };
  try {
    if (cwd) await command(source, cwd, evidence);
    else evidence.unresolved = true;
  } catch (error) {
    if (!isTerminalReviewUnavailable(error)) throw error;
    evidence.unresolved = true;
  }
  return { paths: [...evidence.paths], unresolved: evidence.unresolved };
}

/** In-memory, session-attributed evidence. It has no permission-policy consumers. */
export class TerminalFileEvidence {
  private readonly files = new Map<string, ChangedFile>();
  /** Per-block positive matches; `null` caches a block that uses no recorded agent-changed file. */
  private readonly commands = new Map<string, TerminalExecutionWarning | null>();

  /**
   * Records an attributed write. `identity` is what the writer's own descriptor reported, never a re-open of the path:
   * whatever the path named between the write and this call cannot enter the ledger. Undefined means the write had no
   * descriptor to report, and the file then has no diff until a write that does.
   */
  async recordWrite(sessionId: string, path: string, before: string | null | undefined, identity: WrittenFileIdentity | undefined): Promise<void> {
    if (!sessionId) throw new Error("Missing changed-file session");
    // An unresolvable write target cannot be matched later; detection is documented as best-effort.
    const physical = evidencePath(path);
    if (physical === undefined) return;
    const existing = this.files.get(physical);
    if (existing) { existing.sessionIds.add(sessionId); existing.identity = identity; }
    else this.files.set(physical, { path: physical, identity, sessionIds: new Set([sessionId]),
      before: before === null || before !== undefined && Buffer.byteLength(before, "utf8") <= MAX_INFERENCE_BYTES && !before.includes("\0") ? before : undefined, lastUsed: null, recordedAt: Date.now() });
  }

  /**
   * The change against the recorded baseline, in the chat's review shape. Only the recorded file is read; an unknown
   * baseline, or current content that is not the recorded file's text, has no review.
   */
  private async review(file: ChangedFile): Promise<TurnReviewFile | undefined> {
    if (file.before === undefined || !file.identity) return undefined;
    const after = await readRecordedText(file.path, file.identity);
    if (typeof after !== "string") return undefined;
    const before = file.before ?? "";
    const counts = countFileChangeLines(before, after);
    return {
      path: file.path, bytes: Buffer.byteLength(after, "utf8"), lineCount: countTurnReviewLines(after),
      added: counts.added, removed: counts.removed, countsKnown: counts.exact,
      operation: file.before === null ? "create" : "modify",
      // Terminal provenance offers no chat line references.
      referenceable: false,
      hunks: createTurnReviewHunks(before, after, file.before === null, file.path),
    };
  }

  async snapshot(cwd: string, blocks: readonly TerminalBlockSummary[], terminalSessionId = ""): Promise<TerminalFileReviewSnapshot> {
    const physicalCwd = resolvePhysicalFilesystemPath(cwd, process.cwd(), 64);
    const warnings: TerminalExecutionWarning[] = [];
    for (const block of blocks) {
      const key = `${terminalSessionId}:${block.startedAt}:${block.id}:${block.cwd}:${block.command}`;
      let warning = this.commands.get(key);
      if (warning === undefined) {
        const inferred = await inferExecutedPaths(block.command, block.cwd);
        const paths = inferred.paths.filter(path => { const file = this.files.get(path); return file !== undefined && file.recordedAt <= block.startedAt; });
        warning = paths.length > 0 ? { blockId: block.id, command: block.command, files: paths } : null;
        this.commands.set(key, warning);
        if (this.commands.size > 2_048) this.commands.delete(this.commands.keys().next().value!);
        for (const path of paths) {
          const file = this.files.get(path)!;
          if (!file.lastUsed || file.lastUsed.when <= block.startedAt) file.lastUsed = { command: block.command, when: block.startedAt };
        }
      }
      // Only a concrete match to an agent-changed file is a warning; unresolved indirection never is.
      if (warning === null) continue;
      warnings.push(warning);
    }
    // The files this terminal's commands used: the same set the badge counts and the changes view lists.
    const relevant = new Set(warnings.flatMap(warning => warning.files));
    const files: TerminalReviewFile[] = [];
    for (const file of this.files.values()) {
      if (!relevant.has(file.path)) continue;
      const review = await this.review(file);
      files.push({ path: file.path, sessionIds: [...file.sessionIds], lastUsed: file.lastUsed, ...(review ? { review } : {}) });
    }
    const latestBlockId = blocks.reduce<number | null>((latest, block) => latest === null || block.id > latest ? block.id : latest, null);
    return { cwd: physicalCwd, latestBlockId, files, warnings };
  }
}

export const terminalFileEvidence = new TerminalFileEvidence();
