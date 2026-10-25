// FIFO questions appear in the composer dock; this broker does not enforce permission policy.
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { NotificationService } from "./notification-service.js";
import { createLogger } from "../lib/logger.js";
import {
  MAX_FREE_TEXT_LENGTH,
  MAX_PLACEHOLDER_LENGTH,
} from "../shared/ask-user-question-limits.js";
import { t } from "../i18n/index.js";
const log = createLogger("ave");

// Multi-question cards paginate answers and show a final review page.
export interface AskUserQuestionItem {
  question: string;
  // Up to 3 visible choices, each ≤ 20 Korean chars. Empty only when `allowFreeText` is set — every question must offer at least one way to answer, and a
  // free-text field is one.
  choices: string[];
  // Index of the model's top recommendation in `choices` (0 or 1 across the array).
  recommendedIndex?: number;
  // Indices in `choices` of secondary recommendations (disjoint with recommendedIndex).
  altIndices?: number[];
  allowMultiple?: boolean;
  // Render a free-text field as the last answer row. This is the only way a typed answer exists: a choice label is a button, so a model that wants typing
  // has to ask for the field rather than name it in `choices`.
  allowFreeText?: boolean;
  // Placeholder for the free-text field (≤ 40 chars). Only read when `allowFreeText`.
  placeholder?: string;
  // Confirm-step row label override (≤ 10 Korean chars). Falls back to a truncated question.
  summaryHint?: string;
}

export interface AskUserQuestionRequest {
  id: string;
  // Window-wide requests must name the asking conversation so only its tile draws and resolves the card.
  sessionId: string;
  questions: AskUserQuestionItem[];
  createdAt: number;
}

// One answer inside a multi-question response.
export interface AskUserQuestionAnswer {
  // Single-select selected label. Mutually exclusive with `choices`.
  choice?: string;
  // Multi-select selected labels (only present when the question was declared `allowMultiple: true`). Always a fresh array in request order; empty array
  // is normalized to undefined upstream.
  choices?: string[];
  // What the user typed, present only for a question that declared `allowFreeText`. Kept in its own field rather than folded into `choice`/`choices` so
  // the reader of the result can always tell a label the model itself wrote from text the user typed.
  freeText?: string;
}

export interface AskUserQuestionResponse {
  requestId: string;
  // Per-question answers, in the same order as the request's `questions`. Length matches `questions.length` when the card is confirmed.
  answers?: AskUserQuestionAnswer[];
  // Card-level dismissal — every question abandoned at once.
  dismissed?: boolean;
}

// 1–4 questions per card. Cap is shared between tool input validation and gate.
export const MAX_QUESTIONS_PER_CARD = 4;

export const IPC_ASK_USER_QUESTION_REQUEST = "ave:ask-user-question:request";
export const IPC_ASK_USER_QUESTION_RESPOND = "ave:ask-user-question:respond";

interface PendingEntry {
  request: AskUserQuestionRequest;
  // Every renderer the card reached: the one it was sent to, plus each one that read it back through {@link AskUserQuestionGate.listPending}. When the
  // question ends — answered in any of them, cancelled or timed out — all of them are told, so no copy is left on screen as a dead card.
  deliveredTo: Set<WebContents>;
  resolve: (response: AskUserQuestionResponse) => void;
  // Every terminal path clears timer, abort listener, and pending state to prevent leaks on reused controllers.
  cleanup: () => void;
}

function normalizeQuestion(value: unknown): AskUserQuestionItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const question = value as Record<string, unknown>;
  if (typeof question.question !== "string" || question.question.trim().length === 0) return null;
  const allowFreeText = question.allowFreeText === true;
  if (!Array.isArray(question.choices) || question.choices.length > 3) return null;
  // A question with neither chips nor a typed field renders with no answer at all, leaving the user only the skip button.
  if (question.choices.length === 0 && !allowFreeText) return null;
  if (
    question.choices.some(
      (choice) =>
        typeof choice !== "string" ||
        choice.trim().length === 0 ||
        choice.trim().length > 20,
    )
  ) {
    return null;
  }

  const choices = question.choices.map((choice) => (choice as string).trim());
  if (new Set(choices).size !== choices.length) return null;
  const recommendedIndex =
    Number.isInteger(question.recommendedIndex) &&
    Number(question.recommendedIndex) >= 0 &&
    Number(question.recommendedIndex) < choices.length
      ? Number(question.recommendedIndex)
      : undefined;
  const altIndices = Array.isArray(question.altIndices)
    ? [...new Set(question.altIndices.filter(
        (index): index is number =>
          Number.isInteger(index) &&
          Number(index) >= 0 &&
          Number(index) < choices.length &&
          Number(index) !== recommendedIndex,
      ).map(Number))]
    : undefined;

  const placeholder =
    typeof question.placeholder === "string" ? question.placeholder.trim() : "";

  return {
    question: question.question.trim(),
    choices,
    recommendedIndex,
    altIndices: altIndices && altIndices.length > 0 ? altIndices : undefined,
    allowMultiple: question.allowMultiple === true ? true : undefined,
    allowFreeText: allowFreeText ? true : undefined,
    placeholder:
      allowFreeText && placeholder.length > 0 && placeholder.length <= MAX_PLACEHOLDER_LENGTH
        ? placeholder
        : undefined,
    summaryHint:
      typeof question.summaryHint === "string" && question.summaryHint.trim().length > 0
        ? question.summaryHint.trim()
        : undefined,
  };
}

