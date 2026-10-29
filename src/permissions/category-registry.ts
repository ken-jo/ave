// Only the host registers categories and derives per-call risk; descriptors are pure and perform no I/O or plugin execution. Registry weights feed review and the shared matrix feeds permission/audit consumers (docs/architecture/permission-policy-design.md).
import { decidePermission } from "./decision-pipeline.js";
import type { ToolCategory, ToolSource } from "../tools/types.js";

export type CategoryDecision = "allow" | "ask" | "deny" | "reviewer" | "override";

export interface CategoryDecisionInput {
  mode: "default" | "auto" | "strict" | "allow";
  source: ToolSource;
  headless: boolean;
}

export interface ToolCategoryDescriptor {
  name: ToolCategory;
  // 0..1 — rule classifier baseline weight.
  riskWeight: number;
  // Pure function — given mode/source/headless, returns the lane the executor should follow. Builtin `meta` returns the `"override"` sentinel so the host reads `tool.decisionOverride`; external `meta` is denied.
  decisionFor: (input: CategoryDecisionInput) => CategoryDecision;
}

const _registry = new Map<ToolCategory, ToolCategoryDescriptor>();
let _categoryGeneration = 0;

export function registerToolCategory(d: ToolCategoryDescriptor): void {
  _registry.set(d.name, d);
  _categoryGeneration += 1;
}

export function getCategoryRegistryGeneration(): string {
  return String(_categoryGeneration);
}

export function getToolCategoryDescriptor(name: ToolCategory): ToolCategoryDescriptor {
  const d = _registry.get(name);
  if (!d) {
    throw new Error(
      `Unknown tool category '${name}' — registry uninitialized or category missing. ` +
      `Call registerStandardCategories() at boot before tool registration.`,
    );
  }
  return d;
}

export function listKnownCategories(): ToolCategory[] {
  return Array.from(_registry.keys());
}

export function clearCategoryRegistry(): void {
  if (_registry.size > 0) _categoryGeneration += 1;
  _registry.clear();
}

// Descriptors expose risk metadata; all policy outcomes come from the shared pipeline.
export function registerStandardCategories(): void {
  const weights: Record<ToolCategory, number> = { read: 0.1, write: 0.6, shell: 0.9, network: 0.7, meta: 0 };
  for (const name of Object.keys(weights) as ToolCategory[]) {
    registerToolCategory({
      name,
      riskWeight: weights[name],
      decisionFor: ({ mode, source, headless }) => {
        if (name === "meta") return source === "builtin" ? "override" : "deny";
        const result = decidePermission({ tool: { name, source, kind: name }, mode, headless });
        if (result.reviewRequired) return "reviewer";
        return result.outcome === "ask-forced" ? "ask" : result.outcome === "sandbox-auto" ? "allow" : result.outcome;
      },
    });
  }
}

// Auto-register at module import — tests and ad-hoc callers that instantiate PermissionManager directly (without going through boot/conversation.ts) still get a populated registry. Boot still invokes registerStandardCategories explicitly; these calls are idempotent.
registerStandardCategories();
