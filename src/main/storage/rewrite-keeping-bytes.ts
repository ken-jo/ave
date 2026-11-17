// The one rewrite of a home file whose bytes never go silently. Every board.json and workflow-runs.json rewrite comes through here.
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { readAveHomeInput } from "../../shared/ave-home-trust.js";
import { createLogger } from "../../lib/logger.js";
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

/** Write `body` over `filePath`. The bytes there, unless they are exactly `unchanged` (what writing the file back as its writer read it
 * gives), are first copied beside it to `<file>.<tag>-<sha256>.bak`, once per content. `check` sees those bytes before anything is
 * written and throws to refuse the write. A copy that cannot be made fails the write, and the file stays as it was. */
export async function rewriteKeepingBytes(
  filePath: string,
  body: string,
  keep: { tag: string; unchanged?: string; check?: (prior: Buffer | undefined) => void },
): Promise<void> {
  const input = await readAveHomeInput(filePath);
  const prior = input.status === "absent" || input.bytes.length === 0 ? undefined : input.bytes;
  keep.check?.(prior);
  if (prior !== undefined && (keep.unchanged === undefined || !prior.equals(Buffer.from(keep.unchanged, "utf8")))) {
    const copy = `${filePath}.${keep.tag}-${createHash("sha256").update(prior).digest("hex")}.bak`;
    if (!(await access(copy).then(() => true, () => false))) {
      await writeFileAtomicAtPath(copy, prior);
      log.warn("%s holds bytes a write would not give back; kept them at %s", filePath, copy);
    }
  }
  await writeFileAtomicAtPath(filePath, body);
}