function normalizeResponse(
  request: AskUserQuestionRequest,
  response: AskUserQuestionResponse,
): AskUserQuestionResponse | null {
  if (response.dismissed === true) {
    return { requestId: request.id, dismissed: true };
  }
  if (!Array.isArray(response.answers) || response.answers.length !== request.questions.length) {
    return null;
  }

  const answers: AskUserQuestionAnswer[] = [];
  for (const [index, question] of request.questions.entries()) {
    const answer = response.answers[index];
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;

    // Typed text is bound to the request the same way a label is: it is admissible only where the question asked for the field, so a renderer cannot invent
    // an answer channel the model never opened.
    let freeText: string | undefined;
    if (answer.freeText !== undefined) {
      if (question.allowFreeText !== true) return null;
      if (typeof answer.freeText !== "string") return null;
      const typed = answer.freeText.trim();
      if (typed.length === 0 || typed.length > MAX_FREE_TEXT_LENGTH) return null;
      freeText = typed;
    }
    const typedPart = freeText !== undefined ? { freeText } : {};

    if (question.allowMultiple) {
      if (answer.choices !== undefined && !Array.isArray(answer.choices)) return null;
      const picked = answer.choices ?? [];
      if (picked.some((choice) => typeof choice !== "string" || !question.choices.includes(choice))) {
        return null;
      }
      const selected = new Set(picked);
      if (selected.size !== picked.length) return null;
      if (selected.size === 0 && freeText === undefined) return null;
      const chosen = question.choices.filter((choice) => selected.has(choice));
      answers.push({ ...(chosen.length > 0 ? { choices: chosen } : {}), ...typedPart });
      continue;
    }

    if (answer.choice !== undefined) {
      if (typeof answer.choice !== "string" || !question.choices.includes(answer.choice)) return null;
      answers.push({ choice: answer.choice, ...typedPart });
      continue;
    }
    if (freeText === undefined) return null;
    answers.push(typedPart);
  }

  return { requestId: request.id, answers };
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// Per-session cap on concurrent pending questions. Without this, a misbehaving assistant could chain many `ask_user_question` calls in one turn and bury
// the renderer in cards. 5 is generous for legitimate workflows (decision tree branches) and tight enough that abuse is obvious.
const MAX_CONCURRENT_PENDING = 5;
// Notify every renderer when a question ends so copies in other windows cannot remain answerable.
export const IPC_ASK_USER_QUESTION_TIMEOUT = "ave:ask-user-question:timeout";

// Resolve live webContents for each send, preferring the asking session’s window, then primary or last-focused main window.
export type WebContentsResolver = (sessionId: string) => WebContents | null;

export class AskUserQuestionGate {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly timeoutMs: number;
  private readonly notificationService?: NotificationService;
  private readonly resolveWebContents: WebContentsResolver;

  constructor(
    webContents: WebContents | WebContentsResolver,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    notificationService?: NotificationService,
  ) {
    this.timeoutMs = timeoutMs;
    this.notificationService = notificationService;
    // Accept either a direct WebContents (legacy/tests) or a resolver function. Direct WebContents is wrapped so the rest of the gate talks to one shape.
    this.resolveWebContents = typeof webContents === "function"
      ? (webContents as WebContentsResolver)
      : () => (webContents.isDestroyed() ? null : webContents);
  }

  ask(input: {
    // 1–4 questions to ask in a single composer-dock card. Anything outside that range is rejected up-front so the renderer never has to defend against
    // malformed multi-question shapes.
    questions: AskUserQuestionItem[];
    // Conversation the asking turn belongs to; routes the card to its tile.
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<AskUserQuestionResponse> {
    if (!Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > MAX_QUESTIONS_PER_CARD) {
      return Promise.resolve({
        requestId: "",
        dismissed: true,
      });
    }
    const normalizedQuestions = input.questions.map(normalizeQuestion);
    if (normalizedQuestions.some((question) => question === null)) {
      return Promise.resolve({ requestId: "", dismissed: true });
    }
    const req: AskUserQuestionRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      questions: normalizedQuestions as AskUserQuestionItem[],
      createdAt: Date.now(),
    };
    // Enforce concurrent-pending cap before scheduling anything.
    if (this.pending.size >= MAX_CONCURRENT_PENDING) {
      return Promise.resolve({
        requestId: req.id,
        dismissed: true,
      });
    }
    const wc = this.resolveWebContents(req.sessionId);
    if (!wc) {
      return Promise.resolve({ requestId: req.id, dismissed: true });
    }
    if (input.abortSignal?.aborted) {
      return Promise.resolve({ requestId: req.id, dismissed: true });
    }
    try {
      // For a single question we surface the prompt verbatim; for a multi-question card we surface the count + first prompt so the OS-toast preview is
      // informative but not flooded.
      const previewBody =
        req.questions.length === 1
          ? req.questions[0].question
          : t("be_askUserQuestionGate.multiQuestionPreview", { count: String(req.questions.length), first: req.questions[0].question });
      this.notificationService?.fire({
        kind: "ask-user",
        title: t("be_askUserQuestionGate.notificationTitle"),
        body: previewBody,
        contextRef: { questionId: req.id },
      });
    } catch {
      // notification failure must never block the gate
    }
    return new Promise<AskUserQuestionResponse>((resolve) => {
      const deliveredTo = new Set<WebContents>([wc]);
      // Tell every renderer the card reached — and whichever renderer shows the session by now — that it is no longer answerable, so each drops its copy.
      // Best-effort: a renderer may be tearing down.
      const announceStale = () => {
        // Nothing here may throw: the caller resolves the gate right after, and a throw would leave the asking turn waiting forever.
        const targets = new Set<WebContents | null>(deliveredTo);
        try {
          targets.add(this.resolveWebContents(req.sessionId));
        } catch {
          // resolver failed — the renderers it reached are still told
        }
        for (const target of targets) {
          try {
            if (!target || target.isDestroyed()) continue;
            target.send(IPC_ASK_USER_QUESTION_TIMEOUT, { requestId: req.id });
          } catch {
            // renderer may be tearing down — best-effort
          }
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        // ignore send failures — the resolve below clears the gate either way
        resolve({ requestId: req.id, dismissed: true });
      }, this.timeoutMs);
      const abortListener = input.abortSignal
        ? () => {
            cleanup();
            resolve({ requestId: req.id, dismissed: true });
          }
        : null;
      // Every terminal path (answer, timeout, abort, send failure, dispose) runs this once, so every copy of the card is taken down whichever way the question ended.
      let settled = false;
      const cleanup = () => {
        this.pending.delete(req.id);
        clearTimeout(timer);
        if (abortListener) input.abortSignal?.removeEventListener("abort", abortListener);
        if (settled) return;
        settled = true;
        announceStale();
      };
      if (abortListener) {
        input.abortSignal?.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(req.id, { request: req, deliveredTo, resolve, cleanup });
      try {
        wc.send(IPC_ASK_USER_QUESTION_REQUEST, req);
      } catch (err) {
        cleanup();
        log.warn(
          "ask-user-question send failed: %s",
          (err as Error).message,
        );
        resolve({ requestId: req.id, dismissed: true });
      }
    });
  }

  resolve(response: AskUserQuestionResponse): boolean {
    const entry = this.pending.get(response.requestId);
    if (!entry) return false;
    const normalized = normalizeResponse(entry.request, response);
    if (!normalized) return false;
    entry.cleanup();
    entry.resolve(normalized);
    return true;
  }

  disposeAll(): void {
    for (const [id, entry] of this.pending) {
      entry.cleanup();
      entry.resolve({ requestId: id, dismissed: true });
    }
    this.pending.clear();
  }

  // Late-loading renderers replay pending questions for their owned sessions so window closure cannot strand the turn.
  listPending(recipient?: WebContents): AskUserQuestionRequest[] {
    const entries = [...this.pending.values()];
    // The reader now holds a copy of each card; it is told when they end.
    if (recipient) for (const entry of entries) entry.deliveredTo.add(recipient);
    return entries.map((entry) => entry.request);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
