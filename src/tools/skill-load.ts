// Skill bodies are neutralized, fenced tool data, never user messages or trusted system-prompt additions.
// Content-bound approval covers editable seeded skills; selector allowlists and store traversal checks constrain access.
import { randomUUID } from "node:crypto";
import { t } from "../i18n/index.js";
import { createDynamicTool, type Tool } from "./base.js";
import type { SkillStore } from "../main/skill-store.js";
import { SKILL_SELECTOR_ALLOWLIST } from "../main/skill-store.js";
import { parsePluginSkillSelector } from "../shared/plugin-skill-selector.js";
import { renderSkillReadResult, type SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import { isHostApprovalRejectedDecision, type ApprovalGate } from "../permissions/approval-gate.js";
import { isRemoteControllerBoundToSession, remoteControllerOriginOf } from "../shared/chat-origin.js";
import { turnExtensionPolicyContext } from "../shared/turn-extension-policy.js";
import { createLogger } from "../lib/logger.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
const log = createLogger("ave");

export interface SkillLoadEvent {
  name: string;
  description: string;
  // Attribute window-wide skill badges to the loading conversation so other tiles cannot inherit them.
  sessionId: string;
}

// Bind approval to body plus bundled names and sizes shown in the fence; resource bytes require separate reads.
// Keep flat-body and bundled-digest encodings in separate key spaces while preserving existing flat approvals.
function approvalMaterial(skill: { body: string; resources: readonly { path: string; bytes: number }[] }): string {
  if (skill.resources.length === 0) return skill.body;
  const manifest = skill.resources
    .map((resource) => `${resource.path}:${resource.bytes}`)
    .sort()
    .join("\n");
  return `${sha256Hex(skill.body)}|${sha256Hex(manifest)}`;
}

// Namespace bundled approval records so digest material cannot collide with flat bodies; retain legacy flat keys.
function approvalRecordKey(skill: {
  name: string;
  approvalKey?: string;
  resources: readonly { path: string; bytes: number }[];
}): string {
  const base = skill.approvalKey ?? skill.name;
  return skill.resources.length === 0 ? base : `${base}#bundled`;
}

export interface SkillLoadToolDeps {
  store: SkillStore;
  /** Per-conversation registry of read skills — authorizes `skill_read`. */
  overlay: SkillOverlay;
  /** Persistent allowlist for user-authored skills. */
  approvals: SkillApprovalsStore;
  // First-use approval gate is constructed before tool registration and needs no late binding.
  approvalGate: ApprovalGate;
  emit: (event: SkillLoadEvent) => void;
  /** Exact generation lease held while the materialized body is read and registered. */
  acquirePluginGeneration?: (
    owner: { pluginId: string; localId: string },
  ) => Promise<{
    generation: import("../plugins/plugin-generation-coordinator.js").ActivePluginGeneration;
    release(): void;
  }>;
}

const SKILL_LOAD_CATEGORY = "read" as const;

export function createSkillLoadTool(deps: SkillLoadToolDeps): Tool {
  return createDynamicTool({
    name: "skill_load",
    description: t("be_skillLoad.toolDescription"),
    source: "builtin",
    // Read-only tool results still require content-bound approval on first load and whenever body or bundle changes.
    category: SKILL_LOAD_CATEGORY,
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["skillName"],
      properties: {
        skillName: {
          type: "string",
          description: t("be_skillLoad.skillNameDescription"),
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const remoteControllerAuthority = turnExtensionPolicyContext.getStore()?.remoteControllerAuthority;
      const remoteControllerOrigin = remoteControllerOriginOf(remoteControllerAuthority);
      const sessionId = typeof ctx.metadata?.sessionId === "string" ? ctx.metadata.sessionId : "";
      const controllerCurrent = () => isRemoteControllerBoundToSession(remoteControllerAuthority, sessionId);
      const revoked = () => ({ output: JSON.stringify({ error: "Remote controller authority was revoked or is not bound to this session" }), isError: true });
      if (!controllerCurrent()) return revoked();
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const skillName = typeof a.skillName === "string" ? a.skillName.trim() : "";
      if (!skillName) {
        return {
          output: JSON.stringify({ error: "skillName is required" }),
          isError: true,
        };
      }
      // Check selector allowlists before any filesystem work, independently of store discovery checks.
      if (!SKILL_SELECTOR_ALLOWLIST.test(skillName)) {
        return {
          output: JSON.stringify({
            error: `invalid skillName: must match ${SKILL_SELECTOR_ALLOWLIST.source}`,
          }),
          isError: true,
        };
      }
      // Same parser the turn-scope gate uses (src/shared/plugin-skill-selector.ts).
      const selectorMatch = parsePluginSkillSelector(skillName);
      if (selectorMatch && !deps.acquirePluginGeneration) {
        return {
          output: JSON.stringify({
            error: "skill_load: plugin generation access unavailable",
          }),
          isError: true,
        };
      }
      const generationLease = selectorMatch
        ? await deps.acquirePluginGeneration!({
            pluginId: selectorMatch.pluginId,
            localId: selectorMatch.localId,
          })
        : undefined;
      const skill = generationLease
        ? deps.store.loadPluginGeneration(generationLease.generation, skillName)
        : await deps.store.load(skillName);
      if (!skill) {
        generationLease?.release();
        return {
          output: JSON.stringify({ error: `skill not found: ${skillName}` }),
          isError: true,
        };
      }

      try {
      // Editable skill bodies and bundled names/sizes must match approved material; any change requires approval again.
      const alreadyApproved = await deps.approvals.isApproved(
        approvalRecordKey(skill),
        approvalMaterial(skill),
      );
      if (!alreadyApproved) {
        const decision = await deps.approvalGate.requestAndWait({
          id: randomUUID(),
          category: "tool",
          toolName: "skill_load",
          // Leave allowedChoices unset so loading unseen skill bodies retains its own approval contract.
          toolCategory: SKILL_LOAD_CATEGORY,
          // Attribute approval to the loading session; preserve rejection of missing identity after the user's decision.
          ...(typeof ctx.metadata?.sessionId === "string" && ctx.metadata.sessionId
            ? { sessionId: ctx.metadata.sessionId }
            : {}),
          remoteControllerAuthority, remoteControllerOrigin,
          args: { skillName: skill.name },
          reason: t("be_skillLoad.approvalReason", { name: skill.name }),
          source: "builtin",
          createdAt: Date.now(),
        });
        if (!controllerCurrent()) return revoked();
        const rejected = Boolean(isHostApprovalRejectedDecision(decision));
        if (rejected || decision.choice.startsWith("deny")) {
          return {
            output: JSON.stringify({
              error: `user denied skill load: ${skill.name}`,
            }),
            isError: true,
          };
        }
        // Persist body-and-manifest-bound approval so swaps and added/resized files invalidate it.
        await deps.approvals.approve(approvalRecordKey(skill), approvalMaterial(skill)).catch((err) => {
          log.warn(
            "skill_load: approval persistence failed (non-fatal): %s",
            (err as Error).message,
          );
        });
      }

      // Refuse missing session identity; a shared synthetic bucket would leak skill attribution across calls.
      if (!controllerCurrent()) return revoked();
      if (!sessionId) {
        return {
          output: JSON.stringify({
            error:
              "skill_load: missing sessionId in tool execution context (cannot attribute skill overlay)",
          }),
          isError: true,
        };
      }
      // Record approved identity in this conversation's overlay; skill_read reacquires and compares generation rather than retaining the lease.
      deps.overlay.register(sessionId, skill);

      deps.emit({
        name: skill.name,
        description: skill.description,
        sessionId,
      });
      return {
        output: renderSkillReadResult(skill),
        isError: false,
      };
      } finally {
        generationLease?.release();
      }
    },
  });
}
