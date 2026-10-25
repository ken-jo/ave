



import { t } from "../i18n/index.js";
import { createDynamicTool, toolErrorResult, type Tool } from "./base.js";
import { MAX_PLACEHOLDER_LENGTH } from "../shared/ask-user-question-limits.js";
import {
  MAX_QUESTIONS_PER_CARD,
  type AskUserQuestionGate,
  type AskUserQuestionItem,
} from "../main/ask-user-question-gate.js";
import { execTurnRequested } from "../main/exec-mode.js";

export interface AskUserQuestionToolDeps {
  getGate: () => AskUserQuestionGate | undefined;
}

// Replace labels that mean text entry with allowFreeText; keep the set limited to labels that cannot be real answers.
export const FREE_TEXT_STAND_IN_LABELS: readonly string[] = [
  "입력",
  "직접 입력",
  "직접입력",
  "기타",
  "other",
  "type…",
  "type...",
  "custom",
];

// Budget choice width in columns, preserving the 20-CJK-character ceiling.
const MAX_CHOICE_WIDTH = 40;

// Count East Asian wide/fullwidth characters as two columns and others as one.
function choiceDisplayWidth(choice: string): number {
  let width = 0;
  for (const character of choice) {
    const code = character.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals through Yi
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
      (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd); // CJK extension planes
    width += wide ? 2 : 1;
  }
  return width;
}

const FREE_TEXT_STAND_IN_SET = new Set(
  FREE_TEXT_STAND_IN_LABELS.map((label) => label.toLowerCase()),
);

