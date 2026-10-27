/** Token budgets identify persisted rungs; request ceilings must not change qualitative intent. */
export const REASONING_EFFORT_RUNGS = [
  { key: "low", budget: 4_000 },
  { key: "medium", budget: 8_000 },
  { key: "high", budget: 16_000 },
  { key: "xhigh", budget: 32_000 },
  { key: "max", budget: 64_000 },
] as const;

export const REASONING_EFFORT_ORDER = ["none", "minimal", ...REASONING_EFFORT_RUNGS.map((rung) => rung.key)] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_ORDER)[number];

/** Legacy/custom token budgets choose the closest rung, ties downward. Zero means low when thinking is enabled; off is a separate switch. */
export function reasoningEffortForBudget(budget: number): (typeof REASONING_EFFORT_RUNGS)[number]["key"] {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("Invalid reasoning budget");
  return REASONING_EFFORT_RUNGS.reduce((closest, rung) =>
    Math.abs(rung.budget - budget) < Math.abs(closest.budget - budget) ? rung : closest,
  ).key;
}

export function assertReasoningEffort(value: string): asserts value is ReasoningEffort {
  if (!(REASONING_EFFORT_ORDER as readonly string[]).includes(value)) throw new Error("Invalid reasoning effort");
}
