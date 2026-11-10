import { execFile } from "node:child_process";
import { platform } from "node:os";
import type { TestInfo } from "@playwright/test";
import type { ElectronApplication } from "playwright";

const FRONTMOST_APPLICATION = "ObjC.import('AppKit'); const a=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({name:a?ObjC.unwrap(a.localizedName):null,pid:a?Number(a.processIdentifier):null,bundle:a?ObjC.unwrap(a.bundleIdentifier):null,active:a?!!a.active:false});";

function readCommand(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function desktopFocus() {
  const os = platform();
  if (os !== "darwin") return { platform: os };
  try {
    const [front, consoleState] = await Promise.all([
      readCommand("/usr/bin/osascript", ["-l", "JavaScript", "-e", FRONTMOST_APPLICATION]),
      readCommand("/usr/sbin/ioreg", ["-l", "-n", "Root", "-d1"]),
    ]);
    const lockedTime = /"CGSSessionScreenLockedTime"=(\d+)/.exec(consoleState)?.[1];
    return {
      platform: os,
      frontmost: JSON.parse(front) as unknown,
      locked: /"CGSSessionScreenIsLocked"=Yes/.test(consoleState),
      lockedAt: lockedTime ? new Date(Number(lockedTime) * 1000).toISOString() : null,
    };
  } catch (error) { return { platform: os, unavailable: error instanceof Error ? error.message : String(error) }; }
}

/** Preserve the original focus assertion and collect evidence only when it fails. */
export async function withNativeFocusDiagnostics<T>(
  app: ElectronApplication,
  testInfo: Pick<TestInfo, "attach">,
  verifyFocus: () => Promise<T>,
): Promise<T> {
  try { return await verifyFocus(); }
  catch (error) {
    const windows = await app.evaluate(({ BaseWindow, webContents }) => ({
      focusedWindowId: BaseWindow.getFocusedWindow()?.id ?? null,
      windows: BaseWindow.getAllWindows().map((window) => {
        const chrome = webContents.getAllWebContents().find(contents => contents === Reflect.get(window, "webContents"));
        return {
          id: window.id, visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(),
          modal: window.isModal(), parentId: window.getParentWindow()?.id ?? null,
          chromeId: chrome?.id ?? null,
          contentsFocused: chrome?.isFocused() ?? false,
          mainFrameFocused: chrome !== undefined && chrome.focusedFrame === chrome.mainFrame,
        };
      }),
    })).catch((inspectionError: unknown) => ({ unavailable: inspectionError instanceof Error ? inspectionError.message : String(inspectionError) }));
    const diagnostic = { at: new Date().toISOString(), expectedPid: app.process().pid, desktop: await desktopFocus(), native: windows };
    const body = JSON.stringify(diagnostic, null, 2);
    process.stderr.write(`[native-focus] ${body}\n`);
    await testInfo.attach("native-focus-diagnostics", { body, contentType: "application/json" }).catch(() => {});
    throw error;
  }
}
