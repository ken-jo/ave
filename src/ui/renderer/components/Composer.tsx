import { chatSurface } from "./chat-surface.js";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent as ReactDragEvent,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "../../../i18n/react.js";
import type { ReactElement } from "react";
import { Textarea } from "../../../components/ui/textarea.js";
import {
  AttachmentChip,
  AttachmentChipCollapsed,
} from "./AttachmentChip.js";
import {
  ATTACH_MAX_COUNT,
  type Attachment,
  type FileAttachment,
  type ResourceAttachment,
} from "../types/attachments.js";
import { findMarkerAt, parseMarkers } from "../utils/attachment-markers.js";
import { handleClipboardPaste } from "../utils/clipboard-paste.js";
import { isComposingKeyEvent } from "../utils/ime-key-event.js";
import { IDLE_PROMPT_HISTORY, stepPromptHistory, type PromptHistoryCursor } from "../utils/prompt-history.js";
import { InlineSlashMenu } from "./InlineSlashMenu.js";
import { ResourceMentionMenu } from "./ResourceMentionMenu.js";
import { McpResourceTemplateDialog } from "../dialogs/McpResourceTemplateDialog.js";
import { useInlineSlashMenu } from "../hooks/use-inline-slash-menu.js";
import { useResourceMention } from "../hooks/use-resource-mention.js";
import { useSlashPickerRuntime } from "../hooks/use-slash-picker-runtime.js";
import type { QuickAction } from "./command-actions.js";
import type { PluginEntry } from "../types.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { SubscriptionImageAttachmentLimits } from "../../../shared/subscription-runtime.js";
import { subscriptionImageAttachmentLimitViolation } from "../utils/subscription-runtime-ui-policy.js";
import {
  acceptSuggestedReply,
  clearDismissedReplies,
  dismissSuggestedReplies,
  type SuggestedRepliesSnapshot,
} from "../hooks/use-suggested-replies.js";
import { TEST_IDS } from "../../../shared/test-ids.js";
import { FILE_MENTION_REFERENCE_POLICY, formatFileMentionReference, type FileMentionReference } from "../../../shared/file-mention-reference.js";

export interface ComposerHandle {
  focus(): void;
  /** Insert text at the current caret position (or replace selection if any). Used by the action-bar attach flow so
   * file-picker markers land where the user is typing rather than always appending to the end of the body. */
  insertAtCursor(insertion: string): void;
  /** Insert a location marker and its existing file attachment together, honoring the current composer gates. */
  insertFileReference(reference: FileMentionReference): { inserted: boolean };
  /** Insert an ordinary path mention through the existing attachment marker path. */
  insertFileMention(path: string): { inserted: boolean };
  /**
   * The live textarea element. Window-level shortcuts (⌘⏎, Esc) are owned by
   * the composer's keyboard hook, and several composers can be mounted at once
   * — one per chat tile, plus the side chat — so an owner matches the event
   * target against THIS element rather than against a test id every composer
   * shares.
   */
  textarea(): HTMLTextAreaElement | null;
}

/**
 * Which chat surface a composer serves. There is one composer implementation;
 * the surface selects only the values the two placements legitimately differ
 * on (the textarea's growth cap, the tour anchor). Everything the user does in
 * the field — send, queue, interrupt, paste, attach, the inline menus, IME —
 * is the same code on both.
 */
export type ComposerSurface = "main" | "side";

/** Use rows=1 and override the primitive textarea minimum; grow to five lines in main chat and four in the side rail. */
const TEXTAREA_MAX_HEIGHT_CLASS: Record<ComposerSurface, string> = {
  main: "max-h-[144px]",
  side: "max-h-[112px]",
};

export interface ComposerProps {
  /** Placement — see {@link ComposerSurface}. */
  surface?: ComposerSurface;
  text: string;
  onTextChange: (next: string) => void;
  attachments: Attachment[];
  /**
   * State setter — accepts a value or a functional updater. The updater
   * form is the only race-safe way to enforce the 5-cap when concurrent
   * paste / picker work is in flight. ChatView wires this directly to
   * `useState`'s setter so both forms work.
   */
  onAttachmentsChange: Dispatch<SetStateAction<Attachment[]>>;
  /** Strictly increasing N counter (parent owns the seed). */
  allocateN: () => number;
  /** Saves clipboard image to OS tmp via main process. */
  saveClipboardImage: (
    base64: string,
  ) => Promise<{
    ok: boolean;
    path?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
    dataUrl?: string;
    error?: string;
  }>;
  /** Releases an app-owned clipboard temp image after this composer refuses it. */
  discardClipboardImage?: (path: string) => Promise<unknown>;
  /** Open via OS default app — for the overlay's open button. */
  openExternal?: (path: string) => Promise<unknown>;
  onSend: (intent: UserKeyboardIntentSnapshot) => void;

