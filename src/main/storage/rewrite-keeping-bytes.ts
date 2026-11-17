// The one rewrite of a home file whose bytes never go silently. Every board.json and workflow-runs.json rewrite comes through here.
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { readAveHomeInput } from "../../shared/ave-home-trust.js";
import { createLogger } from "../../lib/logger.js";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "./feature-namespace.js";
import { parseStrictJsonText } from "../../shared/strict-json.js";
import type { WorkBoardRefusalCode } from "../../shared/work-board-types.js";

const log = createLogger("rewrite-keeping-bytes");

/** A work-board file write or read a guard refused: nothing was written. `path`: the file the refusal is about. */
export class WorkBoardWriteRefusal extends Error {
  constructor(readonly code: WorkBoardRefusalCode, readonly path?: string) { super(code); this.name = "WorkBoardWriteRefusal"; }
}

const NO_KEYS: ReadonlySet<string> = new Set();
const strictFail = (reason: string): never => { throw new Error(reason); };

/** True for JSON text with an object that holds a key twice: a read keeps only its last value, so writing back what was read would
 * lose the others. JSON the strict read cannot finish (nesting too deep for it) counts as holding one; text that is not JSON does not. */
export function repeatsKey(text: string): boolean {
  try { JSON.parse(text); } catch { return false; }
  try {
    parseStrictJsonText(text, { maxDepth: Number.POSITIVE_INFINITY, forbiddenKeys: NO_KEYS, nullPrototypeObjects: true, rejectNonFiniteNumbers: false, fail: strictFail });
    return false;
  } catch { return true; }
}

/** Whether the copy at `copy` stands for the bytes `hash` names, or is absent: only its own regular file does, one that is no symbolic
 * link, junction or second hard link (nlink 1) and not `filePath` itself, whose bytes, read through a handle on that same file, hash to
 * the name. */
async function copyHolds(copy: string, filePath: string, hash: string, size: number): Promise<boolean | "absent"> {
  try {
    const entry = await lstat(copy, { bigint: true });
    const source = await lstat(filePath, { bigint: true }).catch(() => undefined);
    if (!entry.isFile() || entry.nlink !== 1n || entry.size !== BigInt(size) || (source?.dev === entry.dev && source.ino === entry.ino)) return false;
    const handle = await open(copy, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== entry.dev || opened.ino !== entry.ino) return false;
      return createHash("sha256").update(await handle.readFile()).digest("hex") === hash;
    } finally { await handle.close(); }
  } catch (error) { return isMissingPathError(error) ? "absent" : false; }
}

/** Write `body` over `filePath`. The bytes there, unless they are exactly `unchanged` (what writing the file back as its writer read it
 * gives), are first copied beside it to `<file>.<tag>-<sha256>.bak`, once per content. `check` sees those bytes before anything is
 * written and throws to refuse the write. Only a copy that {@link copyHolds} them lets the write go over them: one already there that
 * does not refuses it with work-board-backup-conflict, and one that cannot be made, or once made does not hold them, with
 * work-board-backup-failed, each with the copy's path; the file stays as it was. The copy is checked just before the file is replaced:
 * whoever can swap it in between can as well swap the file itself, which no check here could stop. */
export async function rewriteKeepingBytes(
  filePath: string,
  body: string,
  keep: { tag: string; unchanged?: string; check?: (prior: Buffer | undefined) => void },
): Promise<void> {
  const input = await readAveHomeInput(filePath);
  const prior = input.status === "absent" || input.bytes.length === 0 ? undefined : input.bytes;
  keep.check?.(prior);
  if (prior !== undefined && (keep.unchanged === undefined || !prior.equals(Buffer.from(keep.unchanged, "utf8")))) {
    const hash = createHash("sha256").update(prior).digest("hex");
    const copy = `${filePath}.${keep.tag}-${hash}.bak`;
    const held = await copyHolds(copy, filePath, hash, prior.length);
    if (held === "absent") {
      const made = await writeFileAtomicAtPath(copy, prior).then(() => copyHolds(copy, filePath, hash, prior.length), (error: Error) => error);
      if (made !== true) {
        log.warn("%s was not written: its bytes could not be copied to %s: %s", filePath, copy, made instanceof Error ? made.message : "the copy made does not hold them");
        throw new WorkBoardWriteRefusal("work-board-backup-failed", copy);
      }
      log.warn("%s holds bytes a write would not give back; kept them at %s", filePath, copy);
    } else if (!held) {
      log.warn("%s was not written: the copy of its bytes at %s does not hold them, is not its own file, or cannot be read", filePath, copy);
      throw new WorkBoardWriteRefusal("work-board-backup-conflict", copy);
    }
  }
  await writeFileAtomicAtPath(filePath, body);
}
