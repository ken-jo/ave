import { readFileSync } from "node:fs";
import { editWorkbookFile } from "./xlsx-edit.js";
import { WorkbookJournalCompletionError } from "./xlsx-edit-journal.js";
import { errorMessage } from "../shared/error-message.js";

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (args.length !== 2) throw new Error("Expected workbook and request paths.");
    const request: unknown = JSON.parse(readFileSync(args[1]!, "utf8"));
    console.log(JSON.stringify(await editWorkbookFile(args[0]!, request)));
    return 0;
  } catch (error) {
    const saved = error instanceof WorkbookJournalCompletionError;
    console.error(`${saved ? "XLSX edit saved with observation error" : "XLSX edit refused"}: ${errorMessage(error)}`);
    return saved ? 2 : 1;
  }
}

void main().then((code) => { process.exitCode = code; });
