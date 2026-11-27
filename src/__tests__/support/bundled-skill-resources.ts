import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { windowsPathKindHelperIn } from "../../main/windows-path-kind-launcher.js";

export function stageWindowsPathKindHelper(resourcePath: string): void {
  if (process.platform !== "win32") return;
  const helper = windowsPathKindHelperIn(resourcePath);
  mkdirSync(dirname(helper), { recursive: true });
  copyFileSync(windowsPathKindHelperIn(resolve("resources")), helper);
}
