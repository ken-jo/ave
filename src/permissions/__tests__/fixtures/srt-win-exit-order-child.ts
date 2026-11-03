// Child process for the exit-order test: the integrity module registers its exit handler at import, as in the product; the handler registered below
// stands in for the sandbox runtime's, which initialize registers later and which spawns the private copy synchronously to release the session's ACEs.
import { existsSync, writeFileSync } from "node:fs";

import { markSrtWinRuntimeReleased, markSrtWinRuntimeReleasePending, prepareSrtWinExecutable } from "../../srt-win-integrity.js";

const [source, resultPath, mode] = process.argv.slice(2);
if (!source || !resultPath || !mode) throw new Error("usage: <source> <result> <runtime-pending|runtime-reset|no-runtime>");

const executable = prepareSrtWinExecutable(source);
if (mode !== "no-runtime") {
  markSrtWinRuntimeReleasePending();
  process.once("exit", () => {
    writeFileSync(resultPath, JSON.stringify({ executable, presentAtRuntimeRelease: existsSync(executable) }));
  });
} else {
  process.once("exit", () => writeFileSync(resultPath, JSON.stringify({ executable })));
}
// The quit sequence's awaited reset clears the pending release before the process exits.
if (mode === "runtime-reset") markSrtWinRuntimeReleased();
process.exit(0);
