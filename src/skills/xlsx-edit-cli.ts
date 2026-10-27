import { readFileSync } from "node:fs";
import { editWorkbookFile, inspectWorkbookCell } from "./xlsx-edit.js";
import { readWorkbookSnapshot } from "./xlsx-file-transaction.js";
import { errorMessage } from "../shared/error-message.js";

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const inspect = args[0] === "--inspect";
    if (args.length !== (inspect ? 3 : 2)) throw new Error("Expected workbook and request paths.");
    const operands = inspect ? args.slice(1) : args;
    const request: unknown = JSON.parse(readFileSync(operands[1]!, "utf8"));
    console.log(JSON.stringify(inspect ? inspectWorkbookCell(readWorkbookSnapshot(operands[0]!).data, request)
      : await editWorkbookFile(operands[0]!, request)));
    return 0;
  } catch (error) {
    console.error(`XLSX edit refused: ${errorMessage(error)}`);
    return 1;
  }
}

void main().then((code) => { process.exitCode = code; });
