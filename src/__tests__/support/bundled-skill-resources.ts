import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { windowsPathKindHelperIn, windowsWorkbookLockerBindingIn } from "../../main/windows-path-kind-launcher.js";

export function stageWindowsWorkbookLockerBinding(resourcePath: string, isPackaged: boolean): void {
  if (process.platform !== "win32") return;
  const destination = windowsWorkbookLockerBindingIn(resourcePath, isPackaged);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(windowsWorkbookLockerBindingIn(resolve("resources"), false), destination);
}

export function stageWindowsPathKindHelper(resourcePath: string): void {
  if (process.platform !== "win32") return;
  const helper = windowsPathKindHelperIn(resourcePath);
  mkdirSync(dirname(helper), { recursive: true });
  copyFileSync(windowsPathKindHelperIn(resolve("resources")), helper);
}
