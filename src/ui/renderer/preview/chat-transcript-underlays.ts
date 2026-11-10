import { requestWebSurfaceLayout } from "./web-surfaces.js";

interface TranscriptUnderlay {
  host: HTMLElement;
  stage: HTMLElement;
}

const underlays = new Set<TranscriptUnderlay>();
const stageClips = new Map<HTMLElement, string>();

/** A portaled work panel owns the transcript in its originating conversation. */
export function registerChatTranscriptUnderlay(host: HTMLElement, stage: HTMLElement): () => void {
  const entry = { host, stage };
  if (!stageClips.has(stage)) stageClips.set(stage, stage.style.clipPath);
  underlays.add(entry);
  requestWebSurfaceLayout();
  return () => {
    if (!underlays.delete(entry)) return;
    if (![...underlays].some(candidate => candidate.stage === stage)) {
      stage.style.clipPath = stageClips.get(stage) ?? "";
      stageClips.delete(stage);
    }
    requestWebSurfaceLayout();
  };
}

/** Resolve the nearest registered panel host, including panels outside their chat DOM branch. */
export function chatTranscriptUnderlaysFor(slot: HTMLElement): ReadonlySet<HTMLElement> {
  for (let ancestor: HTMLElement | null = slot; ancestor; ancestor = ancestor.parentElement) {
    const stages = new Set([...underlays].filter(entry => entry.host === ancestor).map(entry => entry.stage));
    if (stages.size > 0) return stages;
  }
  return new Set();
}

/** Only transcript paint changes; decisions, composer and the native viewport are separate siblings. */
export function applyChatTranscriptUnderlayClips(clips: ReadonlyMap<HTMLElement, string>): void {
  for (const [stage, original] of stageClips) {
    const clip = clips.get(stage) || original;
    if (stage.style.clipPath !== clip) stage.style.clipPath = clip;
  }
}
