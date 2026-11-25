import { maskSensitiveData } from "../../shared/dlp.js";
import { isRecord } from "../../shared/is-record.js";

const MAX_REASON_CHARS = 400;

export const MODEL_VERDICT_PROMPT_SUFFIX = [
  "Judge whether your own work met this stage's goal. Use pass only if the results support it.",
  "End your final message with exactly one fenced JSON block in this format:",
  "```json",
  '{"verdict":"pass","reason":"Briefly explain the result."}',
  "```",
  `Use exactly the keys "verdict" and "reason". The verdict must be "pass" or "fail" and the reason must be a nonempty string of at most ${MAX_REASON_CHARS} characters.`,
  "You may report your results before the block. Put no other JSON block in the message and no text after the verdict.",
].join("\n");

function verdict(passed: boolean, evidence: string) {
  return { passed, evidence, judgedBy: "model" as const };
}

function terminalVerdictBody(output: string): string | undefined {
  let enclosingFence: string | undefined;
  let verdictStart: number | undefined;
  // Still count JSON fences inside quotes or sample code, so quoted examples cannot become verdicts.
  const fenceLines = /^([ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})([^\r\n]*)/gm;
  for (const line of output.matchAll(fenceLines)) {
    const [, prefix, marker, info] = line;
    const topLevel = /^ {0,3}$/.test(prefix);
    if (/^[ \t]*json(?:[ \t]|$)/i.test(info)) {
      if (verdictStart !== undefined || enclosingFence !== undefined || !topLevel || marker !== "```" || !/^json[ \t]*$/.test(info)) return undefined;
      verdictStart = line.index;
    } else if (verdictStart === undefined && topLevel) {
      if (enclosingFence === undefined) enclosingFence = marker;
      else if (marker[0] === enclosingFence[0] && marker.length >= enclosingFence.length && /^[ \t]*$/.test(info)) enclosingFence = undefined;
    }
  }
  if (verdictStart === undefined) return undefined;
  return /^ {0,3}```json[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}```$/.exec(output.slice(verdictStart).trimEnd())?.[1];
}

export function evaluateModelVerdict(output: string): ReturnType<typeof verdict> {
  const body = terminalVerdictBody(output);
  if (body === undefined) return verdict(false, "verdict-unreadable");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return verdict(false, "verdict-unreadable");
  }
  if (!isRecord(value) || Object.keys(value).length !== 2 || (value.verdict !== "pass" && value.verdict !== "fail")
    || typeof value.reason !== "string" || value.reason.length > MAX_REASON_CHARS || !value.reason.trim() || value.reason.includes("\0")) {
    return verdict(false, "verdict-unreadable");
  }
  // The object has two string fields. Count colons outside JSON strings to catch repeated keys hidden by JSON.parse.
  const separators = body.match(/"(?:[^"\\]|\\.)*"|:/gs)?.filter(token => token === ":");
  if (separators?.length !== 2) return verdict(false, "verdict-unreadable");
  return verdict(value.verdict === "pass", maskSensitiveData(value.reason.trim()).masked.slice(0, MAX_REASON_CHARS));
}
