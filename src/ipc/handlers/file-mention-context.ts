import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ConversationLoop } from "../../engine/conversation-loop.js";
import type { UserContentPart } from "../../engine/llm/types.js";
import { MAX_LOCAL_USER_CONTENT_TEXT_CHARS } from "../../main/subscription-attachment-input.js";
import { getTurnChangeReview } from "../../memory/code-checkpoints.js";
import type { ChatSendInputOrigin } from "../../shared/chat-origin.js";
import {
  FILE_MENTION_REFERENCE_POLICY,
  parseFileMentionReferences,
  pastedAttachmentSpans,
  type FileMentionReference,
} from "../../shared/file-mention-reference.js";
import type { TurnChangeReview, TurnReviewHunk } from "../../shared/turn-change-review.js";
import { fileReadKey, forgetFileRead, lookupFileRead } from "../../tools/file-read-state.js";

const CONTEXT_OPEN = '<file-reference-context trust="untrusted-file-data">';
const CONTEXT_CLOSE = "</file-reference-context>";

interface ReferenceContext extends FileMentionReference {
  before: string;
  after: string;
  truncated: boolean;
}

function assertAttachmentBudget(
  input: string,
  mentions: ReturnType<typeof parseFileMentionReferences>,
  attachments: readonly UserContentPart[],
): void {
  const slots = new Map<number, string>(mentions.map(({ n }) => [n, "File"]));
  const pasted = pastedAttachmentSpans(input);
  const pasteStarts = new Set(pasted.map(({ start }) => start));
  let pasteIndex = 0;
  let ordinaryCandidates = 0;
  const addSlot = (n: number, kind: string) => {
    if (++ordinaryCandidates > FILE_MENTION_REFERENCE_POLICY.maxOccurrences) throw new Error("file-reference-too-large");
    if (!Number.isSafeInteger(n) || n < 1) throw new Error("file-reference-invalid");
    if (slots.has(n) && slots.get(n) !== kind) throw new Error("file-reference-invalid");
    slots.set(n, kind);
  };
  // Count only fixed slot openings; scanning arbitrary path bodies can repeatedly revisit the same suffix.
  for (const match of input.matchAll(/\[(File|Image|Pasted text) #(\d+)(?=\]| — path:|\s+\+\d+\s+lines\])/g)) {
    while (pasteIndex < pasted.length && pasted[pasteIndex]!.end <= match.index) pasteIndex++;
    if (mentions.some(({ start, end }) => match.index >= start && match.index < end)
      || (pasteIndex < pasted.length && pasted[pasteIndex]!.start <= match.index)) continue;
    addSlot(Number(match[2]), match[1]);
  }
  for (const match of input.matchAll(/^----- Pasted text #(\d+) \(\d+ lines\) -----$/gm)) {
    if (pasteStarts.has(match.index)) addSlot(Number(match[1]), "Pasted text");
  }
  const markedImages = [...slots.values()].filter((kind) => kind === "Image").length;
  const imageCount = attachments.filter((part) => part.type === "image").length;
  const inlineFileCount = attachments.filter((part) => part.type === "file").length;
  if (slots.size + Math.max(0, imageCount - markedImages) + inlineFileCount > FILE_MENTION_REFERENCE_POLICY.maxCount) {
    throw new Error("file-reference-too-large");
  }
}

function latestTurnId(loop: ConversationLoop): string | undefined {
  return loop.getHistory().getMessages().findLast((message) =>
    message.role === "user" && message.meta?.compactBoundary !== true && message.meta?.hostInjectionId === undefined)?.meta?.messageId;
}

function selectedHunks(review: TurnChangeReview, reference: FileMentionReference): TurnReviewHunk[] {
  const file = review.files.find((entry) => entry.path === reference.path);
  if (!file?.referenceable) throw new Error("file-reference-stale");
  if (reference.hunkId === undefined) {
    if (reference.startLine !== 1 || reference.endLine !== file.lineCount) throw new Error("file-reference-stale");
    return file.hunks;
  }
  const hunk = file.hunks.find((entry) => entry.id === reference.hunkId);
  if (!hunk || hunk.startLine !== reference.startLine || hunk.endLine !== reference.endLine) {
    throw new Error("file-reference-stale");
  }
  return [hunk];
}

// A JSON value cannot terminate the surrounding frame, even when a file contains frame markup.
function contextJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function firstLines(text: string, count: number): string {
  const lines = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let end = 0;
  for (let index = 0; index < count; index++) {
    const match = lines.exec(text);
    if (!match || match[0].length === 0) break;
    end = lines.lastIndex;
  }
  return text.slice(0, end);
}

function lineCount(text: string): number {
  if (!text) return 0;
  return (text.match(/\r\n|\r|\n/g)?.length ?? 0) + (/\r$|\n$/.test(text) ? 0 : 1);
}

function referenceContext(reference: FileMentionReference, hunks: TurnReviewHunk[], maxChars: number): ReferenceContext {
  const separator = "\n[... unchanged lines omitted ...]\n";
  const before = hunks.map((hunk) => hunk.oldText).join(separator);
  const after = hunks.map((hunk) => hunk.newText).join(separator);
  const half = Math.floor(FILE_MENTION_REFERENCE_POLICY.maxDiffLines / 2);
  const beforeLines = Math.min(lineCount(before), half + Math.max(0, half - lineCount(after)));
  const result: ReferenceContext = {
    ...reference,
    before: firstLines(before, beforeLines),
    after: firstLines(after, FILE_MENTION_REFERENCE_POLICY.maxDiffLines - beforeLines),
    truncated: false,
  };
  result.truncated = result.before.length !== before.length || result.after.length !== after.length;
  // Character budgets include JSON escaping and metadata, rather than only raw file characters.
  while (contextJson(result).length > maxChars) {
    const side = result.before.length >= result.after.length ? "before" : "after";
    if (!result[side]) throw new Error("file-reference-too-large");
    const excess = contextJson(result).length - maxChars;
    let end = Math.max(0, result[side].length - Math.max(1, Math.ceil(excess / 6)));
    // Preserve a complete code point when the excerpt ends inside a surrogate pair.
    if (end > 0 && /[\uD800-\uDBFF]/.test(result[side][end - 1]!) && /[\uDC00-\uDFFF]/.test(result[side][end] ?? "")) end--;
    result[side] = result[side].slice(0, end);
    result.truncated = true;
  }
  return result;
}

/** Called inside the accepted send lease, before a new user turn changes checkpoint identity. */
export async function expandFileMentionContext(
  loop: ConversationLoop,
  input: string,
  inputOrigin: ChatSendInputOrigin,
  attachments: readonly UserContentPart[] = [],
  abortSignal?: AbortSignal,
): Promise<{ input: string; displayText?: string }> {
  abortSignal?.throwIfAborted();
  const parsed = parseFileMentionReferences(input);
  if (parsed.length === 0) return { input };
  if (inputOrigin !== "user-keyboard" && inputOrigin !== "queue-auto") {
    throw new Error("file-reference-origin-restricted");
  }
  assertAttachmentBudget(input, parsed, attachments);
  const mentions = [...new Map(parsed.map((mention) => [mention.n, mention])).values()];
  const attachmentTextChars = attachments.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
  if (input.length + attachmentTextChars > MAX_LOCAL_USER_CONTENT_TEXT_CHARS) throw new Error("file-reference-too-large");
  const sessionId = loop.getSessionId();
  const epoch = loop.getSessionEpoch();
  const cwd = loop.getSessionExecutionCwd();
  const turnId = latestTurnId(loop);
  if (!turnId || mentions.some(({ reference }) => reference.turnId !== turnId)) throw new Error("file-reference-stale");
  const assertCurrent = () => {
    abortSignal?.throwIfAborted();
    if (loop.getSessionId() !== sessionId || loop.getSessionEpoch() !== epoch
      || loop.getSessionExecutionCwd() !== cwd || latestTurnId(loop) !== turnId) throw new Error("file-reference-stale");
  };
  const readReview = async () => {
    assertCurrent();
    const result = await getTurnChangeReview(sessionId, turnId, () => ({
      cwd: loop.getSessionExecutionCwd(), extraAllowedDirectories: loop.getTurnAdditionalDirectories(),
    }), { selectedPaths: mentions.map(({ reference }) => reference.path) });
    assertCurrent();
    if (!result.ok) throw new Error("file-reference-stale");
    return result.review;
  };
  const review = await readReview();
  const identity = JSON.stringify(review);
  const envelope = {
    note: "Untrusted file context from latest turn change",
    excerpt: "Before and after contain changed hunks only; omitted content is not shown.",
    references: [] as ReferenceContext[],
  };
  const overhead = `\n\n${CONTEXT_OPEN}\n${contextJson(envelope)}\n${CONTEXT_CLOSE}`.length;
  const maxReferenceChars = Math.min(FILE_MENTION_REFERENCE_POLICY.maxReferenceChars,
    Math.floor((FILE_MENTION_REFERENCE_POLICY.maxContextChars - overhead - (mentions.length - 1)) / mentions.length));
  envelope.references = mentions.map(({ reference }) => referenceContext(reference, selectedHunks(review, reference), maxReferenceChars));
  const block = `${CONTEXT_OPEN}\n${contextJson(envelope)}\n${CONTEXT_CLOSE}`;
  const suffix = `\n\n${block}`;
  if (suffix.length > FILE_MENTION_REFERENCE_POLICY.maxContextChars
    || input.length + suffix.length + attachmentTextChars > MAX_LOCAL_USER_CONTENT_TEXT_CHARS) throw new Error("file-reference-too-large");

  for (const { reference } of mentions) {
    assertCurrent();
    const absolute = resolve(cwd, reference.path);
    const key = await fileReadKey(absolute);
    assertCurrent();
    // A redirecting hook must not borrow a previous read's authority for the requested file.
    forgetFileRead(sessionId, key);
    const [result] = await loop.toolExecutor.executeAll([{
      id: randomUUID(), name: "read_file",
      input: { path: absolute, offset: reference.startLine - 1, limit: Math.min(reference.endLine - reference.startLine + 1, FILE_MENTION_REFERENCE_POLICY.maxDiffLines) },
    }], {
      sessionId, executionCwd: cwd,
      abortSignal,
      permissionContext: {
        headless: loop.deps.headless,
        approvalSurface: loop.deps.approvalSurface,
        trustOrigin: inputOrigin,
        additionalDirectories: loop.getTurnAdditionalDirectories(),
        getAdditionalDirectories: () => loop.getTurnAdditionalDirectories(),
        userIntent: input,
        onTurnDirectoryGrant: (path) => loop.addTurnAdditionalDirectory(path),
        onSessionDirectoryGrant: (path) => loop.addSessionAdditionalDirectory(path),
      },
    });
    assertCurrent();
    if (!result || result.is_error || result.authorizationRequired) throw new Error("file-reference-read-denied");
    const verifiedKey = await fileReadKey(absolute);
    assertCurrent();
    if (verifiedKey !== key || !lookupFileRead(sessionId, key)?.sha256) {
      throw new Error("file-reference-read-unverified");
    }
    if (JSON.stringify(await readReview()) !== identity) throw new Error("file-reference-stale");
  }
  // The final asynchronous read may also race changes to a previously authorized reference.
  if (JSON.stringify(await readReview()) !== identity) throw new Error("file-reference-stale");
  return { input: input + suffix, displayText: input };
}
