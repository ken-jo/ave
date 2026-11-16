import { useCallback, useRef } from "react";
import type React from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import {
  ATTACH_MAX_COUNT,
  PASTE_TEXT_MAX_CHARS,
  type Attachment,
} from "../types/attachments.js";
import type { AttachmentRejection } from "../../../shared/attachment-rejection.js";
import { buildMarkerText } from "../utils/attachment-markers.js";
import { subscriptionImageAttachmentLimitViolation } from "../utils/subscription-runtime-ui-policy.js";
import type { ComposerHandle } from "../components/Composer.js";
import type { SubscriptionImageAttachmentLimits } from "../../../shared/subscription-runtime.js";

export interface UseAttachmentPickerParams {
  attachmentNCounter: { current: number };
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setQuestion: React.Dispatch<React.SetStateAction<string>>;
  composerRef: RefObject<ComposerHandle | null>;
  /** Native image input is allowed only after the selected runtime verifies it. */
  imagesEnabled?: boolean;
  /** File-marker attachment flow is allowed only after the selected runtime verifies it. */
  filesEnabled?: boolean;
  /** Exact main-verified native-image budget for the selected subscription runtime. */
  imageAttachmentLimits?: SubscriptionImageAttachmentLimits | null;
  /** Notify the user when a selected attachment type is not supported by the live runtime. */
  onAttachmentUnavailable?: () => void;
  /** Notify the user when a supported image exceeds its current runtime budget. */
  onImageAttachmentLimitExceeded?: () => void;
  /** Tell the user which picked, dropped or pasted files were not attached, each with its reason. Called once per attach, with
   * every file that attach lost. */
  onAttachmentRejected?: (rejections: readonly AttachmentRejection[]) => void;
  /** Notify the user that `attachPastedText` kept only part of a long text. */
  onPastedTextClipped?: (info: { keptChars: number; totalChars: number }) => void;
}

/** Share of {@link PASTE_TEXT_MAX_CHARS} kept from the start of a clipped text. */
const PASTE_CLIP_HEAD_SHARE = 0.25;

/** Bound a text bound for a pasted-text chip to {@link PASTE_TEXT_MAX_CHARS}: its start and its end survive, joined by a
 * line that says how much was cut. */
export function clipPastedText(text: string): { text: string; clipped: boolean } {
  if (text.length <= PASTE_TEXT_MAX_CHARS) return { text, clipped: false };
  // Reserve room for the gap line so the result itself stays within the cap.
  const gapFor = (omitted: number) => `\n[… ${omitted} characters omitted …]\n`;
  const budget = PASTE_TEXT_MAX_CHARS - gapFor(text.length).length;
  const headChars = Math.floor(budget * PASTE_CLIP_HEAD_SHARE);
  const tailChars = budget - headChars;
  const omitted = text.length - headChars - tailChars;
  return {
    text: `${text.slice(0, headChars)}${gapFor(omitted)}${text.slice(text.length - tailChars)}`,
    clipped: true,
  };
}

/** One authorized file, as the picker and a redeemed drop both describe it. */
interface PickedFile {
  path: string;
  name: string;
  ext: string;
  bytes: number;
  isImage: boolean;
  mimeType?: string;
}

export interface UseAttachmentPickerResult {
  handleAttach: () => Promise<void>;
  /** Attach files dropped on the composer. Hands the `File`s to the preload (which resolves and registers them with main in
   * one step), redeems the one-shot token, and commits through the SAME path as the picker. */
  handleDropFiles: (files: FileList | readonly File[]) => Promise<void>;
  /** Attach `text` as a pasted-text chip, as if the user had pasted it — the path for content another surface hands to the
   * composer (a terminal block). Returns false when the attachment cap is already reached. */
  attachPastedText: (text: string) => boolean;
  /** Save an image supplied by another host surface through the ordinary attachment path. */
  attachImage: (base64: string) => Promise<boolean>;
}

/** The names in `all` left after one occurrence of each name in `accounted` is taken out. File names repeat, so this is a
 * multiset difference. */