  disabled?: boolean;
  /** False when the active runtime cannot accept original local image input. */
  imagesEnabled?: boolean;
  /** False when the active runtime cannot take file attachments — no `@file` rows then. */
  filesEnabled?: boolean;
  /** Files dropped on the composer. Omitted → the composer is not a drop target (the window guard still blocks file://
   * navigation). */
  onDropFiles?: (files: FileList) => void;
  /** Exact main-verified raw-image budget for the selected subscription runtime. */
  imageAttachmentLimits?: SubscriptionImageAttachmentLimits | null;
  /** Disable Enter-to-send while preserving editable draft text and markers. */
  sendDisabled?: boolean;
  placeholder?: string;
  onWarning?: (message: string) => void;
  /** Overrides the generic warning only for a live image-capability refusal. */
  onImageAttachmentUnavailable?: () => void;
  /** Overrides the generic warning when a supported image exceeds its runtime budget. */
  onImageAttachmentLimitExceeded?: () => void;
  /**
   * Suggested-reply snapshot from `useSuggestedReplies()`. Composer renders
   * `text` as ghost text inside the textarea when value is empty + not
   * dismissed. Tab fills the suggestion; Escape dismisses the current snapshot.
   *
   * Spec: `docs/architecture/proposals/suggested-replies-ghost-text.md` §6.2.
   */
  suggestedReplies?: SuggestedRepliesSnapshot;

  commandActions?: QuickAction[];
  /** Installed plugins surfaced under the inline menu's `plugin` category. */
  inlinePlugins?: PluginEntry[];
  /** Open a plugin view when its inline-menu item is accepted. */
  onSelectPlugin?: (viewKey: string) => void;
  /** Prompts the user typed earlier, oldest first. Up on an empty composer recalls them; Down walks back to the draft.
   * Omitted → no recall. */
  promptHistory?: readonly string[];
}

/**
 * Single composer cell — strip(left) + textarea(center) + send(right).
 *
 * Single source of truth: the textarea body holds marker tokens
 * ([Image #N], [File #N], [Pasted text #N +X lines]). The attachment
 * list is derived per-render from `parseMarkers(text)`. When the user
 * deletes a marker, the matching attachment disappears automatically;
 * there is no separate ⓧ button on chips.
 */
/** Keep optional plugin-selection fallback stable so memoized menu keyboard dependencies remain observable. */
const NOOP_SELECT_PLUGIN = () => {};
const EMPTY_PROMPT_HISTORY: readonly string[] = [];

function clipboardContainsImage(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) return false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind === "file" && item.type.startsWith("image/")) return true;
  }
  return false;
}


/** Capture a one-shot keyboard intent for the gesture now being handled; preload consumes it and main verifies it. Without an active
 * gesture the token is empty and confers nothing. */
