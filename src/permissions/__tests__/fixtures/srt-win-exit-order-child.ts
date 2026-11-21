// Child process for the exit-order test: the integrity module registers its exit handler at import, as in the product; the handler registered below
// stands in for the sandbox runtime's, which initialize registers later and which spawns the private copy synchronously to release the session's ACEs.
import { once } from "node:events";
import fs, { existsSync, writeFileSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";

if (process.env.AVE_TEST_SRT_RECEIPTS) {
  const receipts = JSON.parse(process.env.AVE_TEST_SRT_RECEIPTS);
  registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/generated/srt-win-build-receipts.js")) return {
      format: "module", shortCircuit: true, source: `export default ${JSON.stringify(receipts)};`,
    };
    return nextLoad(url, context);
  } });
}
const [source, resultPath, mode] = process.argv.slice(2);
if (!source || !resultPath || !mode) throw new Error("Expected helper source, result path and exit mode");

let lockAttempts = 0;
let executable: string;
if (mode === "simulate-lock") {
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (path) => {
    if (path !== executable) return unlink(path);
    lockAttempts++;
    throw Object.assign(new Error("Image is locked"), { code: "EPERM" });
  };
  syncBuiltinESMExports();
}
const { markSrtWinRuntimeReleased, markSrtWinRuntimeReleasePending, prepareSrtWinExecutable } = await import("../../srt-win-integrity.js");
executable = prepareSrtWinExecutable(source);
if (mode === "await-quit") {
  writeFileSync(resultPath, JSON.stringify({ executable }));
  process.stdout.write("ready\n");
  await once(process.stdin, "data");
} else if (mode === "runtime-pending" || mode === "runtime-reset") {
  markSrtWinRuntimeReleasePending();
  process.once("exit", () => {
    writeFileSync(resultPath, JSON.stringify({ executable, presentAtRuntimeRelease: existsSync(executable) }));
  });
} else {
  process.once("exit", () => writeFileSync(resultPath, JSON.stringify({ executable, lockAttempts })));
}
// The quit sequence's awaited reset clears the pending release before the process exits.
if (mode === "runtime-reset") markSrtWinRuntimeReleased();
process.exit(0);
