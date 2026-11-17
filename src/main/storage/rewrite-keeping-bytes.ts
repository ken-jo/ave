// The one rewrite of a home file whose bytes never go silently. Every board.json and workflow-runs.json rewrite comes through here.
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { readAveHomeInput } from "../../shared/ave-home-trust.js";
import { createLogger } from "../../lib/logger.js";
import { writeFileAtomicAtPath } from "./feature-namespace.js";

const log = createLogger("rewrite-keeping-bytes");

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
