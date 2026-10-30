import { inspectSedScriptFileAccess } from "../permissions/reviewer/host-risk-inspector.js";
import type { PathEffect } from "../permissions/allowed-directories.js";
import { readShellOptionValue } from "./shell-option-value.js";

const SED_PROGRAM_OPTIONS = new Set(["-e", "--expression"]);
const SED_PATH_OPTIONS = new Set(["-f", "--file"]);
const SED_VALUE_OPTIONS = new Set([...SED_PROGRAM_OPTIONS, ...SED_PATH_OPTIONS]);

/** One argv binding supplies filesystem effects and already parsed executable bodies. */
export function classifySedArgumentSlots(argv: readonly string[]) {
  const nonPathIndices = new Set<number>();
  const programIndices = new Set<number>();
  const extraCandidates: { value: string; index: number; effect?: PathEffect }[] = [];
  const nestedCommands: { value: string; index: number }[] = [];
  let dynamicExecution: string | null = null;
  const inspectProgram = (value: string, index: number) => {
    programIndices.add(index);
    const access = inspectSedScriptFileAccess(value);
    nestedCommands.push(...access.execCommands.map(value => ({ value, index })));
    if (access.hasDynamicExec && dynamicExecution === null) {
      dynamicExecution = `Dynamic path: \`sed\` script \`${value}\` executes text that only exists while sed runs ` +
        "(`s///e`, or `e` with no command, run the pattern space), so the paths it uses cannot be " +
        "checked beforehand. Put the command in the shell call itself instead.";
    }
    if (access.hasWriteOrExec) extraCandidates.push(...access.fileOperands.map(({ value, effect }) => ({ value, index, effect })));
  };
  let programTaken = false, optionsEnded = false;
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (!optionsEnded && value === "--") { optionsEnded = true; continue; }
    if (!optionsEnded && value.startsWith("-") && value.length > 1) {
      const carried = readShellOptionValue(argv, index, SED_VALUE_OPTIONS);
      if (carried) {
        programTaken = true;
        const operand = carried.consumedNext ? index + 1 : index;
        nonPathIndices.add(index);
        nonPathIndices.add(operand);
        if (SED_PATH_OPTIONS.has(carried.option)) extraCandidates.push({ value: carried.value, index: operand });
        else inspectProgram(carried.value, operand);
        if (carried.consumedNext) index++;
      } else if (SED_VALUE_OPTIONS.has(value.split("=", 1)[0]!)) programTaken = true;
      continue;
    }
    if (!programTaken) {
      inspectProgram(value, index);
      nonPathIndices.add(index);
      programTaken = true;
    }
  }
  return { nonPathIndices, programIndices, extraCandidates, nestedCommands, dynamicExecution };
}