function unaccountedNames(all: readonly string[], accounted: readonly string[]): string[] {
  const remaining = [...all];
  for (const name of accounted) {
    const at = remaining.indexOf(name);
    if (at >= 0) remaining.splice(at, 1);
  }
  return remaining;
}

/** Read committed attachments in a separate synchronous flush before deciding the cap; React may defer updater execution
 * until after the callback returns. */
function readCommittedAttachments(
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>,
): Attachment[] {
  let committed: Attachment[] = [];
  flushSync(() => {
    setAttachments((prev) => {
      committed = prev;
      return prev;
    });
  });
  return committed;
}

/**
 * Owns the native attachment picker (window.ave.attach.openFile). The 5-cap
 * (ATTACH_MAX_COUNT) is enforced at *commit* time inside the setAttachments
 * updater, and the setAttachments + text-insert MUST land in a single flushSync
 * so Composer's marker-sync effect cannot run between them. Both invariants are
 * preserved verbatim here.
 */
export function useAttachmentPicker({
  attachmentNCounter,
  setAttachments,
  setQuestion,
  onAttachmentUnavailable,
  onImageAttachmentLimitExceeded,
  onAttachmentRejected,
  onPastedTextClipped,
  composerRef,
  imagesEnabled = true,
  filesEnabled = true,
  imageAttachmentLimits,
}: UseAttachmentPickerParams): UseAttachmentPickerResult {
  const capabilityRef = useRef({ imagesEnabled, filesEnabled, imageAttachmentLimits });
  capabilityRef.current.imagesEnabled = imagesEnabled;
  capabilityRef.current.filesEnabled = filesEnabled;
  capabilityRef.current.imageAttachmentLimits = imageAttachmentLimits;

  // Native attach uses window.ave, not aveApi; picker and drop share authorization, capability checks, commit-time caps and
  // atomic marker insertion.
  const commitFiles = useCallback(async (files: readonly PickedFile[], refusedEarlier: readonly AttachmentRejection[] = []) => {
    // Every file this attach loses, whoever refused it; reported once, on every way out.
    const rejections: AttachmentRejection[] = [...refusedEarlier];
    const reportRejections = () => {
      if (rejections.length > 0) onAttachmentRejected?.(rejections);
    };
    const candidateNames = new Map<string, string>();
    let unavailableAttachmentSkipped = false;
    let imageAttachmentLimitExceeded = false;
    // Build all candidate attachments first. The 5-cap is enforced at *commit*
    // time inside the setAttachments updater, so a concurrent clipboard paste
    // during the readImage await cannot push us past the limit (the updater
    // receives the latest committed state, not the closure-captured one).
    const candidates: Attachment[] = [];
    for (const f of files) {
      if ((f.isImage && !capabilityRef.current.imagesEnabled) || (!f.isImage && !capabilityRef.current.filesEnabled)) {
        // The picker can return mixed selections. Do not allocate a marker number or read an image before its verified runtime
        // capability gate.
        console.warn("attachment type is not available for the active runtime", f.path);
        unavailableAttachmentSkipped = true;
        continue;
      }
      const n = ++attachmentNCounter.current;
      if (f.isImage) {
        const img = await window.ave.attach.readImage(f.path);
        if (
          !img.ok ||
          !img.dataUrl ||
          !img.mimeType ||
          img.width === undefined ||
          img.height === undefined ||
          img.bytes === undefined
        ) {
          rejections.push({ name: f.name, reason: img.error === "image_too_large" ? "image-too-large" : "unreadable" });
          continue;
        }
        const candidateBudgetViolation = subscriptionImageAttachmentLimitViolation(
          capabilityRef.current.imageAttachmentLimits,
          [
            ...candidates
              .filter((attachment) => attachment.kind === "image")
              .map((attachment) => ({ bytes: attachment.bytes })),
            { bytes: img.bytes },
          ],
        );
        if (candidateBudgetViolation) {
          console.warn("image attachment exceeds current runtime budget", candidateBudgetViolation, f.path);
          imageAttachmentLimitExceeded = true;
          continue;
        }
        // The file dialog and image read are both asynchronous. Do not add an image selected under a previous runtime after
        // capability changes.
        if (!capabilityRef.current.imagesEnabled) {
          console.warn("image attachment capability changed before commit", f.path);
          unavailableAttachmentSkipped = true;
          continue;
        }
        const id = `img-${Date.now()}-${n}`;
        candidateNames.set(id, f.name);
        candidates.push({
          id,
          n,
          kind: "image",
          path: f.path,
          mimeType: img.mimeType,
          width: img.width,
          height: img.height,
          bytes: img.bytes,
          dataUrl: img.dataUrl,
        });
      } else {
        const id = `file-${Date.now()}-${n}`;
        candidateNames.set(id, f.name);
        candidates.push({
          id,
          n,
          kind: "file",
          path: f.path,
          name: f.name,
          ext: f.ext,
          bytes: f.bytes,
        });
      }
    }
    if (candidates.length === 0) {
      composerRef.current?.focus();
      if (imageAttachmentLimitExceeded) {
        if (onImageAttachmentLimitExceeded) onImageAttachmentLimitExceeded();
        else onAttachmentUnavailable?.();
      }
      if (unavailableAttachmentSkipped) onAttachmentUnavailable?.();
      reportRejections();
      return false;
    }
    // The cap and the image budget are checked against the latest committed list, read just before the commit (see
    // readCommittedAttachments).
    const prev = readCommittedAttachments(setAttachments);
    const currentCandidates = candidates.filter((attachment) =>
      attachment.kind === "image"
        ? capabilityRef.current.imagesEnabled
        : attachment.kind === "file"
          ? capabilityRef.current.filesEnabled
          : true,
    );
    const capabilityChangedBeforeCommit = currentCandidates.length !== candidates.length;
    const remaining = Math.max(0, ATTACH_MAX_COUNT - prev.length);
    const accepted: Attachment[] = [];
    for (const candidate of currentCandidates) {
      if (accepted.length >= remaining) {
        const name = candidateNames.get(candidate.id);
        if (name === undefined) throw new Error("attachment candidate has no recorded file name");
        rejections.push({ name, reason: "too-many" });
        continue;
      }
      if (candidate.kind === "image") {
        const images = [...prev, ...accepted]
          .filter((attachment) => attachment.kind === "image")
          .map((attachment) => ({ bytes: attachment.bytes }));
        if (
          subscriptionImageAttachmentLimitViolation(
            capabilityRef.current.imageAttachmentLimits,
            [...images, { bytes: candidate.bytes }],
          )
        ) {
          imageAttachmentLimitExceeded = true;
          continue;
        }
      }
      accepted.push(candidate);
    }
    // Atomic commit: setAttachments AND text-insert MUST land in the same
    // render commit, otherwise Composer's marker-sync useEffect runs between
    // the two and clears `attachments`. Putting both inside one flushSync
    // batches them so the next render sees attachments + marker text consistent.
    const acceptedMarkers = accepted.map((a) => `${buildMarkerText(a)} `).join("");
    if (acceptedMarkers) {
      flushSync(() => {
        setAttachments((latest) => [...latest, ...accepted]);
        if (composerRef.current) {
          composerRef.current.insertAtCursor(acceptedMarkers);
        } else {
          setQuestion((text) => text + acceptedMarkers);
        }
      });
    }
    if (imageAttachmentLimitExceeded) {
      if (onImageAttachmentLimitExceeded) onImageAttachmentLimitExceeded();
      else onAttachmentUnavailable?.();
    }
    if (unavailableAttachmentSkipped || capabilityChangedBeforeCommit) onAttachmentUnavailable?.();
    reportRejections();
    // Return focus to the composer textarea so the user can keep typing immediately after the file dialog closes.
    composerRef.current?.focus();
    return accepted.length > 0;
  }, [attachmentNCounter, composerRef, onAttachmentRejected, onAttachmentUnavailable, onImageAttachmentLimitExceeded, setAttachments, setQuestion]);

  const attachImage = useCallback(async (base64: string): Promise<boolean> => {
    if (!capabilityRef.current.imagesEnabled) {
      onAttachmentUnavailable?.();
      return false;
    }
    const saved = await window.ave.attach.saveClipboardImage(base64);
    if (!saved.ok || !saved.path) return false;
    const attached = await commitFiles([{ path: saved.path, name: "capture.png", ext: ".png", bytes: saved.bytes ?? 0, isImage: true }]);
    if (!attached) await window.ave.attach.discardClipboardImage(saved.path);
    return attached;
  }, [commitFiles, onAttachmentUnavailable]);

  const handleAttach = useCallback(async () => {
    const result = await window.ave.attach.openFile();
    if (result.canceled) return;
    await commitFiles(result.files, result.rejected);
  }, [commitFiles]);

  const handleDropFiles = useCallback(async (files: FileList | readonly File[]) => {
    const names = Array.from(files, (file) => file.name);
    if (names.length === 0) return;
    // Step 1 runs in the preload: it resolves OS-backed paths and registers them with main. This world never sees or sends a
    // path string.
    const prepared = await window.aveDrop.prepareFileDrop(files);
    const refusedAtRegister = prepared.rejected ?? [];
    if (!prepared.ok) {
      // Main names what it refused. With nothing named, no item had a path to register ("nothing-attachable") or the request
      // itself was refused.
      onAttachmentRejected?.(refusedAtRegister.length > 0
        ? refusedAtRegister
        : names.map((name) => ({ name, reason: prepared.error === "nothing-attachable" ? "no-file-path" : "refused" })));
      composerRef.current?.focus();
      return;
    }
    const registered = unaccountedNames(names, refusedAtRegister.map((rejection) => rejection.name));
    // Step 2: redeem the main-owned token; main authorizes exactly its files.
    const redeemed = await window.ave.attach.redeemDrop(prepared.token);
    if (!redeemed.ok) {
      onAttachmentRejected?.([
        ...refusedAtRegister,
        ...registered.map((name) => ({ name, reason: redeemed.error === "unauthorized" ? "refused" as const : "drop-expired" as const })),
      ]);
      composerRef.current?.focus();
      return;
    }
    // An item the preload found no path for was never sent to main, so main neither accepted nor refused it.
    const withoutPath = unaccountedNames(registered, redeemed.files.map((file) => file.name));
    await commitFiles(redeemed.files, [
      ...refusedAtRegister,
      ...withoutPath.map((name) => ({ name, reason: "no-file-path" as const })),
    ]);
  }, [commitFiles, composerRef, onAttachmentRejected]);

  const attachPastedText = useCallback((rawText: string): boolean => {
    const { text, clipped } = clipPastedText(rawText);
    // Allocated outside the updater, as handleAttach does: React may run an
    // updater twice (StrictMode), and a counter bumped inside it would skip
    // numbers. A number spent on a refused attach is harmless — `n` is only
    // ever required to be unique, never dense.
    const n = ++attachmentNCounter.current;
    const attachment: Attachment = {
      id: `paste-${Date.now()}-${n}`,
      n,
      kind: "paste",
      text,
      lines: text.split("\n").length,
      chars: text.length,
    };
    if (readCommittedAttachments(setAttachments).length >= ATTACH_MAX_COUNT) return false;
    // Same atomic commit as the picker: the chip and its marker land in one flushSync, so Composer's marker-sync effect never
    // sees one without the other. Nothing can run between the two synchronous flushes.
    const marker = `${buildMarkerText(attachment)} `;
    flushSync(() => {
      setAttachments((prev) => [...prev, attachment]);
      if (composerRef.current) composerRef.current.insertAtCursor(marker);
      else setQuestion((prev) => prev + marker);
    });
    composerRef.current?.focus();
    if (clipped) onPastedTextClipped?.({ keptChars: text.length, totalChars: rawText.length });
    return true;
  }, [attachmentNCounter, composerRef, onPastedTextClipped, setAttachments, setQuestion]);

  return { handleAttach, handleDropFiles, attachPastedText, attachImage };
}
