import { parseStagedEnvelope } from "../shared/staged-origins.js";

export type InputClassification =
  | { type: "command"; command: string; args: string }
  | { type: "general"; input: string };

/** Classify only host command syntax; skills do not route by keywords. */
export class InputClassifier {
  classify(input: string): InputClassification {
    const trimmed = input.trim();

    // Imported plugin and app envelopes are staged data, never user-authored command syntax.
    if (parseStagedEnvelope(trimmed) !== null) {
      return { type: "general", input: trimmed };
    }

    const commandMatch = trimmed.match(/^\/(\S+)\s*(.*)?$/s);
    if (commandMatch) {
      return {
        type: "command",
        command: commandMatch[1],
        args: commandMatch[2]?.trim() ?? "",
      };
    }

    return { type: "general", input: trimmed };
  }
}
