import { readFileSync } from "node:fs";
import { basename, dirname, resolve, win32 } from "node:path";
import { windowsPathKindHelperIn } from "../main/windows-path-kind-launcher.js";
import { WINDOWS_WORKBOOK_HELPER_ENV } from "../shared/xlsx-edit.js";
import { editWorkbookFile } from "./xlsx-edit.js";
import { WorkbookJournalCompletionError } from "./xlsx-edit-journal.js";
import { errorMessage } from "../shared/error-message.js";

declare const __AVE_WINDOWS_PATH_KIND_SHA256__: string | null;

function windowsWorkbookHelper(): string {
  const bundleParent = dirname(__dirname);
  if (typeof __AVE_WINDOWS_PATH_KIND_SHA256__ === "undefined" && basename(bundleParent) === "dist") {
    return windowsPathKindHelperIn(resolve(bundleParent, "../resources"));
  }
  const handoff = process.env[WINDOWS_WORKBOOK_HELPER_ENV];
  if (typeof __AVE_WINDOWS_PATH_KIND_SHA256__ === "string") {
    const prefix = `${__AVE_WINDOWS_PATH_KIND_SHA256__}:`;
    if (handoff?.startsWith(prefix)) {
      const helper = handoff.slice(prefix.length);
      if (/^\\\\\?\\GLOBALROOT\\Device\\HarddiskVolume[0-9]+\\/iu.test(helper)
        && win32.normalize(helper) === helper && win32.basename(helper) === "ave-path-kind.exe") return helper;
    }
  }
  throw new Error("Windows workbook helper could not be verified. [workbook-acl-unreadable]");
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (args.length !== 2) throw new Error("Expected workbook and request paths.");
    const windowsAccessHelper = process.platform === "win32" ? windowsWorkbookHelper() : undefined;
    const request: unknown = JSON.parse(readFileSync(args[1]!, "utf8"));
    console.log(JSON.stringify(await editWorkbookFile(args[0]!, request, { windowsAccessHelper })));
    return 0;
  } catch (error) {
    const saved = error instanceof WorkbookJournalCompletionError;
    console.error(`${saved ? "XLSX edit saved with observation error" : "XLSX edit refused"}: ${errorMessage(error)}`);
    return saved ? 2 : 1;
  }
}

void main().then((code) => { process.exitCode = code; });
