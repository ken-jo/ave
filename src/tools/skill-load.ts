/**
 * `skill_load` LLM tool — READS a skill (SKILL.md markdown w/ frontmatter) on
 * demand. Progressive disclosure: the system prompt carries only the skill
 * index (name + description); the body enters the context only as this
 * tool's result, so reading a skill is an explicit step the transcript shows
 * ("Read skill · <name>"). The tool name is kept for contract stability (the
 * Tailnet P1 block list and reviewer rules key on it).
 *
 * Security model (post C2 review + #1104 file-seed migration):
 *   - Skill bodies are NEVER appended to conversation history as `user`-role
 *     messages, and never spliced into the system prompt. The body is the
 *     tool_result (the data channel, like `read_file`), fenced with
 *     `<ave-skill name="…">…</ave-skill>` and fence-neutralized so provenance
 *     is unambiguous (see {@link renderSkillReadResult}).
 *   - Every skill — including seeded built-ins under `~/.ave/skills/`,
 *     which are user-editable on disk — runs through {@link ApprovalGate}
 *     on first load. Approval is persisted in `~/.ave/skills/approvals.json`
 *     and hash-bound to the current body so a post-approval body swap
 *     re-prompts (R2-CR-3 TOCTOU close).
 *   - Skill names are allowlisted to `[a-zA-Z0-9_-]+` and traversal-checked
 *     by {@link SkillStore} — see `skill-store.ts` for the file-side
 *     defenses.
 */
import { randomUUID } from "node:crypto";
import { t } from "../i18n/index.js";
import { createDynamicTool, type Tool } from "./base.js";
import type { SkillStore } from "../main/skill-store.js";
import { SKILL_SELECTOR_ALLOWLIST } from "../main/skill-store.js";
import { parsePluginSkillSelector } from "../shared/plugin-skill-selector.js";
import { renderSkillReadResult, type SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import { createLogger } from "../lib/logger.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
const log = createLogger("ave");

export interface SkillLoadEvent {
  name: string;
  description: string;
  /**
   * Conversation the loading turn belongs to. The badge rides a window-wide
   * channel, and a window holds several conversations at once, so without the
   * asking session every tile would wear every tile's skill badges.
   */
  sessionId: string;
}

/**
 * What the approval record is hash-bound to.
 *
 * The body alone stopped being sufficient once a skill can ship bundled files:
 * their NAMES render inside the `<ave-skill>` fence, so a bundle that gains
 * files while SKILL.md is unchanged would reach the model without re-prompting — the exact TOCTOU the body-hash binding exists to prevent.
 *
 * Scope: the body plus each bundled file's NAME and SIZE — i.e. exactly what the
 * `<ave-skill>` fence renders. Resource CONTENT is deliberately not covered; it
 * arrives only on a separate `skill_read` call.
 *
 * Two encodings live here — the bare body (no bundle) and a digest pair (bundle)
 * — so they are kept in SEPARATE key spaces by {@link approvalRecordKey}. Within
 * the bundle space the pair is unambiguous (fixed-width hex either side of `|`),
 * and across spaces a crafted body can no longer impersonate a pair because the
 * two never share a record key. Skills with no resources still hash the bare
 * body under the unchanged key, so existing approvals (all seeded built-ins,
 * which are flat files, included) stay valid.
 */
function approvalMaterial(skill: { body: string; resources: readonly { path: string; bytes: number }[] }): string {
  if (skill.resources.length === 0) return skill.body;
  const manifest = skill.resources
    .map((resource) => `${resource.path}:${resource.bytes}`)
    .sort()
    .join("\n");
  return `${sha256Hex(skill.body)}|${sha256Hex(manifest)}`;
}

/**
 * Which approval record {@link approvalMaterial} is stored under.
 *
 * Bundle-bearing approvals get their own namespace so the two material
 * encodings never share a key space (see `approvalMaterial`). Resource-bearing
 * skills are new, so no legacy record exists under the namespaced key and the
 * separation costs nothing; resource-less skills keep the original key and
 * their existing approvals.
 */
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
  /**
   * ApprovalGate for first-use prompts (user-authored skills only). Held by
   * value like every other gate wiring: the gate is constructed before the
   * builtin tools are registered, so there is nothing to late-bind.
   */
  approvalGate: ApprovalGate;
  /** Renderer event sink — used by the chat to render the SkillBadge. */
  emit: (event: SkillLoadEvent) => void;
  /** Exact generation lease held while the materialized body is read and registered. */
  acquirePluginGeneration?: (
    owner: { pluginId: string; localId: string },
  ) => Promise<{
    generation: import("../plugins/plugin-generation-coordinator.js").ActivePluginGeneration;
    release(): void;
  }>;
}

