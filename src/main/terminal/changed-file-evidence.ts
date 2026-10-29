import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TerminalBlockSummary } from "../../shared/terminal-blocks.js";
import type { TerminalFileReviewSnapshot, TerminalExecutionWarning, TerminalReviewFile } from "../../shared/terminal-file-review.js";
import { tokenizeShell } from "../../shared/shell-tokenizer.js";
import { resolvePhysicalFilesystemPath } from "../../shared/shell-filesystem-path.js";

const MAX_INFERENCE_BYTES = 1_048_576;
const MAX_INFERENCE_STEPS = 128;
/** make options under which no recipe runs: dry run, question, touch, version, help. */
const MAKE_NON_EXECUTING = /^(?:-[a-zA-Z]*[nqt][a-zA-Z]*|--(?:dry-run|just-print|recon|question|touch|version|help)|-v|-h)$/;
/** make options that change how recipes run but still run them. */
const MAKE_EXECUTING_OPTION = /^(?:-[sSkKiBwWeE]+|-j\d*|-l[\d.]*|--(?:silent|quiet|keep-going|ignore-errors|always-make|print-directory|no-print-directory|environment-overrides)|--jobs(?:=\d+)?|--load-average(?:=[\d.]+)?)$/;

/** Interpreter options under which the operand never runs: version or help output, a syntax check, a shell no-exec. */
function interpreterRunsNothing(verb: string, option: string): boolean {
  if (["sh", "bash", "zsh"].includes(verb)) return /^-[a-zA-Z]*n[a-zA-Z]*$/.test(option) || option === "--version" || option === "--help";
  if (verb === "node") return ["-v", "-h", "--version", "--help", "--check"].includes(option);
  if (verb === "python" || verb === "python3") return ["-V", "-h", "--version", "--help"].includes(option);
  if (verb === "ruby") return ["-h", "-c", "-y", "--version", "--help"].includes(option);
  if (verb === "perl") return ["-v", "-h", "-c"].includes(option);
  return false;
}
interface ChangedFile {
  readonly path: string;
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
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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

/**
 * Bounded native text capture of a physical path, used at the successful mutation boundary and for diffs.
 * O_NOFOLLOW guards only the last component, so the path must also resolve to itself before the open and after it,
 * with the opened file the one the path names: a parent swapped for a link never lets this read another file.
 */
export async function readTerminalReviewText(path: string): Promise<string | null | undefined> {
  const info = await lstat(path).catch((error: unknown) => { if (missing(error)) return null; if (isTerminalReviewUnavailable(error)) return undefined; throw error; });
  if (info === null) return null;
  if (info === undefined) return undefined;
  if (!info.isFile() || info.size > MAX_INFERENCE_BYTES) return undefined;
  if (!await stillPhysical(path)) return undefined;
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    .catch((error: unknown) => { if (missing(error)) return null; if (isTerminalReviewUnavailable(error)) return undefined; throw error; });
  if (handle === null) return null;
  if (handle === undefined) return undefined;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) return undefined;
    if (!await stillPhysical(path)) return undefined;
    const named = await lstat(path).catch((error: unknown) => { if (missing(error) || isTerminalReviewUnavailable(error)) return null; throw error; });
    if (!named || named.dev !== opened.dev || named.ino !== opened.ino) return undefined;
    const bytes = Buffer.alloc(MAX_INFERENCE_BYTES + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      size += bytesRead;
      if (!bytesRead || size === bytes.length) break;
    }
    const after = await handle.stat();
    if (size > MAX_INFERENCE_BYTES || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs || size !== after.size) return undefined;
    return textBytes(bytes.subarray(0, size));
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
  let filename: string | undefined;
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-C" || arg === "--directory") { cwd = resolve(cwd, args[++i] ?? "."); continue; }
    if (arg === "-f" || arg === "--file" || arg === "--makefile") { filename = args[++i]; continue; }
    if (arg.startsWith("--file=") || arg.startsWith("--makefile=")) { filename = arg.slice(arg.indexOf("=") + 1); continue; }
    // Dry runs, queries, touch mode, version and help run no recipe; an option this cannot classify is uncertain.
    // Neither is a positive match.
    if (MAKE_NON_EXECUTING.test(arg)) return;
    if ((arg === "-j" || arg === "-l") && /^[\d.]+$/.test(args[i + 1] ?? "")) { i++; continue; }
    if (arg.startsWith("-")) {
      if (MAKE_EXECUTING_OPTION.test(arg)) continue;
      evidence.unresolved = true;
      return;
    }
    if (arg.includes("=")) { evidence.unresolved = true; continue; }
    targets.push(arg);
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
    if ([".", "source", "sh", "bash", "zsh", "node", "python", "python3", "ruby", "perl"].includes(verb)) {
      let index = 0;
      let runsNothing = false;
      while (args[index]?.startsWith("-") || args[index]?.startsWith("+")) {
        const option = args[index]!;
        if (option === "--") { index++; break; }
        if (interpreterRunsNothing(verb, option)) { runsNothing = true; break; }
        const shellInterpreter = ["sh", "bash", "zsh"].includes(verb);
        const evaluatesSource = shellInterpreter ? /^-[a-zA-Z]*c/.test(option)
          : ["-c", "-e", "-E", "-m", "-p", "--eval", "--print"].includes(option);
        if (evaluatesSource || ["--eval", "--command", "--print"].includes(option)) {
          evidence.unresolved = true; break;
        }
        if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file", "-W", "-X"].includes(option)) {
          if (args[index + 1] === undefined) { evidence.unresolved = true; break; }
          index += 2; continue;
        }
        if (["-r", "--require", "--import"].includes(option)) {
          const preload = args[index + 1];
          if (preload?.startsWith(".") || preload && isAbsolute(preload)) await script(resolve(cwd, preload), cwd, evidence, localBins);
          else evidence.unresolved = true;
          index += 2; continue;
        }
        if (/^-[a-zA-Z]+$/.test(option) || ["--noprofile", "--norc", "--no-warnings", "--trace-warnings"].includes(option)) { index++; continue; }
        evidence.unresolved = true; break;
      }
      if (runsNothing) continue;
      const operand = args[index];
      if (operand && !operand.startsWith("-") && !leaf.argvHasExpandableDollar[index + 1]) await script(resolve(cwd, operand), cwd, evidence, localBins);
    } else if (verb === "make" || verb === "gmake") {
      await makeTarget(cwd, args, evidence, localBins);
    } else if (["npm", "pnpm", "yarn", "bun"].includes(verb)) {
      let packageCwd = cwd;
      let uncertain = false;
      while (args[0]?.startsWith("-")) {
        const option = args.shift()!;
        if (["--silent", "-s", "--ignore-scripts", "--if-present", "--offline", "--no-install"].includes(option)) continue;
        if (["--prefix", "--cwd", "-C", "--dir"].includes(option) && args[0] !== undefined) {
          packageCwd = resolve(packageCwd, args.shift()!); continue;
        }
        // `--version`, `--help` and any option this cannot classify may mean nothing runs: never a positive match.
        evidence.unresolved = true; uncertain = true; break;
      }
      if (uncertain) continue;
      const run = args[0] === "run" || args[0] === "run-script";
      const name = run ? args[1] : args[0];
      if (name && !["exec", "x"].includes(name) && !name.startsWith("-") && (run || ["yarn", "pnpm", "bun"].includes(verb) || ["start", "test", "stop", "restart"].includes(name))) {
        await packageScript(packageCwd, name, evidence);
      } else if (args[0] === "exec" || args[0] === "x") {
        const bin = args.slice(1).find(arg => arg !== "--");
        if (bin) await script(join(packageCwd, "node_modules", ".bin", bin), packageCwd, evidence);
        evidence.unresolved = true;
      }
    } else if (verb === "npx") {
      const bin = args.find(arg => !arg.startsWith("-"));
      if (bin) await script(join(cwd, "node_modules", ".bin", bin), cwd, evidence);
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

  async recordWrite(sessionId: string, path: string, before?: string | null): Promise<void> {
    if (!sessionId) throw new Error("Missing changed-file session");
    let physical: string;
    try { physical = resolvePhysicalFilesystemPath(path, process.cwd(), 64); }
    catch (error) {
      // An unresolvable write target cannot be matched later; detection is documented as best-effort.
      if (!isTerminalReviewUnavailable(error)) throw error;
      return;
    }
    const existing = this.files.get(physical);
    if (existing) existing.sessionIds.add(sessionId);
    else this.files.set(physical, { path: physical, sessionIds: new Set([sessionId]),
      before: before === null || before !== undefined && Buffer.byteLength(before, "utf8") <= MAX_INFERENCE_BYTES && !before.includes("\0") ? before : undefined, lastUsed: null, recordedAt: Date.now() });
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
    const relevant = new Set(warnings.flatMap(warning => warning.files));
    const files: TerminalReviewFile[] = [];
    for (const file of this.files.values()) {
      if (!within(physicalCwd, file.path) && !relevant.has(file.path)) continue;
      // Current text for the diff only; absent, oversized, binary or unreadable content has no text diff.
      const after = file.before === undefined ? undefined : await readTerminalReviewText(file.path);
      files.push({ path: file.path, sessionIds: [...file.sessionIds], lastUsed: file.lastUsed,
        ...(file.before !== undefined && typeof after === "string" ? { diff: { before: file.before ?? "", after } } : {}) });
    }
    const latestBlockId = blocks.reduce<number | null>((latest, block) => latest === null || block.id > latest ? block.id : latest, null);
    return { cwd: physicalCwd, latestBlockId, files, warnings };
  }
}

export const terminalFileEvidence = new TerminalFileEvidence();