export function captureComposerKeyboardIntent(): UserKeyboardIntentSnapshot {
  const api = (globalThis as typeof globalThis & {
    window?: { aveApi?: { captureUserKeyboardIntent?: () => UserKeyboardIntentSnapshot } };
  }).window?.aveApi;
  return api?.captureUserKeyboardIntent?.() ?? { inputOrigin: "user-keyboard", token: "" };
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    surface = "main",
    text,
    onTextChange,
    attachments,
    onAttachmentsChange,
    allocateN,
    saveClipboardImage,
    discardClipboardImage,
    openExternal,
    onSend,
    disabled = false,
    imagesEnabled = true,
    filesEnabled = true,
    onDropFiles,
    imageAttachmentLimits,
    sendDisabled = false,
    placeholder,
    onWarning,
    onImageAttachmentUnavailable,
    onImageAttachmentLimitExceeded,
    suggestedReplies,
    commandActions = [],
    inlinePlugins = [],
    onSelectPlugin,
    promptHistory = EMPTY_PROMPT_HISTORY,
  },
  ref,
) {
  const { t } = useTranslation();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const imagesEnabledRef = useRef(imagesEnabled);
  imagesEnabledRef.current = imagesEnabled;
  const imageAttachmentLimitsRef = useRef(imageAttachmentLimits);
  imageAttachmentLimitsRef.current = imageAttachmentLimits;
  // Mirror of the controlled value for callbacks that outlive the render they were created in — the asynchronous resource
  // attach is the one that needs it.
  const textRef = useRef(text);
  textRef.current = text;
  const promptHistoryCursorRef = useRef<PromptHistoryCursor>(IDLE_PROMPT_HISTORY);

  // because `e.nativeEvent.isComposing` is only available inside keydown — the ghost render path needs the value at render
  // time, not just on key events.
  const [isComposing, setIsComposing] = useState(false);
  const isComposingRef = useRef(false);
  /** Set by the Ctrl/⌘+Shift+V keydown and consumed by the paste that follows it — a ClipboardEvent exposes no modifier state
   * of its own, so the chord has to be carried across the two events. */
  const plainPasteRequestedRef = useRef(false);
  // Caret mirror — the inline "/" menu needs the cursor index, but the value is controlled so selectionStart lives only on
  // the DOM node. Synced on every event that can move the caret (change / keyup / click / select).
  const [caret, setCaret] = useState(0);
  const selectionRef = useRef<{ start: number; end: number; text: string } | null>(null);
  const syncCaret = useCallback(() => {
    const ta = taRef.current;
    if (ta) {
      setCaret(ta.selectionStart ?? 0);
      selectionRef.current = { start: ta.selectionStart, end: ta.selectionEnd, text: ta.value };
    }
  }, []);

  // Live MCP-server tools + registered skills back the inline menu's mcp / skills categories (real host IPC). Fetched only
  // while the composer is enabled so it stays parallel with the command menu's data.
  const { mcpTools, skills } = useSlashPickerRuntime(!disabled);

  // Inline "/" autocomplete — derives an open/filtered menu from the controlled text + caret and owns accept/replace.
  // Keyboard nav is wired into handleKeyDown below; rendering is the InlineSlashMenu at the end.
  const inlineSlash = useInlineSlashMenu({
    text,
    caret,
    enabled: !disabled,
    isComposing,
    commandActions,
    plugins: inlinePlugins,
    mcpTools,
    skills,
    onSelectPlugin: onSelectPlugin ?? NOOP_SELECT_PLUGIN,
    taRef,
    onTextChange,
  });
  const {
    open: inlineOpen,
    move: inlineMove,
    accept: inlineAccept,
    close: inlineClose,
  } = inlineSlash;

  const captureUserKeyboardIntent = useCallback((): UserKeyboardIntentSnapshot => captureComposerKeyboardIntent(), []);

  // Live-derive attachments from textarea body (single source of truth). Drop any whose N is no longer present in the body.
  const liveAttachments = useMemo(() => {
    const present = new Set(parseMarkers(text));
    return attachments.filter((a) => present.has(a.n));
  }, [text, attachments]);

  useEffect(() => {
    if (liveAttachments.length !== attachments.length) {
      onAttachmentsChange(liveAttachments);
    }
  }, [liveAttachments, attachments, onAttachmentsChange]);

  // Picker count and resource-text budget are independent: resource attachments must not consume screenshot/file slots.
  const resourceCount = useMemo(
    () => liveAttachments.filter((a) => a.kind === "resource").length,
    [liveAttachments],
  );
  const chipStripCount = liveAttachments.length - resourceCount;
  const referenceInputRef = useRef({ disabled, filesEnabled, chipStripCount, attachments: liveAttachments });
  referenceInputRef.current = { disabled, filesEnabled, chipStripCount, attachments: liveAttachments };
  const [dropActive, setDropActive] = useState(false);

  // Shared by resource and file mentions: replace the `@token` with the marker and add the attachment in one flushSync.
  const spliceMention = useCallback((
    attachment: Attachment,
    marker: string,
    range: { start: number; end: number },
    mentionToken: string,
  ) => {
      // Read current composer text after async resource reads; commit the marker and attachment together so typing is preserved.
      const current = textRef.current;
      // Revalidate the entire mention token after async reads; a matching sigil alone can splice into retyped content.
      const stillTheMention = current.slice(range.start, range.end) === mentionToken;
      const insertAt = stillTheMention ? range.start : current.length;
      const removeTo = stillTheMention ? range.end : current.length;
      const needsSpace = !stillTheMention && current.length > 0 && !current.endsWith(" ");
      const insertion = needsSpace ? ` ${marker}` : marker;
      const next = current.slice(0, insertAt) + insertion + current.slice(removeTo);
      flushSync(() => {
        onAttachmentsChange((prev) => [...prev, attachment]);
        onTextChange(next);
      });
      const ta = taRef.current;
      if (!ta) return;
      const selection = { start: ta.selectionStart, end: ta.selectionEnd };
      const focused = document.activeElement;
      const pos = insertAt + insertion.length;
      requestAnimationFrame(() => {
        // A newer edit, selection, or focus takes precedence over this pending caret placement.
        if (ta !== taRef.current || ta.value !== next || ta.selectionStart !== selection.start
          || ta.selectionEnd !== selection.end || document.activeElement !== focused) return;
        ta.setSelectionRange(pos, pos);
        ta.focus();
      });
  }, [onAttachmentsChange, onTextChange]);

  // Inline "@" resource mention. Its accept path is asynchronous (it reads the resource
  // through the host) and it commits the marker and the attachment TOGETHER here, in one
  // flushSync, for the same reason the clipboard path does: the marker-sync effect above
  // treats an attachment whose marker is missing from the body as deleted, and would
  // clean this one up before the text caught up.
  const resourceMention = useResourceMention({
    text,
    caret,
    enabled: !disabled,
    isComposing,
    // Read the same way the slash-picker runtime reads its tools. On reduced renderer surfaces without the MCP bridge, the
    // menu simply never opens.
    mcp: typeof window === "undefined" ? undefined : window.ave?.mcp,
    resourceCount,
    searchFiles: typeof window === "undefined" ? undefined : window.ave?.workspace?.searchFiles,
    filesEnabled,
    chipCount: chipStripCount,
    onAttachFile: useCallback((
      attachment: FileAttachment,
      marker: string,
      range: { start: number; end: number },
      mentionToken: string,
    ) => spliceMention(attachment, marker, range, mentionToken), [spliceMention]),
    allocateN,
    onAttach: useCallback((
      attachment: ResourceAttachment,
      marker: string,
      range: { start: number; end: number },
      mentionToken: string,
    ) => {
      spliceMention(attachment, marker, range, mentionToken);
    }, [spliceMention]),
    onError: useCallback((message: string) => onWarning?.(message), [onWarning]),
  });
  const {
    open: mentionOpen,
    move: mentionMove,
    accept: mentionAccept,
    close: mentionClose,
  } = resourceMention;

  const insertAtCursor = useCallback(
    (insertion: string) => {
      const ta = taRef.current;
      if (!ta) {
        onTextChange(text + insertion);
        return;
      }
      const start = ta.selectionStart ?? text.length;
      const end = ta.selectionEnd ?? text.length;
      const next = text.slice(0, start) + insertion + text.slice(end);
      onTextChange(next);
      requestAnimationFrame(() => {
        if (taRef.current) {
          const pos = start + insertion.length;
          taRef.current.setSelectionRange(pos, pos);
          taRef.current.focus();
        }
      });
    },
    [text, onTextChange],
  );

  const insertFileMentionAttachment = useCallback((path: string, location?: FileAttachment["location"]): { inserted: boolean } => {
    const input = referenceInputRef.current;
    if (input.disabled || !input.filesEnabled || isComposingRef.current || !taRef.current) return { inserted: false };
    if (typeof path !== "string" || !path || path.length > FILE_MENTION_REFERENCE_POLICY.maxPathChars || /[\u0000-\u001f\u007f]/.test(path)) return { inserted: false };
    if (input.attachments.some((attachment) => attachment.kind === "file" && attachment.reference
      && attachment.path === path && attachment.location?.startLine === location?.startLine
      && attachment.location?.endLine === location?.endLine && attachment.location?.turnId === location?.turnId
      && attachment.location?.hunkId === location?.hunkId)) return { inserted: false };
    if (input.chipStripCount >= ATTACH_MAX_COUNT) {
      onWarning?.(t("composer.attachLimitPasteBlocked", { max: ATTACH_MAX_COUNT }));
      return { inserted: false };
    }
    const current = textRef.current;
    const ta = taRef.current;
    const saved = selectionRef.current;
    const range = document.activeElement === ta
      ? { start: ta.selectionStart, end: ta.selectionEnd }
      : saved?.text === current ? saved : { start: current.length, end: current.length };
    const n = allocateN();
    const displayPath = path.replace(/\\/g, "/");
    const name = displayPath.slice(displayPath.lastIndexOf("/") + 1);
    const extension = name.lastIndexOf(".");
    spliceMention({ id: crypto.randomUUID(), n, kind: "file", path, name,
      ext: extension < 0 ? "" : name.slice(extension + 1), bytes: 0, reference: true, ...(location ? { location } : {}) },
    `[File #${n}]`, range, current.slice(range.start, range.end));
    return { inserted: true };
  }, [onWarning, t, allocateN, spliceMention]);

  const insertFileReference = useCallback((reference: FileMentionReference): { inserted: boolean } => {
    // The host independently verifies this selector and read authorization when the message is sent.
    try { formatFileMentionReference(1, reference); } catch { return { inserted: false }; }
    const { path, ...location } = reference;
    return insertFileMentionAttachment(path, location);
  }, [insertFileMentionAttachment]);

  const insertFileMention = useCallback((path: string) => insertFileMentionAttachment(path), [insertFileMentionAttachment]);

  const removeFileReference = useCallback((attachment: FileAttachment) => {
    const next = textRef.current.split(`[File #${attachment.n}]`).join("");
    flushSync(() => {
      onAttachmentsChange((previous) => previous.filter((item) => item.id !== attachment.id));
      onTextChange(next);
    });
    taRef.current?.focus();
  }, [onAttachmentsChange, onTextChange]);

  // Expose imperative API to parents (focus + caret-aware insertion).
  // Deps include `insertAtCursor` (which itself depends on `text` /
  // `onTextChange`), so the handle is recreated whenever the closure's
  // values change — callers via the ref always see the fresh function.
  useImperativeHandle(
    ref,
    () => ({
      focus() { taRef.current?.focus(); },
      insertAtCursor(insertion: string) { insertAtCursor(insertion); },
      insertFileReference,
      insertFileMention,
      textarea() { return taRef.current; },
    }),
    [insertAtCursor, insertFileReference, insertFileMention],
  );

  const warnImageAttachmentUnavailable = useCallback(() => {
    if (onImageAttachmentUnavailable) {
      onImageAttachmentUnavailable();
      return;
    }
    onWarning?.(t("app.subscriptionAttachmentUnsupported", { provider: "subscription" }));
  }, [onImageAttachmentUnavailable, onWarning, t]);

  const warnImageAttachmentLimitExceeded = useCallback(() => {
    if (onImageAttachmentLimitExceeded) {
      onImageAttachmentLimitExceeded();
      return;
    }
    onWarning?.(t("app.subscriptionAttachmentUnsupported", { provider: "subscription" }));
  }, [onImageAttachmentLimitExceeded, onWarning, t]);

  const discardRejectedClipboardImage = useCallback((filePath: string) => {
    try {
      const discard = discardClipboardImage?.(filePath);
      void discard?.catch(() => {});
    } catch {
      // Best-effort cleanup does not alter the local refusal path.
    }
  }, [discardClipboardImage]);

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // The Ctrl/⌘+Shift+V chord belongs to the paste it arrived with, so it is
      // consumed before any early return. A refused paste must not leave the
      // flag set for a later one that never asked for plain text — a
      // context-menu paste carries no keydown to clear it.
      const plainPasteRequested = plainPasteRequestedRef.current;
      plainPasteRequestedRef.current = false;
      // When the composer is disabled (no API key, context overflow, etc.)
      // the action-bar attach button is also disabled. Without this
      // short-circuit, clipboard paste would silently bypass that gate
      // and grow attachment state while the user cannot send.
      if (disabled) return;
      // Chord honoured: the chipping engine sits this one out and the browser's
      // own paste inserts text/plain. Only when there IS text — an image-only
      // clipboard still takes the attachment path, since "paste as plain text"
      // has nothing to insert for it.
      if (plainPasteRequested && (e.clipboardData?.getData("text/plain") ?? "") !== "") {
        return;
      }
      // Keep ordinary text paste available when only native image egress is unavailable. A clipboard image itself is consumed so
      // the browser does not create an untracked attachment-like draft representation.
      if (!imagesEnabledRef.current && clipboardContainsImage(e.nativeEvent)) {
        e.preventDefault();
        warnImageAttachmentUnavailable();
        return;
      }
      const outcome = await handleClipboardPaste(e.nativeEvent, {
        count: chipStripCount,
        allocateN,
        saveClipboardImage,
        max: ATTACH_MAX_COUNT,
      });
      // A runtime switch may occur while the clipboard image is being saved. Recheck the live capability before committing
      // renderer attachment state, not only when the asynchronous operation started.
      if (outcome.newAttachment?.kind === "image" && !imagesEnabledRef.current) {
        e.preventDefault();
        discardRejectedClipboardImage(outcome.newAttachment.path);
        warnImageAttachmentUnavailable();
        return;
      }
      if (
        outcome.newAttachment?.kind === "image"
        && subscriptionImageAttachmentLimitViolation(
          imageAttachmentLimitsRef.current,
          [
            ...liveAttachments
              .filter((attachment) => attachment.kind === "image")
              .map((attachment) => ({ bytes: attachment.bytes })),
            { bytes: outcome.newAttachment.bytes },
          ],
        )
      ) {
        e.preventDefault();
        discardRejectedClipboardImage(outcome.newAttachment.path);
        warnImageAttachmentLimitExceeded();
        return;
      }
      if (!outcome.handled) return;
      e.preventDefault();
      if (outcome.warning) onWarning?.(outcome.warning);
      if (outcome.newAttachment) {
        const candidate = outcome.newAttachment;
        // Recheck the latest attachment cap after async saves; flush marker text and attachments atomically so marker cleanup
        // cannot delete the new chip.
        let inserted = false;
        let imageAttachmentBudgetRejected = false;
        flushSync(() => {
          onAttachmentsChange((prev) => {
            if (prev.length >= ATTACH_MAX_COUNT) return prev;
            if (candidate.kind === "image") {
              const images = prev
                .filter((attachment) => attachment.kind === "image")
                .map((attachment) => ({ bytes: attachment.bytes }));
              if (
                subscriptionImageAttachmentLimitViolation(
                  imageAttachmentLimitsRef.current,
                  [...images, { bytes: candidate.bytes }],
                )
              ) {
                imageAttachmentBudgetRejected = true;
                return prev;
              }
            }
            inserted = true;
            return [...prev, candidate];
          });
          if (inserted && outcome.insertText) {
            insertAtCursor(outcome.insertText);
          }
        });
        if (imageAttachmentBudgetRejected) {
          if (candidate.kind === "image") {
            discardRejectedClipboardImage(candidate.path);
          }
          warnImageAttachmentLimitExceeded();
        } else if (!inserted) {
          if (candidate.kind === "image") {
            discardRejectedClipboardImage(candidate.path);
          }
          onWarning?.(
            t("composer.attachLimitPasteBlocked", { max: ATTACH_MAX_COUNT }),
          );
        }
      } else if (outcome.insertText) {
        // Pure-text insert (no chip) — never blocked by the cap.
        insertAtCursor(outcome.insertText);
      }
    },
    [
      disabled,
      imagesEnabled,
      liveAttachments,
      allocateN,
      saveClipboardImage,
      discardRejectedClipboardImage,
      onWarning,
      onAttachmentsChange,
      warnImageAttachmentUnavailable,
      warnImageAttachmentLimitExceeded,
      insertAtCursor,
    ],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // The ref covers the window between compositionstart and the first flagged keydown; the helper covers Chromium's commit
      // keydown (keyCode 229, isComposing false) that otherwise sends a half-typed syllable.
      if (isComposingKeyEvent(e) || isComposingRef.current) return;

      // Ctrl/⌘ + Shift + V = paste the ORIGINAL text straight into the field.
      // A ClipboardEvent carries no modifier state, so the chord is recorded
      // here and read by the paste handler that follows it. Deliberately NOT
      // preventDefault-ed: the browser still fires its own paste, and a
      // textarea inserts text/plain, which is exactly the wanted result.
      plainPasteRequestedRef.current =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v";

      // Inline "/" autocomplete owns navigation while open. This MUST run before the suggested-reply Tab branch and the
      // Enter→onSend branch, so Enter accepts the highlighted item instead of sending.
      if (inlineOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          inlineMove(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          inlineMove(-1);
          return;
        }
        if (
          (e.key === "Enter" || e.key === "Tab") &&
          !e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey
        ) {
          e.preventDefault();
          inlineAccept();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          inlineClose();
          return;
        }
      }

      // The "@" mention menu owns navigation on the same terms, and for the same
      // reason: Enter must attach the highlighted resource rather than send the turn.
      // The two triggers are mutually exclusive by construction — each sigil has to
      // start the token, so one token cannot be both — but this branch is second so
      // that a "/" menu already open keeps its keys either way.
      if (mentionOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          mentionMove(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          mentionMove(-1);
          return;
        }
        if (
          (e.key === "Enter" || e.key === "Tab") &&
          !e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey
        ) {
          e.preventDefault();
          mentionAccept();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          mentionClose();
          return;
        }
      }

      // Prompt-history recall. After both menus (they own the arrows while open) and only without modifiers; `stepPromptHistory`
      // returns null whenever the arrow should keep moving the caret instead.
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !disabled &&
        promptHistory.length > 0
      ) {
        const ta = e.currentTarget;
        const step = stepPromptHistory(
          promptHistory,
          promptHistoryCursorRef.current,
          e.key === "ArrowUp" ? -1 : 1,
          text,
          { start: ta.selectionStart, end: ta.selectionEnd },
        );
        if (step) {
          e.preventDefault();
          promptHistoryCursorRef.current = step.cursor;
          onTextChange(step.text);
          requestAnimationFrame(() => {
            if (taRef.current) {
              const pos = step.text.length;
              taRef.current.setSelectionRange(pos, pos);
            }
          });
          return;
        }
      }

      // Suggested Reply (spec §6.2):
      //   Tab (no modifier) + value empty + text != null + not dismissed
      //     → fill textarea with the suggestion, consume the snapshot.
      //   Escape + active suggestion → dismiss only (LLM-abort path is
      //     ChatView's ESC handler which runs at document level + is gated
      //     by `streaming`; dismissing here does not interfere because ESC
      //     in idle state has no other Composer-side semantics).
      const suggestion = suggestedReplies?.text ?? null;
      const dismissed = suggestedReplies?.isDismissed ?? false;
      const hasSuggestion = suggestion !== null && !dismissed;
      const hasGhost = hasSuggestion && text.length === 0;

      if (
        e.key === "Tab" &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        hasGhost &&
        suggestion !== null
      ) {
        e.preventDefault();
        if (disabled) return;
        onTextChange(suggestion);
        acceptSuggestedReply();
        requestAnimationFrame(() => {
          if (taRef.current) {
            const pos = suggestion.length;
            taRef.current.setSelectionRange(pos, pos);
            taRef.current.focus();
          }
        });
        return;
      }

      if (e.key === "Escape" && hasSuggestion) {
        // Don't preventDefault — let the document-level ESC handler (ChatView) still run when streaming. Dismissing the snapshot
        // is additive.
        dismissSuggestedReplies();
        // Fall through so other ESC consumers still see the event.
      }

      // Backspace inside or at the trailing edge of a `[Image #N]` style
      // marker → delete the whole block in one keystroke (Slack chip UX).
      // Skip when a modifier is held so word-delete (alt+backspace) and
      // line-delete (cmd+backspace) keep their native semantics.
      if (
        e.key === "Backspace" &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        const ta = e.currentTarget;
        if (ta.selectionStart === ta.selectionEnd) {
          const range = findMarkerAt(text, ta.selectionStart);
          if (range) {
            e.preventDefault();
            const next = text.slice(0, range.start) + text.slice(range.end);
            onTextChange(next);
            requestAnimationFrame(() => {
              if (taRef.current) {
                taRef.current.setSelectionRange(range.start, range.start);
                taRef.current.focus();
              }
            });
            return;
          }
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          return;
        }

        e.preventDefault();
        if (disabled || sendDisabled) return;
        // Dismiss memory: a new user message means we are transitioning to the next turn — release the dismiss latch so the next
        // suggestion push renders fresh regardless of any prior Escape during this turn.
        clearDismissedReplies();
        onSend(captureUserKeyboardIntent());
      }
    },
    [
      captureUserKeyboardIntent,
      disabled,
      sendDisabled,
      onSend,
      text,
      onTextChange,
      suggestedReplies,
      inlineOpen,
      inlineMove,
      inlineAccept,
      inlineClose,
      // Include mention state in keyboard dependencies; catalog arrival alone can open the first menu and stale closures would
      // send a bare @.
      mentionOpen,
      mentionMove,
      mentionAccept,
      mentionClose,
      promptHistory,
    ],
  );

  const isFull = chipStripCount >= ATTACH_MAX_COUNT;
  const referenceAttachments = liveAttachments.filter((attachment): attachment is FileAttachment => attachment.kind === "file" && attachment.reference === true);
  const ordinaryAttachments = liveAttachments.filter((attachment) => attachment.kind !== "file" || !attachment.reference);
  const ghostText = suggestedReplies?.text ?? null;
  // Spec §3 line 42 + §8: ghost hidden when (a) user has typed any char, (b) IME composition active (preedit), (c) no
  // suggestion, or (d) dismissed.
  const ghostVisible =
    text.length === 0 &&
    !isComposing &&
    ghostText !== null &&
    !(suggestedReplies?.isDismissed ?? false);
  const fallbackPlaceholder = ghostVisible ? "" : t("composer.defaultPlaceholder");

  // Drop target. Only a FILE drag is claimed (types include "Files"); text and in-app drags keep their own behaviour. The
  // File objects go to the preload, which resolves and registers them with main — no path is read here.
  const isFileDrag = (e: ReactDragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const dropHandlers = onDropFiles && !disabled
    ? {
        onDragEnter: (e: ReactDragEvent) => {
          if (!isFileDrag(e)) return;
          e.preventDefault();
          setDropActive(true);
        },
        onDragOver: (e: ReactDragEvent) => {
          if (!isFileDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!dropActive) setDropActive(true);
        },
        onDragLeave: (e: ReactDragEvent) => {
          const next = e.relatedTarget as Node | null;
          if (next && e.currentTarget.contains(next)) return;
          setDropActive(false);
        },
        onDrop: (e: ReactDragEvent) => {
          if (!isFileDrag(e) && e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          setDropActive(false);
          if (e.dataTransfer.files.length > 0) onDropFiles(e.dataTransfer.files);
        },
      }
    : {};

  return (
    <div data-testid={TEST_IDS.composer} className="min-w-0" {...dropHandlers}>
      {referenceAttachments.length > 0 && (
        <div data-testid="composer-reference-strip" className="flex min-w-0 flex-wrap gap-1.5 px-3 pt-2 pb-1">
          {referenceAttachments.map((attachment) => (
            <AttachmentChip key={attachment.id} attachment={attachment} total={liveAttachments.length}
              onRemove={() => removeFileReference(attachment)} />
          ))}
        </div>
      )}
      <div
        data-testid={TEST_IDS.composerInputBar}
        className="relative flex min-w-0 w-full items-stretch gap-0 overflow-hidden"
      >
        {dropActive ? (
          // Inside the bar, never a ring on it: the bar clips with overflow-hidden.
          <div
            data-testid="composer-drop-overlay"
            aria-hidden="true"
            className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-lg border border-dashed border-input-bar-focus bg-input-bar text-caption text-input-bar-foreground"
          >
            {t("composer.dropHint")}
          </div>
        ) : null}
        {/* Strip is rendered ONLY when there is at least one attachment so
            the empty state does not reserve horizontal space. Single chip
            inline; 2+ collapse into a stacked card with an overlay. */}
        {ordinaryAttachments.length === 1 ? (
          <div
            data-testid="composer-strip"
            className="flex min-w-0 shrink-0 items-center pl-3 pr-0"
          >
            <AttachmentChip
              attachment={ordinaryAttachments[0]}
              total={liveAttachments.length}
              onOpenExternal={openExternal}
            />
          </div>
        ) : ordinaryAttachments.length >= 2 ? (
          <div
            data-testid="composer-strip"
            className="flex min-w-0 shrink-0 items-center pl-3 pr-0"
          >
            <AttachmentChipCollapsed
              attachments={ordinaryAttachments}
              onOpenExternal={openExternal}
            />
          </div>
        ) : null}

        <Textarea
          ref={taRef}
          data-testid={TEST_IDS.composerTextarea}
          data-composer-surface={surface}
          // SpotlightTour anchor. The first-boot tour pins step 1 + step 4 to
          // the MAIN textarea, so the attribute MUST remain stable there and
          // must not appear on the side chat's field. If it moves, update
          // `default-tour-scenarios.ts` in the same commit.
          {...(surface === "main" ? { "data-tour-anchor": "composer-input" } : {})}
          value={text}
          onChange={(e) => {
            onTextChange(e.target.value);
            syncCaret();
          }}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          // The chord is armed by a keydown and disarmed by the paste it
          // belongs to. If that paste never arrives — the OS swallowed the
          // accelerator, or focus moved on — leaving focus ends the chord too,
          // so a later context-menu paste (which has no keydown to disarm it)
          // cannot inherit an intent the user expressed for a different one.
          onBlur={() => {
            plainPasteRequestedRef.current = false;
            syncCaret();
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
            setIsComposing(true);
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
            setIsComposing(false);
            syncCaret();
          }}
          placeholder={placeholder ?? fallbackPlaceholder}
          className={
            "min-w-0 min-h-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none rounded-none px-4 py-2 text-body-sm text-input-bar-foreground caret-input-bar-action placeholder:text-body-sm placeholder:text-input-bar-placeholder " +
            TEXTAREA_MAX_HEIGHT_CLASS[surface]
          }
          rows={1}
        />
        <SuggestedRepliesGhost text={ghostText} visible={ghostVisible} />
      </div>
      {isFull ? (
        <div
          data-testid="composer-limit-warning"
          className="mt-1 text-caption text-destructive"
        >
          {t("composer.attachLimitWarning", { max: ATTACH_MAX_COUNT })}
        </div>
      ) : null}
      <InlineSlashMenu
        open={inlineOpen}
        items={inlineSlash.items}
        activeIndex={inlineSlash.activeIndex}
        anchorRef={taRef}
        onHover={inlineSlash.setActiveIndex}
        onSelect={inlineSlash.accept}
      />
      <ResourceMentionMenu
        open={mentionOpen}
        items={resourceMention.items}
        activeIndex={resourceMention.activeIndex}
        anchorRef={taRef}
        onHover={resourceMention.setActiveIndex}
        onSelect={resourceMention.accept}
      />
      {/*
        A template row needs values before anything is read, and the host chrome asks for
        them — never a composer draft, which would put the user's own submission between
        the offer and the read. The dialog hands back values only; the URI is main's.
      */}
      <McpResourceTemplateDialog
        pending={resourceMention.pendingTemplate}
        onCancel={resourceMention.cancelTemplate}
        onSubmit={resourceMention.submitTemplate}
      />
    </div>
  );
});

