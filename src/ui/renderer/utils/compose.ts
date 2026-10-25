import type { RolePreset } from "../../../data/role-presets.js";
import { buildActivePersonaPromptId } from "../../../data/role-presets.js";
import type { UserContentPart } from "../../../engine/llm/types.js";
import type { Attachment } from "../types/attachments.js";
import { buildMarkerText } from "./attachment-markers.js";

export interface ComposedOutgoing {
  /** Plain-text portion that becomes the textual body of the user turn. */
  text: string;
  /**
   * Multimodal user content parts (vision images today; reserved for inline
   * file payloads later). Empty array when no images were attached. The
   * caller passes this through the appropriate chat IPC surface
   * — the IPC layer forwards it to `runTurn(input, { attachments })`.
   */
  attachments: UserContentPart[];
  /** Per-turn Persona id; main resolves it from the file-backed prompt store. */
  personaPromptId?: string;
}

/** Keep image/resource markers and separate payload parts; augment file markers with paths and inline user pastes with
 * plain delimiters. Resource fences stay host-authored and verbatim. */
export function composeOutgoing(params: {
  raw: string;
  activePreset: RolePreset | null;
  attachments: Attachment[];
}): ComposedOutgoing {
  const { raw, activePreset, attachments } = params;

  let body = raw;

  // 1. Augment file markers with absolute path so the model can read via tool.
  //    Order matters: file augmentation runs FIRST so it sees only the user's
  //    own marker text. If we expanded paste markers first, the pasted body
  //    might contain a literal "[File #N]" substring (e.g. quoted code snippet)
  //    and our split/join would unintentionally augment it too.
  for (const att of attachments) {
    if (att.kind !== "file") continue;
    const marker = buildMarkerText(att);
    const augmented = `[File #${att.n} — path: ${att.path}]`;
    body = body.split(marker).join(augmented);
  }

  // Match edited paste line-count suffixes rather than rebuilt original markers; file augmentation must already have run on
  // the original body.
  for (const att of attachments) {
    if (att.kind !== "paste") continue;
    const re = new RegExp(`\\[Pasted text #${att.n}(?:\\s+\\+\\d+\\s+lines)?\\]`, "g");
    const replacement = `\n\n----- Pasted text #${att.n} (${att.lines} lines) -----\n${att.text}\n----- end Pasted text #${att.n} -----\n\n`;
    // Replacer FUNCTION (not string) — `String.prototype.replace`'s string
    // form interprets `$&`, `$1`, `$$`, etc. as backreference tokens. The
    // pasted text could contain literal `$` sequences (regex snippets,
    // template literals, currency, etc.) and we must not mutate them.
    body = body.replace(re, () => replacement);
  }

  // 3. Image attachments become vision parts.
  const imageParts: UserContentPart[] = attachments
    .filter((a): a is Extract<Attachment, { kind: "image" }> => a.kind === "image")
    .map((img) => ({
      type: "image",
      image: img.dataUrl,
      mimeType: img.mimeType,
      width: img.width,
      height: img.height,
      bytes: img.bytes,
    }));

  // Keep host-built resource fences in separate content parts so main can enforce its bound; preserve text verbatim until
  // main applies any configured PII redaction.
  const resourceParts: UserContentPart[] = attachments
    .filter((a): a is Extract<Attachment, { kind: "resource" }> => a.kind === "resource")
    .map((res) => ({ type: "text", text: res.text }));

  return {
    text: body,
    attachments: [...imageParts, ...resourceParts],
    personaPromptId: buildActivePersonaPromptId(activePreset) ?? undefined,
  };
}

/**
 * Compose a plugin-imported trigger exactly as the plugin runtime emitted it.
 * Imported triggers already carry their overlay trigger provenance envelope; adding
 * role presets or the user's current composer attachments would change both
 * authorship and trust-origin classification.
 */
export function composeImportedTriggerOutgoing(raw: string): ComposedOutgoing {
  return {
    text: raw,
    attachments: [],
  };
}