export function createAskUserQuestionTool(deps: AskUserQuestionToolDeps): Tool {
  return createDynamicTool({
    name: "ask_user_question",
    description: t("be_askUserQuestion.toolDescription"),
    source: "builtin",
    category: "meta",
    decisionOverride: "always-allow-with-audit",
    jsonSchema: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_QUESTIONS_PER_CARD,
          description: t("be_askUserQuestion.questionsDesc", { max: MAX_QUESTIONS_PER_CARD }),
          items: {
            type: "object",
            required: ["question", "choices"],
            properties: {
              question: {
                type: "string",
                description: t("be_askUserQuestion.questionItemDesc"),
              },
              choices: {
                type: "array",
                items: { type: "string", minLength: 1, maxLength: 20 },
                maxItems: 3,
                uniqueItems: true,
                description: t("be_askUserQuestion.choicesDesc"),
              },
              recommendedIndex: {
                type: "integer",
                minimum: 0,
                maximum: 2,
                description: t("be_askUserQuestion.recommendedIndexDesc"),
              },
              altIndices: {
                type: "array",
                maxItems: 3,
                items: { type: "integer", minimum: 0, maximum: 2 },
                description: t("be_askUserQuestion.altIndicesDesc"),
              },
              allowMultiple: {
                type: "boolean",
                description: t("be_askUserQuestion.allowMultipleDesc"),
              },
              allowFreeText: {
                type: "boolean",
                description: t("be_askUserQuestion.allowFreeTextDesc"),
              },
              placeholder: {
                type: "string",
                maxLength: MAX_PLACEHOLDER_LENGTH,
                description: t("be_askUserQuestion.placeholderDesc"),
              },
              summaryHint: {
                type: "string",
                description: t("be_askUserQuestion.summaryHintDesc"),
              },
            },
          },
        },
      },
    },
    execute: async (rawInput, ctx) => {
      // Refuse unattended questions before validation; an unwatched renderer cannot answer and would hold the gate until timeout.
      if (execTurnRequested(process.argv)) {
        return {
          output: JSON.stringify({
            answers: [],
            dismissed: true,
            reason: "unattended run: no user is present to answer",
            guidance:
              "Choose the option you judge best, say which one you chose and why, and continue.",
          }),
          isError: false,
        };
      }
      const gate = deps.getGate();
      if (!gate) {
        return toolErrorResult("ask_user_question gate not configured (no active window)");
      }
      // Require a session identity so the card has an addressable conversation.
      if (typeof ctx.metadata?.sessionId !== "string" || ctx.metadata.sessionId.length === 0) {
        return toolErrorResult("ask_user_question requires an executing session");
      }
      const sessionId = ctx.metadata.sessionId;
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const rawQuestions = Array.isArray(a.questions) ? a.questions : null;
      if (!rawQuestions || rawQuestions.length === 0) {
        return toolErrorResult("questions[] is required and must contain at least one item");
      }
      if (rawQuestions.length > MAX_QUESTIONS_PER_CARD) {
        return toolErrorResult(`questions[] capped at ${MAX_QUESTIONS_PER_CARD} per card`);
      }
      const questions: AskUserQuestionItem[] = [];
      for (const raw of rawQuestions) {
        const q = (raw ?? {}) as Record<string, unknown>;
        const question = typeof q.question === "string" ? q.question.trim() : "";
        if (!question) {
          return toolErrorResult("every questions[].question must be a non-empty string");
        }
        if (!Array.isArray(q.choices)) {
          return toolErrorResult("each question must provide a choices array");
        }
        if (
          q.choices.some(
            (choice) =>
              typeof choice !== "string" ||
              choice.trim().length === 0 ||
              choiceDisplayWidth(choice.trim()) > MAX_CHOICE_WIDTH,
          )
        ) {
          return toolErrorResult(
            "each choice must be a non-empty string that fits the chip: " +
              `at most ${MAX_CHOICE_WIDTH} display columns ` +
              "(a Latin character is one, a CJK character two)",
          );
        }
        // Preserve original choice positions when dropping placeholders so badges retain their intended targets.
        const keptChoices = (q.choices as string[])
          .map((choice, index) => ({ label: choice.trim(), index }))
          .filter((entry) => !FREE_TEXT_STAND_IN_SET.has(entry.label.toLowerCase()));
        const allowFreeText = q.allowFreeText === true || keptChoices.length !== q.choices.length;
        const filteredChoices = keptChoices.map((entry) => entry.label);
        const positionAfterCoercion = new Map(
          keptChoices.map((entry, position) => [entry.index, position]),
        );
        if (filteredChoices.length > 3) {
          return toolErrorResult("each question must provide at most 3 choices");
        }
        if (filteredChoices.length === 0 && !allowFreeText) {
          return toolErrorResult("each question must offer an answer — provide choices[] or set allowFreeText:true");
        }
        if (new Set(filteredChoices).size !== filteredChoices.length) {
          return toolErrorResult("each question must provide unique choices");
        }
        const recIdxRaw = q.recommendedIndex;
        const recommendedIndex =
          typeof recIdxRaw === "number" && Number.isInteger(recIdxRaw)
            ? positionAfterCoercion.get(recIdxRaw)
            : undefined;
        const altIndices = (() => {
          if (!Array.isArray(q.altIndices)) return undefined;
          const seen = new Set<number>();
          for (const v of q.altIndices) {
            if (typeof v !== "number") continue;
            if (!Number.isInteger(v)) continue;
            const position = positionAfterCoercion.get(v);
            if (position === undefined) continue;
            if (position === recommendedIndex) continue;
            seen.add(position);
          }
          return seen.size > 0 ? [...seen] : undefined;
        })();
        const placeholderRaw = typeof q.placeholder === "string" ? q.placeholder.trim() : "";
        const placeholder =
          allowFreeText &&
          placeholderRaw.length > 0 &&
          placeholderRaw.length <= MAX_PLACEHOLDER_LENGTH
            ? placeholderRaw
            : undefined;
        const summaryHint =
          typeof q.summaryHint === "string" && q.summaryHint.trim().length > 0
            ? q.summaryHint.trim()
            : undefined;
        // Emit allowMultiple only for enabled questions with surviving choices; otherwise preserve undefined.
        const allowMultiple =
          q.allowMultiple === true && filteredChoices.length > 0 ? true : undefined;
        questions.push({
          question,
          choices: filteredChoices,
          recommendedIndex,
          altIndices,
          allowMultiple,
          allowFreeText: allowFreeText ? true : undefined,
          placeholder,
          summaryHint,
        });
      }
      const response = await gate.ask({
        questions,
        sessionId,
        // Turn cancellation must release the gate rather than wait for its timeout.
        abortSignal: ctx.abortSignal,
      });
      return {
        output: JSON.stringify({
          answers: response.answers ?? [],
          dismissed: response.dismissed === true,
        }),
        isError: false,
      };
    },
  });
}
