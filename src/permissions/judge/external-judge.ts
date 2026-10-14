/**
 * `external` judge provider — the connection point for an out-of-process judge
 * model (e.g. jev). Two transports:
 *
 *   - command: argv array with an absolute executable, spawned WITHOUT a shell.
 *     The request is one JSON document on stdin; the verdict is one JSON
 *     document on stdout. Non-zero exit is an error.
 *   - url: HTTPS (or loopback HTTP) POST of the same JSON document; the
 *     response body is the verdict. Redirects are refused.
 *
 * Only the DLP-redacted request ({@link redactJudgeRequest}) is sent. The
 * response is validated strictly ({@link parseJudgeResponse}); anything that is
 * not exactly the verdict schema is `unparseable`.
 */
import { spawn } from "node:child_process";
import { JudgeFailure, type JudgeRequest, type JudgeVerdict, type PermissionJudge } from "./judge-contract.js";
import { redactJudgeRequest } from "./judge-redaction.js";
import { checkExternalCommand, checkExternalUrl, type JudgeExternalSettings } from "./judge-settings.js";

export const EXTERNAL_JUDGE_PROTOCOL_VERSION = 1;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RATIONALE_CHARS = 2_000;
const MAX_SUGGESTED_RULE_CHARS = 500;
const VERDICT_KEYS = new Set(["decision", "rationale", "confidence", "suggestedRule"]);

function unparseable(why: string): JudgeFailure {
  return new JudgeFailure("unparseable", `external judge response ${why}`);
}

/** Strict verdict schema: `{decision, rationale, confidence?, suggestedRule?}` and nothing else. */
export function parseJudgeResponse(text: string): JudgeVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unparseable("is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unparseable("is not an object");
  const obj = parsed as Record<string, unknown>;
  const extra = Object.keys(obj).filter((k) => !VERDICT_KEYS.has(k));
  if (extra.length > 0) throw unparseable(`has unknown keys: ${extra.join(", ")}`);
  if (obj.decision !== "allow" && obj.decision !== "ask" && obj.decision !== "deny") {
    throw unparseable("decision must be allow | ask | deny");
  }
  if (typeof obj.rationale !== "string" || obj.rationale.trim().length === 0) {
    throw unparseable("rationale must be a non-empty string");
  }
  if (obj.rationale.length > MAX_RATIONALE_CHARS) throw unparseable("rationale too long");
  const verdict: JudgeVerdict = { decision: obj.decision, rationale: obj.rationale };
  if (obj.confidence !== undefined) {
    if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) {
      throw unparseable("confidence must be a number in [0, 1]");
    }
    verdict.confidence = obj.confidence;
  }
  if (obj.suggestedRule !== undefined) {
    if (
      typeof obj.suggestedRule !== "string" ||
      obj.suggestedRule.trim().length === 0 ||
      obj.suggestedRule.length > MAX_SUGGESTED_RULE_CHARS
    ) {
      throw unparseable("suggestedRule must be a non-empty string");
    }
    verdict.suggestedRule = obj.suggestedRule;
  }
  return verdict;
}

export type JudgeFetch = (url: string, init: RequestInit) => Promise<Response>;

function runCommand(argv: readonly string[], body: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(argv[0]!, argv.slice(1), { shell: false, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      child.kill("SIGKILL");
      finish(() => reject(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => finish(() => reject(new JudgeFailure("unavailable", `external judge failed to start: ${err.message}`))));
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(unparseable("exceeds size limit")));
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(() => reject(new JudgeFailure("error", `external judge exited with code ${String(code)}`)));
        return;
      }
      finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    child.stdin.on("error", () => {
      // EPIPE when the judge exits without reading; the close handler reports it.
    });
    child.stdin.end(body);
  });
}

async function postUrl(fetchImpl: JudgeFetch, url: string, body: string, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    throw new JudgeFailure("unavailable", `external judge unreachable: ${(err as Error).message}`);
  }
  if (!response.ok) throw new JudgeFailure("error", `external judge HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw unparseable("exceeds size limit");
  return text;
}

export class ExternalJudge implements PermissionJudge {
  readonly id = "external";
  readonly version: string;

  constructor(
    private readonly config: JudgeExternalSettings,
    private readonly fetchImpl?: JudgeFetch,
  ) {
    const hasCommand = config.command !== undefined;
    const hasUrl = config.url !== undefined;
    if (hasCommand === hasUrl) throw new Error("ExternalJudge requires exactly one of command or url");
    const err = hasCommand ? checkExternalCommand(config.command) : checkExternalUrl(config.url);
    if (err) throw new Error(`ExternalJudge: ${err}`);
    if (hasUrl && !fetchImpl) throw new Error("ExternalJudge: url transport requires a fetch implementation");
    this.version = `${EXTERNAL_JUDGE_PROTOCOL_VERSION}:${hasCommand ? "command" : "url"}`;
  }

  async judge(request: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict> {
    const body = JSON.stringify({ version: EXTERNAL_JUDGE_PROTOCOL_VERSION, request: redactJudgeRequest(request) });
    const text = this.config.command
      ? await runCommand(this.config.command, body, signal)
      : await postUrl(this.fetchImpl!, this.config.url!, body, signal);
    return parseJudgeResponse(text.trim());
  }
}
