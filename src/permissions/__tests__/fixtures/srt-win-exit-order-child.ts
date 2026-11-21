// Child process for the exit-order test: the integrity module registers its exit handler at import, as in the product; the handler registered below
// stands in for the sandbox runtime's, which initialize registers later and which spawns the private copy synchronously to release the session's ACEs.
import fs, { existsSync, type PathLike, writeFileSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";

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

const [source, resultPath, mode, lockedEntry] = process.argv.slice(2);
if (!source || !resultPath || !mode) throw new Error("usage: <source> <result> <runtime-pending|runtime-reset|no-runtime>");

const executable = prepareSrtWinExecutable(source);
let lockAttempts = 0;
if (lockedEntry !== undefined) {
  const bin = dirname(executable);
  const marker = join(bin, "owner.json");
  // The Windows allocation writes a marker. Supply one for the POSIX test copy.
  if (process.platform !== "win32") writeFileSync(marker, JSON.stringify({ pid: process.pid, started: "1" }));
  const targets: Record<string, string> = { image: executable, marker, bin, outer: dirname(bin) };
  const simulateLock = (path: PathLike) => {
    if (path !== targets[lockedEntry]) return;
    lockAttempts++;
    throw Object.assign(new Error("Copy entry is locked"), { code: "EPERM" });
  };
  const { rmSync, rmdirSync } = fs;
  fs.rmSync = (path, options) => { simulateLock(path); rmSync(path, options); };
  fs.rmdirSync = (path) => { simulateLock(path); rmdirSync(path); };
  syncBuiltinESMExports();
}
if (mode !== "no-runtime") {
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
