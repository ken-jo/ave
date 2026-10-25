// External commands require an absolute executable, direct argv spawn and a minimal env; redact bounded stderr for audit only. URL transport permits HTTPS or loopback HTTP and refuses redirects. Only redacted requests leave the process; nonzero exits and non-schema responses fail.
import { spawn } from "node:child_process";
import { errorMessage } from "../../shared/error-message.js";
import {
  JudgeFailure,
  type JudgeFailureKind,
  type JudgeRequest,
  type JudgeVerdict,
  type PermissionJudge,
} from "./judge-contract.js";
import { redactJudgeRequest, redactJudgeText } from "./judge-redaction.js";
import { checkExternalCommand, checkExternalEnv, checkExternalUrl, type JudgeExternalSettings } from "./judge-settings.js";

const EXTERNAL_JUDGE_PROTOCOL_VERSION = 1;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const MAX_RATIONALE_CHARS = 2_000;
const MAX_SUGGESTED_RULE_CHARS = 500;
const VERDICT_KEYS = new Set(["decision", "rationale", "confidence", "suggestedRule"]);

function unparseable(why: string): JudgeFailure {
  return new JudgeFailure("unparseable", `external judge response ${why}`);
}

// Strict verdict schema: `{decision, rationale, confidence?, suggestedRule?}` and nothing else.
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

// Base variables every command judge receives; nothing else is inherited.
const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "TMPDIR"] as const;
// Windows cannot start most programs without these.
const WINDOWS_ENV_KEYS = ["SystemRoot", "TEMP", "TMP", "USERPROFILE"] as const;

export function buildExternalJudgeEnv(
  configured: readonly string[] | undefined,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const keys = [...BASE_ENV_KEYS, ...(platform === "win32" ? WINDOWS_ENV_KEYS : []), ...(configured ?? [])];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runCommand(argv: readonly string[], env: Record<string, string>, body: string, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    // POSIX: own process group, so a timeout kills every process the judge started.
    const detached = process.platform !== "win32";
    const child = spawn(argv[0]!, argv.slice(1), { shell: false, env, detached, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const killTree = (): void => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Group already gone; fall through to the direct kill.
        }
      }
      child.kill("SIGKILL");
    };
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let size = 0;
    let errSize = 0;
    let settled = false;
    const stderrText = (): string => redactJudgeText(Buffer.concat(errChunks).toString("utf8"), MAX_STDERR_BYTES);
    const fail = (kind: JudgeFailureKind, message: string): JudgeFailure =>
      new JudgeFailure(kind, message, { diagnostics: { stderr: stderrText() } });
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      killTree();
      finish(() => reject(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => finish(() => reject(fail("unavailable", `external judge failed to start: ${err.message}`))));
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep only the first MAX_STDERR_BYTES; stderr is a diagnostic, never a verdict.
      if (errSize >= MAX_STDERR_BYTES) return;
      const room = MAX_STDERR_BYTES - errSize;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      errChunks.push(kept);
      errSize += kept.length;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        killTree();
        finish(() => reject(fail("unparseable", "external judge response exceeds size limit")));
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(() => reject(fail("error", `external judge exited with code ${String(code)}`)));
        return;
      }
      finish(() => resolve({ stdout: Buffer.concat(chunks).toString("utf8"), stderr: stderrText() }));
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
    throw new JudgeFailure("unavailable", `external judge unreachable: ${errorMessage(err)}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new JudgeFailure("error", `external judge HTTP ${response.status}`);
  }
  return readCappedBody(response, signal);
}

// Stream the body and stop at MAX_RESPONSE_BYTES; never buffers more.
async function readCappedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        throw new JudgeFailure("error", `external judge response stream failed: ${errorMessage(err)}`);
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw unparseable("exceeds size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class ExternalJudge implements PermissionJudge {
  readonly version: string;

  constructor(
    private readonly config: JudgeExternalSettings,
    private readonly fetchImpl?: JudgeFetch,
    // Stage id from settings, e.g. `jev`.
    readonly id: string = "external",
  ) {
    const hasCommand = config.command !== undefined;
    const hasUrl = config.url !== undefined;
    if (hasCommand === hasUrl) throw new Error("ExternalJudge requires exactly one of command or url");
    const err = hasCommand
      ? checkExternalCommand(config.command) ?? (config.env === undefined ? null : checkExternalEnv(config.env))
      : config.env !== undefined
        ? "env applies to the command transport only"
        : checkExternalUrl(config.url);
    if (err) throw new Error(`ExternalJudge: ${err}`);
    if (hasUrl && !fetchImpl) throw new Error("ExternalJudge: url transport requires a fetch implementation");
    this.version = `${EXTERNAL_JUDGE_PROTOCOL_VERSION}:${hasCommand ? "command" : "url"}`;
  }

  async judge(request: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict> {
    const body = JSON.stringify({ version: EXTERNAL_JUDGE_PROTOCOL_VERSION, request: redactJudgeRequest(request) });
    if (!this.config.command) {
      return parseJudgeResponse((await postUrl(this.fetchImpl!, this.config.url!, body, signal)).trim());
    }
    const { stdout, stderr } = await runCommand(this.config.command, buildExternalJudgeEnv(this.config.env), body, signal);
    const diagnostics = stderr.length > 0 ? { stderr } : undefined;
    let verdict: JudgeVerdict;
    try {
      verdict = parseJudgeResponse(stdout.trim());
    } catch (err) {
      if (err instanceof JudgeFailure && diagnostics) {
        throw new JudgeFailure(err.kind, err.message, { diagnostics });
      }
      throw err;
    }
    return diagnostics ? { ...verdict, diagnostics } : verdict;
  }
}