/**
 * The input box every composer sits in: the raised card whose edge is an
 * inset hairline, whose focus ring follows the field inside it, and whose
 * `input-bar-*` tokens the borderless textarea inherits. The main dock and the
 * side chat both draw this frame around `<Composer>` plus their action row —
 * it lives here so the two cannot drift into different chrome.
 */
export function ComposerFrame({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div
      data-testid="composer-frame"
      className={`${chatSurface()} relative z-10 overflow-hidden text-input-bar-foreground focus-within:border-input-bar-focus focus-within:ring-1 focus-within:ring-input-bar-focus`}
    >
      {children}
    </div>
  );
}

// Ghost text must not take pointer events or change caret behavior; honor reduced-motion preferences.

interface SuggestedRepliesGhostProps {
  text: string | null;
  visible: boolean;
}

function SuggestedRepliesGhost({ text, visible }: SuggestedRepliesGhostProps): ReactElement | null {
  const { t } = useTranslation();
  if (!visible || !text) return null;
  return (
    <div
      data-testid="suggested-replies-ghost"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-start px-4 py-2 text-body-sm text-input-bar-placeholder transition-opacity duration-(--motion-fast) ease-(--motion-ease-out) motion-safe:animate-in motion-safe:fade-in motion-reduce:transition-none"
    >
      <span className="truncate">{text}</span>
      <span className="ml-auto whitespace-nowrap pl-2 text-micro opacity-70">
        {t("suggestedRepliesGhost.tabToFill")}
      </span>
    </div>
  );
}
