// Only the host registers categories and derives per-call risk; descriptors are pure and perform no I/O or plugin execution. Registry weights feed review and the shared matrix feeds permission/audit consumers (docs/architecture/permission-policy-design.md).
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

// Register before tools. Strict asks even for reads/headless; mutating categories ask by default, review in auto/headless and allow only after hard gates. Meta is host-only, with builtin override handling and external sources denied; shell AST validation belongs to the executor.
export function registerStandardCategories(): void {
  registerToolCategory({
    name: "read",
    riskWeight: 0.1,
    decisionFor: ({ mode }) => (mode === "strict" ? "ask" : "allow"),
  });

  registerToolCategory({
    name: "write",
    riskWeight: 0.6,
    decisionFor: ({ mode, headless }) => {
      if (mode === "allow") return "allow";
      if (mode === "strict") return "ask";
      if (headless) return "reviewer";
      return "ask";
    },
  });

  registerToolCategory({
    name: "shell",
    riskWeight: 0.9,
    decisionFor: ({ mode, headless }) => {
      if (mode === "allow") return "allow";
      if (mode === "strict") return "ask";
      if (headless) return "reviewer";
      return "ask";
    },
  });

  registerToolCategory({
    name: "network",
    riskWeight: 0.7,
    decisionFor: ({ mode, headless }) => {
      if (mode === "allow") return "allow";
      if (mode === "strict") return "ask";
      if (headless) return "reviewer";
      return "ask";
    },
  });

  registerToolCategory({
    name: "meta",
    riskWeight: 0.0,
    decisionFor: ({ source }) => source === "builtin" ? "override" : "deny",
  });
}

// Auto-register at module import — tests and ad-hoc callers that instantiate PermissionManager directly (without going through boot/conversation.ts) still get a populated registry. Boot still invokes registerStandardCategories explicitly; these calls are idempotent.
registerStandardCategories();
