/** Source inspection avoids entry-point side effects. app.quit() must flush transcripts and audit logs; exec console output must use stderr. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mainSource = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf-8")
  .replace(/\r\n/g, "\n");
const loggerSource = readFileSync(resolve(process.cwd(), "src/lib/logger.ts"), "utf-8")
  .replace(/\r\n/g, "\n");
const execModeSource = readFileSync(resolve(process.cwd(), "src/main/exec-mode.ts"), "utf-8")
  .replace(/\r\n/g, "\n");
const windowSource = readFileSync(resolve(process.cwd(), "src/main/main-window.ts"), "utf-8")
  .replace(/\r\n/g, "\n");
const bootSource = readFileSync(resolve(process.cwd(), "src/boot.ts"), "utf-8")
  .replace(/\r\n/g, "\n");

function extractExecBranch(text: string): string | null {
  const opener = text.match(/if\s*\(\s*execRequest\s*!==\s*null\s*\)\s*\{/);
  if (!opener || opener.index === undefined) return null;
  const start = opener.index + opener[0].length - 1;
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return depth === 0 ? text.slice(start + 1, i - 1) : null;
}

describe("main.ts — headless exec branch", () => {
  it("imports the runner from the unit-testable module", () => {
    expect(mainSource).toMatch(
      /import\s*\{[^}]*\brunExecTurn\b[^}]*\}\s*from\s*"\.\/main\/exec-mode\.js"/,
    );
    expect(mainSource).toContain("parseExecFlags(process.argv, launchCwd)");
  });

  it("captures the launch directory before the workspace anchor moves the process", () => {
    const capture = mainSource.indexOf("const launchCwd = execModeRequested(process.argv) ? process.cwd() : null;");
    const anchor = mainSource.indexOf("runEarlyBootEnv();");
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(anchor).toBeGreaterThan(capture);
  });

  it("hands every run the one workspace authorization resolver, which owns the broker cwd rule", () => {
    // CLI prechecks and session authorization must agree on broker-bound guest roots.
    expect(mainSource).toMatch(
      /isAuthorizedProjectRoot:\s*isAuthorizedWorkspaceProjectRoot,/,
    );
    expect(mainSource).not.toContain("isWorkloadBrokerActive()");
    expect(mainSource).toContain("waitForRelease: waitForExecRelease,");
    expect(mainSource).toContain("flushTelemetry: services.flushTracing,");
  });

  it("exits non-zero when bootstrap fails before the turn, keeping a more specific code", () => {
    expect(mainSource).toContain(
      "if (process.exitCode === undefined) {",
    );
    const guard = mainSource.indexOf("if (process.exitCode === undefined) {");
    const bootstrapFailed = mainSource.indexOf('"bootstrap failed"');
    expect(bootstrapFailed).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(bootstrapFailed);
    expect(mainSource.slice(guard, guard + 200)).toContain(": EXEC_FAILURE_EXIT_CODE;");
  });

  it("exits non-zero after an interactive bootstrap failure without changing normal quits", () => {
    const failure = mainSource.slice(mainSource.indexOf('"bootstrap failed"'), mainSource.indexOf("app.quit();", mainSource.indexOf('"bootstrap failed"')));
    expect(failure).toContain("if (execRequest === null) guiBootstrapFailed = true;");
    expect(failure).toContain("if (process.exitCode === undefined) {");
    expect(failure).toContain("? GUI_BOOT_FAILURE_EXIT_CODE");
    expect(mainSource).toContain("if (execRequest === null && !guiBootstrapFailed) return;");
    expect(execModeSource).toMatch(/export const GUI_BOOT_FAILURE_EXIT_CODE = 1;/u);
  });

  it("runs after setServices and before the workspace is opened", () => {
    const setServices = mainSource.indexOf("setServices(services)");
    const execBranch = mainSource.indexOf("if (execRequest !== null)");
    const openSurface = mainSource.indexOf("const conversationSurfaceRuntime = createConversationSurfaceRuntime();");

    expect(setServices).toBeGreaterThanOrEqual(0);
    expect(execBranch).toBeGreaterThan(setServices);
    expect(openSurface).toBeGreaterThan(execBranch);
  });

  it("quits through before-quit cleanup rather than exiting hard", () => {
    const branch = extractExecBranch(mainSource);
    expect(branch, "could not locate the exec branch").not.toBeNull();
    expect(branch!).toMatch(/app\.quit\s*\(\s*\)/);
    expect(branch!, "a hard exit would skip runAppShutdownCleanup").not.toMatch(/app\.exit\s*\(/);
    expect(branch!).toMatch(/process\.exitCode\s*=/);
  });

  it("drains the shutdown hooks before the guards that can return early", () => {
    // Early quit can arrive before services exist; cleanup hooks must respect boot ordering.
    const handler = mainSource.indexOf('app.on("before-quit"');
    expect(handler).toBeGreaterThanOrEqual(0);
    const body = mainSource.slice(handler, mainSource.indexOf("\n});", handler));
    const hooks = body.indexOf("runShutdownHooks()");
    const servicesGuard = body.indexOf("if (!getServices()");
    expect(hooks).toBeGreaterThanOrEqual(0);
    expect(servicesGuard).toBeGreaterThan(hooks);
  });

  it("carries the chosen exit code through will-quit, after before-quit cleanup", () => {
    const handler = mainSource.indexOf('app.on("will-quit"');
    expect(handler).toBeGreaterThanOrEqual(0);
    const body = mainSource.slice(handler, handler + 400);
    expect(body, "desktop launches keep Electron's own exit").toMatch(/execRequest === null/);
    expect(body, "a run that chose no code keeps Electron's own exit").toMatch(
      /typeof process\.exitCode !== "number"/,
    );
    expect(body, "the default quit must be replaced by the chosen code").toMatch(/event\.preventDefault\(\)/);
    expect(body).toMatch(/app\.exit\(process\.exitCode\)/);
  });

  it("exits the lock-held case hard, before whenReady, with the retry code", () => {
    const lock = mainSource.indexOf("if (!gotSingleInstanceLock) {");
    const block = mainSource.slice(lock, mainSource.indexOf("} else {", lock));
    expect(block).toContain("app.exit(EXEC_LOCKED_EXIT_CODE)");
    expect(block).not.toContain("process.exitCode = EXEC_LOCKED_EXIT_CODE");
  });

  it("rejects a malformed command line before a window exists", () => {
    const usageBranch = mainSource.indexOf('"error" in execRequest');
    const createWindow = mainSource.indexOf("createWindow({");
    expect(usageBranch).toBeGreaterThanOrEqual(0);
    expect(createWindow).toBeGreaterThan(usageBranch);
  });

  it("derives the launch mode once and hands the same fact to the window and to boot", () => {
    expect(mainSource).toContain(
      'const bootLaunch = execRequest === null ? "interactive" : "headless";',
    );
    expect(mainSource).toContain('createWindow({ headless: bootLaunch === "headless" });');
    // Both consumers must use the same derived execution-mode value.
    expect(mainSource).toContain(
      "bootstrap(projectRoot, getMainWindow(), () => getMainWindow(), bootLaunch)",
    );
  });

  it("reports a held single-instance lock instead of exiting silently", () => {
    const lockBranch = mainSource.match(/if \(!gotSingleInstanceLock\) \{[\s\S]*?\n\} else \{/);
    expect(lockBranch, "could not locate the single-instance branch").not.toBeNull();
    expect(lockBranch![0]).toContain("EXEC_LOCKED_EXIT_CODE");
    // Use synchronous stderr because the next branch hard-exits and macOS pipes are asynchronous.
    expect(lockBranch![0]).toMatch(/writeSync\(\s*2,/);
  });

  it("keeps the plugin-smoke flag on its own path", () => {
    expect(mainSource).toContain("parsePluginSmokeFlag(process.argv)");
  });
});

describe("logger.ts — console destination in exec mode", () => {
  it("asks the exec predicate which descriptor it may use", () => {
    expect(loggerSource).toContain(
      'import { execModeRequested } from "../main/exec-mode.js"',
    );
    expect(loggerSource).toContain("execModeRequested(process.argv)");
  });

  it("sends both the JSON and the pretty console stream to stderr", () => {
    expect(loggerSource).toContain("execHeadless ? process.stderr : process.stdout");
    expect(loggerSource).toContain("destination: process.stderr");
  });
});

describe("main-window.ts — headless creation allocates no window", () => {
  it("returns before checking desktop assets or constructing a renderer", () => {
    const start = windowSource.indexOf("export function createWindow(");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = windowSource.slice(start);
    const guard = body.indexOf("if (options.headless) return null;");
    const preload = body.indexOf('preloadPreferences("preload")');
    const assetCheck = body.indexOf("existsSync(hostPreload.preload)");
    const window = body.indexOf("new BrowserWindow(");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(preload).toBeGreaterThan(guard);
    expect(assetCheck).toBeGreaterThan(preload);
    expect(window).toBeGreaterThan(assetCheck);
  });
});

describe("boot.ts — a headless run reports nobody at the desk", () => {
  function deskAttendedBody(): string {
    const start = bootSource.indexOf("isDeskAttended: () => {");
    expect(start, "isDeskAttended closure not found in boot.ts").toBeGreaterThan(-1);
    const end = bootSource.indexOf("\n      },", start);
    expect(end).toBeGreaterThan(start);
    return bootSource.slice(start, end);
  }

  it("answers no from the launch mode before consulting the window", () => {
    const body = deskAttendedBody();
    // Splash visibility and later window activation do not establish desk attendance.
    expect(body.indexOf("if (headless) return false;")).toBeGreaterThan(-1);
    expect(body.indexOf("if (headless) return false;")).toBeLessThan(
      body.indexOf("getMainWindow()"),
    );
  });

  it("still asks the window when a launch has an operator", () => {
    // Only headless runs may defer escalation; interactive launches must still ask the user.
    expect(deskAttendedBody()).toContain("win.isVisible() && !win.isMinimized()");
  });
});
