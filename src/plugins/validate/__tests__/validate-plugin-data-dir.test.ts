/** Delete child-writable data only after observed exit; otherwise a live child could redirect recursive cleanup. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** These children refuse signals, so exit is never observed. */
const refusal = vi.hoisted(() => ({
  commandPrefix: undefined as string | undefined,
  pids: [] as number[],
  onConstruct: undefined as (() => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const prefix = refusal.commandPrefix;
      const refuses = prefix !== undefined && String(args[0]).startsWith(prefix);
      const child = refuses
        ? actual.spawn(String(args[0]), args[1] as string[], {
          ...args[2], stdio: ["pipe", "pipe", "pipe", "ipc"],
        })
        : (actual.spawn as (...a: unknown[]) => ChildProcess)(...args);
      if (refuses) {
        refusal.pids.push(child.pid!);
        child.on("message", (message) => {
          if (message === "construct") refusal.onConstruct?.();
        });
        child.kill = (signal?: NodeJS.Signals | number): boolean => {
          child.emit("error", Object.assign(new Error(`kill ${String(signal)} EPERM`), { code: "EPERM", syscall: "kill" }));
          return false;
        };
      }
      return child;
    },
  };
});

import { validatePluginDirectory } from "../validate-plugin.js";
import { observe } from "../../isolation/__tests__/stream-turns.js";

const PROCESS_PLUGIN = fileURLToPath(new URL("./fixtures/process/", import.meta.url));
const RAW_SPEAK = pathToFileURL(fileURLToPath(new URL("./fixtures/raw/speak.mjs", import.meta.url))).href;

let scratch: string | undefined;

afterEach(() => {
  vi.useRealTimers();
  for (const pid of refusal.pids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch {  }
  }
  refusal.commandPrefix = undefined;
  refusal.onConstruct = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("validatePluginDirectory data directory", () => {
  // Process entries are unmeasured on Windows, where this case spawns no child.
  it.skipIf(process.platform === "win32")("leaves the data directory when the child did not exit", async () => {
    scratch = mkdtempSync(join(tmpdir(), "validate-data-dir-"));
    const plugin = join(scratch, "plugin");
    cpSync(PROCESS_PLUGIN, plugin, { recursive: true });
    writeFileSync(join(plugin, "server.mjs"), `import { constructed, reply, speak, WITHHOLD } from ${JSON.stringify(RAW_SPEAK)};
speak({
  "ave/instance/construct": (request) => {
    process.send?.("construct");
    setTimeout(() => reply(request.id, constructed(request.params)), 60_000);
    return WITHHOLD;
  },
});
`);
    refusal.commandPrefix = realpathSync(plugin);

    const inConstruct = new Promise<void>((resolve) => { refusal.onConstruct = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const validating = validatePluginDirectory(plugin, {
      childEntry: "",
      childExecArgs: [],
      fast: true,
      toolArgs: {},
    });
    const settled = observe(validating);
    await inConstruct;
    // Advance protocol and teardown only after child readiness, with a virtual bound on the test.
    for (let elapsed = 0; !settled() && elapsed < 60_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(settled()).toBe(true);
    const rows = await validating;

    expect(rows.find((row) => row.check === "protocol.teardown")?.ok).toBe(false);
    const kept = rows.find((row) => row.check === "protocol.data-dir");
    expect(kept?.ok).toBe(false);
    const path = /left (\S+) in place/.exec(kept?.message ?? "")?.[1];
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
    rmSync(path!, { recursive: true, force: true });
  }, 20_000);
});
