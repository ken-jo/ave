// Child process for the exit-order test: the integrity module registers its exit handler at import, as in the product; the handler registered below
// stands in for the sandbox runtime's, which initialize registers later and which spawns the private copy synchronously to release the session's ACEs.
import { existsSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

if (process.env.AVE_TEST_SRT_RECEIPTS) {
  const receipts = JSON.parse(process.env.AVE_TEST_SRT_RECEIPTS);
  registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/generated/srt-win-build-receipts.js")) return {
      format: "module", shortCircuit: true, source: `export default ${JSON.stringify(receipts)};`,
    };
    return nextLoad(url, context);
  } });
}
const { markSrtWinRuntimeReleased, markSrtWinRuntimeReleasePending, prepareSrtWinExecutable } = await import("../../srt-win-integrity.js");

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
