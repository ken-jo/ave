import { estimateTokens } from "./token-estimate.js";

export type MultimodalTokenEstimatePart = {
  type: string;
  text?: string;
  image?: string;
  data?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  bytes?: number;
};

/** Keep shared user content structural so engine-only message types do not enter renderer bundles. */
export type UserContentForTokenEstimate = string | readonly MultimodalTokenEstimatePart[];

/** Represent payload bytes with stable markers and account for multimodal overhead separately. */
export function serializeUserContentForEstimation(content: UserContentForTokenEstimate): string {
  const contentForEstimation = typeof content === "string"
    ? content
    : content
        .map((part) =>
          part.type === "text"
            ? (part.text ?? "")
            : `[${part.type}:${part.type === "image" ? (part.mimeType ?? "image") : part.mimeType}]`,
        )
        .join("\n");
  return JSON.stringify({ role: "user", content: contentForEstimation });
}

export function estimateUserMessageTokens(content: UserContentForTokenEstimate): number {
  return estimateTokens(serializeUserContentForEstimation(content)) +
    (typeof content === "string" ? 0 : estimateMultimodalTokenOverhead(content));
}

/** Undefined means unsendable; do not charge synthetic empty-message wrapper cost. */
export function toUserContentForEstimation(
  text: string,
  attachments: readonly MultimodalTokenEstimatePart[] = [],
): UserContentForTokenEstimate | undefined {
  if (text.length === 0 && attachments.length === 0) return undefined;
  return attachments.length === 0 ? text : [{ type: "text", text }, ...attachments];
}

export function estimateOutgoingUserMessageTokens(
  text: string,
  attachments: readonly MultimodalTokenEstimatePart[] = [],
): number {
  const content = toUserContentForEstimation(text, attachments);
  return content === undefined ? 0 : estimateUserMessageTokens(content);
}

export function estimateMultimodalTokenOverhead(parts: readonly MultimodalTokenEstimatePart[]): number {
  return parts.reduce((sum, part) => {
    if (part.type === "image") return sum + estimateImageTokens(part);
    if (part.type === "file") return sum + estimateDataTokens(part.data);
    return sum;
  }, 0);
}

function estimateImageTokens(part: MultimodalTokenEstimatePart): number {
  const width = normalizeMultimodalTokenEstimateDimension(part.width) ?? 1024;
  const height = normalizeMultimodalTokenEstimateDimension(part.height) ?? 1024;
  const tiles = Math.max(1, Math.ceil(width / 512) * Math.ceil(height / 512));
  return 85 + tiles * 170;
}

function estimateDataTokens(data: string | undefined): number {
  if (!data) return 0;
  return Math.ceil(data.length / 4) + 1;
}

/** Bound untrusted image metadata before tile estimation. */
export function normalizeMultimodalTokenEstimateDimension(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(8192, Math.ceil(value));
}