/** One category for the tool and for its body-approval request. */
const SKILL_LOAD_CATEGORY = "read" as const;

export function createSkillLoadTool(deps: SkillLoadToolDeps): Tool {
  return createDynamicTool({
    name: "skill_load",
    description: t("be_skillLoad.toolDescription"),
    source: "builtin",
    // A pure read: no filesystem mutation, and the body lands in a
    // tool_result (the data channel), not in the trusted system prompt. The
    // content-bound control is the body-hash approval below — every skill,
    // seeded built-ins included, still goes through the approval dock on its
    // first read and again whenever its body or bundle changes.
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
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const skillName = typeof a.skillName === "string" ? a.skillName.trim() : "";
      if (!skillName) {
        return {
          output: JSON.stringify({ error: "skillName is required" }),
          isError: true,
        };
      }
      // C2(b): allowlist check before doing any filesystem work — defense in
      // depth even though SkillStore enforces the same constraint on file
      // discovery.
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

      // C2(d): every skill body is user-editable on disk — seeded built-in
      // files included — so the approval gate runs uniformly. R2-CR-3:
      // hash-bind approval to the current body AND its bundled manifest (see
      // `approvalMaterial`). If the user approved an earlier body, or the
      // bundle has since gained/resized a file, `isApproved` returns false and
      // we re-prompt — closing the TOCTOU window where post-approval mutations
      // would silently inherit the previous "yes."
      const alreadyApproved = await deps.approvals.isApproved(
        approvalRecordKey(skill),
        approvalMaterial(skill),
      );
      if (!alreadyApproved) {
        const decision = await deps.approvalGate.requestAndWait({
          id: randomUUID(),
          category: "tool",
          toolName: "skill_load",
          // The tool's real category, so the dock describes a read. No
          // `allowedChoices` is set on purpose: away-authority answers only the
          // allow-once/deny-once one-shot contract, and an unseen skill body
          // must never be approved by an away grant on "read".
          toolCategory: SKILL_LOAD_CATEGORY,
          // Attribute the modal to the conversation loading the skill. The
          // missing-session case is still rejected further down, after the
          // user has decided — do not change that ordering here.
          ...(typeof ctx.metadata?.sessionId === "string" && ctx.metadata.sessionId
            ? { sessionId: ctx.metadata.sessionId }
            : {}),
          args: { skillName: skill.name },
          reason: t("be_skillLoad.approvalReason", { name: skill.name }),
          source: "builtin",
          createdAt: Date.now(),
        });
        if (decision.choice.startsWith("deny")) {
          return {
            output: JSON.stringify({
              error: `user denied skill load: ${skill.name}`,
            }),
            isError: true,
          };
        }
        // R2-CR-3: persist approval BOUND TO the current body + bundled
        // manifest. A later body swap, or a bundle file added/resized,
        // invalidates this record.
        await deps.approvals.approve(approvalRecordKey(skill), approvalMaterial(skill)).catch((err) => {
          log.warn(
            "skill_load: approval persistence failed (non-fatal): %s",
            (err as Error).message,
          );
        });
      }

      // R2-SEC-INFO: refuse to register a skill without a real session id.
      // Falling back to "unknown" piles unattributed skills under one synthetic
      // bucket and lets them leak across debug/test runs. The tool cannot
      // function correctly without session attribution, so error out.
      const sessionId =
        typeof ctx.metadata?.sessionId === "string" && ctx.metadata.sessionId
          ? (ctx.metadata.sessionId as string)
          : "";
      if (!sessionId) {
        return {
          output: JSON.stringify({
            error:
              "skill_load: missing sessionId in tool execution context (cannot attribute skill overlay)",
          }),
          isError: true,
        };
      }
      // Record the read for this conversation: `skill_read` authorizes bundled
      // resources against the identity captured here. The generation lease is
      // NOT held beyond this call — `skill_read` re-acquires and compares.
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
