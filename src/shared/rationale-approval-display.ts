/** Reject controls, invisible formatting, and line separators that could hide or reorder consent context. */
const UNSAFE_RATIONALE_APPROVAL_DISPLAY_UNICODE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Normalize explanatory text before DLP masking and audit projection. */
export function normalizeRationaleApprovalDisplayText(value: string): string {
  return value
    .normalize("NFC")
    .replace(UNSAFE_RATIONALE_APPROVAL_DISPLAY_UNICODE, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Bounds shared by the host audit and resume projection. */
export const RATIONALE_DISPLAY_CAPS = Object.freeze({
  toolName: 256,
  targetItems: 32,
  targetLength: 1_024,
  listItems: 8,
  listLength: 160,
  authorityLength: 160,
  reasonLength: 500,
  suggestionLength: 500,
});
