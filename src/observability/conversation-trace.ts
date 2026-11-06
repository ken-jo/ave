



import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { aveHome } from "../shared/ave-home.js";


export type TraceStepName =
  | "REQUEST_ENTRY"         // 1. renderer → main IPC
  | "ROUTE_RESOLVE"         // 2. Resolve the input route
  | "TURN_ORCHESTRATE"      // 3. Enter runTurn()
  | "HISTORY_APPEND"        // 4. Append user message
  | "PROMPT_ASSEMBLE"       // 5. Assemble system prompt
  | "LLM_STREAM"            // 6. Start provider.streamTurn
  | "LLM_STREAM_ERROR"      // 6b. Structure provider.streamTurn error
  | "TOOL_SCHEMA_REJECTED"  // 6c. provider 400(invalid_function_parameters) -> drop tool and retry round
  | "REASONING_ACCUMULATE"  // 7. Finish accumulating reasoning_delta for the round
  | "TOOL_EXECUTE"          // 8. ToolExecutor.executeAll
  | "ROUND_COMMIT"          // 9. Commit assistant_round
  | "POST_TURN"             // 10. PostTurnHookChain.run
  | "GUIDANCE_INJECTED"     // out-of-band — mid-stream "guide" utterance consumed at round boundary
  | "LENGTH_CONTINUATION"   // out-of-band — finish_reason=length truncation -> continue partial answer verbatim (vLLM continue_final_message)
  | "REASONING_ONLY_CONTINUATION" // out-of-band — end_turn round with reasoning but no answer and no tool call -> re-prompt for the action the reasoning named
  | "PREFLIGHT_GUARD"       // out-of-band — runPreflightGuard decision: fired / skipped / not-reached, and why
  | "COMPACTION_RESULT";    // out-of-band — outcome of an LLM compaction triggered by PREFLIGHT_GUARD: applied / noop / error

export interface TraceEntry {
  ts: string;
  sessionId: string;
  step: TraceStepName;
  meta?: Record<string, unknown>;
}

export interface ConversationTracer {
  step(name: TraceStepName, meta?: Record<string, unknown>): void;
  readonly enabled: boolean;
  readonly filePath?: string;
}

class NullTracer implements ConversationTracer {
  readonly enabled = false;
  step(): void {
    /* no-op */
  }
}

class FileTracer implements ConversationTracer {
  readonly enabled = true;
  readonly filePath: string;
  private readonly sessionId: string;

  constructor(sessionId: string, traceDir: string) {
    this.sessionId = sessionId;
    if (!existsSync(traceDir)) {
      mkdirSync(traceDir, { recursive: true });
    }
    this.filePath = join(traceDir, `${sessionId}.jsonl`);
  }

  step(name: TraceStepName, meta?: Record<string, unknown>): void {
    try {
      const entry: TraceEntry = {
        ts: new Date().toISOString(),
        sessionId: this.sessionId,
        step: name,
        ...(meta && { meta }),
      };
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Trace 실패가 대화 흐름을 차단하면 안 됨
    }
  }
}

/**
 * Tracer 활성 여부 — dev 모드 또는 AVE_TRACE=1 환경변수.
 * 프로덕션에서는 기본 no-op. sampling 은 상위 호출자가 결정.
 */
function isTraceEnabled(): boolean {
  if (process.env.AVE_TRACE === "1") return true;
  return process.env.NODE_ENV !== "production";
}

/**
 * 세션별 tracer 생성. 비활성화 시 NullTracer 반환.
 * 테스트 주입을 위해 traceDir override 가능.
 */
export function createTracer(
  sessionId: string,
  opts?: { enabled?: boolean; traceDir?: string },
): ConversationTracer {
  const enabled = opts?.enabled ?? isTraceEnabled();
  if (!enabled) return new NullTracer();
  const dir = opts?.traceDir ?? join(aveHome(), "traces");
  return new FileTracer(sessionId, dir);
}
