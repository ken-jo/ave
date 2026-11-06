import { parseStagedEnvelope } from "../shared/staged-origins.js";

export type RouteResult =
  | { route: "command"; command: string; args: string }
  | { route: "llm"; input: string };

/** Classify only host command syntax; skills do not route by keywords. */
export function routeInput(input: string): RouteResult {
  const trimmed = input.trim();

  // Imported plugin and app envelopes are staged data, never user-authored command syntax.
  if (parseStagedEnvelope(trimmed) !== null) {
    return { route: "llm", input: trimmed };
  }

  const commandMatch = trimmed.match(/^\/(\S+)\s*(.*)?$/s);
  if (commandMatch) {
    return {
      route: "command",
      command: commandMatch[1],
      args: commandMatch[2]?.trim() ?? "",
    };
  }

  return { route: "llm", input: trimmed };
}
