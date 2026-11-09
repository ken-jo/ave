export type BrowserPipPresentation = "preview" | "chip" | "hidden";
export interface BrowserPipStackPlan { previewCount: number; chipCount: number; summaryCount: number }

/** Counts follow newest-first order. Reserve access to remaining tabs when at least one chip fits. */
export function planBrowserPipStack(count: number, compact: boolean,
  sizes: { height: number; previewHeight: number; chipHeight: number; gap: number }): BrowserPipStackPlan {
  const { height, previewHeight, chipHeight, gap } = sizes;
  if (count <= 0 || chipHeight <= 0 || previewHeight <= 0 || height < chipHeight) {
    return { previewCount: 0, chipCount: 0, summaryCount: 0 };
  }
  const usedHeight = (previews: number, chips: number) => previews * previewHeight + chips * chipHeight
    + Math.max(0, previews + chips - 1) * gap;
  for (let previewCount = compact ? 0 : count; previewCount >= 0; previewCount--) {
    const remaining = count - previewCount;
    if (usedHeight(previewCount, remaining) <= height) return { previewCount, chipCount: remaining, summaryCount: 0 };
    for (let chipCount = remaining - 1; chipCount >= 0; chipCount--) {
      if (usedHeight(previewCount, chipCount + 1) <= height) {
        return { previewCount, chipCount, summaryCount: remaining - chipCount };
      }
    }
  }
  return { previewCount: 0, chipCount: 0, summaryCount: 0 };
}
