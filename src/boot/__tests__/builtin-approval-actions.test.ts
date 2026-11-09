import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinTools, registerRequestPluginMetaTool, registerToolSearchMetaTool } from "../tools.js";
import { bootstrapCoreServices } from "../services.js";
import { tmpdir } from "node:os";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { BUILTIN_APPROVAL_ACTIONS } from "../../ui/renderer/components/permissions/builtin-approval-action.js";
import { isRecord } from "../../shared/is-record.js";
import { approvalAction } from "../../ui/renderer/components/permissions/approval-action.js";
import type { ApprovalRequest } from "../../ui/renderer/types.js";
import { getLocale, setLocale, t } from "../../i18n/runtime.js";

const originalLocale = getLocale();
afterEach(() => { setLocale(originalLocale); });

vi.mock("../../core/model-catalog/bundled.js", () => ({ installBootModelCatalog: vi.fn(async () => {}) }));
vi.mock("../../main/python-runtime.js", () => ({ PythonRuntimeBootstrapper: class {} }));
vi.mock("../../main/bash-ast-validator.js", () => ({ BashAstValidator: class {} }));
vi.mock("../../main/audit-service.js", () => ({ AuditService: class { async start() {} } }));
vi.mock("../../main/app-shutdown.js", () => ({ registerShutdownHook: vi.fn() }));
vi.mock("../../lib/log-file-sink.js", () => ({
  LOG_RETENTION_DAYS: 7, LOG_MAX_BYTES: 1000, reprunePersistedRetention: vi.fn(),
}));
vi.mock("../../data/settings-store.js", () => ({ SettingsService: class {
  get(key: string) { return key === "appearance" ? { language: "en" } : {}; }
  async migrateSecrets() {}
  async deleteRetiredLlmVendorApiKeys() {}
} }));
vi.mock("../../memory/memory-manager.js", () => ({ MemoryManager: class {
  sessions = { verifyOrRebuildSearchIndex: async () => {}, closeSearchIndex() {} };
  load() {}
  startPersistentContextWatcher() {}
  stopPersistentContextWatcher() {}
  getDir() { return tmpdir(); }
} }));
vi.mock("../../memory/memory-usage-log.js", () => ({ MemoryUsageLog: class {} }));
vi.mock("../../memory/memory-save-notices.js", () => ({ MemorySaveNotices: class { setSink() {} } }));
vi.mock("../../memory/memory-capture-service.js", () => ({ MemoryCaptureService: class {} }));

async function registeredBuiltins() {
  // Run the actual registration paths; only infrastructure with disk/process side effects is replaced.
  const { toolRegistry: registry, settingsService } = await bootstrapCoreServices(null, {
    userDataPath: tmpdir(), systemLocale: "en", isPackaged: false,
  } as Parameters<typeof bootstrapCoreServices>[1]);
  const available = {};
  registerBuiltinTools(registry, settingsService, {
    networkFetch: unusedNetworkFetch, singleHopNetworkFetch: unusedNetworkFetch,
    getAskUserQuestionGate: () => undefined, getSubAgentRunner: () => undefined, emitAgentSpawn: vi.fn(),
    routinesStore: available, routineScheduleDeps: available, sessionTasksStore: available, sessionGoalStore: available,
    agentProfileStore: available, terminalRead: available, terminalRun: available, browser: available,
    getAgentSendRuntime: () => undefined, skillStore: available, emitSkillLoad: vi.fn(),
    skillOverlay: available, skillApprovalsStore: available, approvalGate: available,
    getMcpResourceAccess: () => undefined,
  } as unknown as Parameters<typeof registerBuiltinTools>[2]);
  registerRequestPluginMetaTool(registry);
  registerToolSearchMetaTool(registry);
  return registry;
}

function request(toolName: string, args: Record<string, unknown> = {}): ApprovalRequest {
  return { id: "action", category: "tool", kind: "tool", toolName, source: "builtin", toolCategory: "write", args,
    reason: "Explicit approval", createdAt: 0, requireExplicit: true, allowedChoices: ["allow-once", "deny-once"] };
}

describe("builtin approval action coverage", () => {
  it.each(["en", "ko"] as const)("summarizes every tool registered by core and workflow boot in %s", async (locale) => {
    const tools = (await registeredBuiltins()).listAll().filter(tool => tool.source === "builtin");
    setLocale(locale);
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["extract_archive", "memory_delete", "browser_navigate", "skill_load", "terminal_run"]));
    expect(tools.filter(tool => !Object.hasOwn(BUILTIN_APPROVAL_ACTIONS, tool.name)).map(tool => tool.name)).toEqual([]);
    const missing = tools.flatMap(tool => {
      const action = approvalAction(request(tool.name), t);
      return action.title === t("toolApprovalDialog.toolApprovalTitle") || !action.primary?.trim() ? [tool.name] : [];
    });
    expect(missing).toEqual([]);
    for (const tool of tools) {
      if (!Object.hasOwn(BUILTIN_APPROVAL_ACTIONS, tool.name)) continue;
      const descriptor = BUILTIN_APPROVAL_ACTIONS[tool.name as keyof typeof BUILTIN_APPROVAL_ACTIONS];
      const schema = tool.toJsonSchema();
      const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
      const fields = descriptor.fields.filter(field => Object.hasOwn(properties, field));
      expect(fields.length > 0 || Object.keys(properties).length === 0, tool.name).toBe(true);
      if (fields.length === 0) continue;
      const subject = `subject-${tool.name}`;
      const value = descriptor.kind === "patch" ? `*** Begin Patch\n*** Add File: ${subject}\n+text\n*** End Patch`
        : descriptor.kind === "questions" ? [{ question: subject }] : subject;
      const action = approvalAction(request(tool.name, { [fields[0] ?? ""]: value }), t);
      expect(action.primary, tool.name).toContain(subject);
    }
  });

  it.each([
    ["extract_archive", { archivePath: "/workspace/source.tar", destinationPath: "/workspace/unpacked" }, ["/workspace/source.tar", "/workspace/unpacked"]],
    ["memory_delete", { id: "memory-42" }, ["memory-42"]],
    ["browser_navigate", { tabId: "browser:2", url: "https://destination.example/path" }, ["https://destination.example/path"]],
  ] as const)("describes the actual subject of %s", (name, args, subjects) => {
    const action = approvalAction(request(name, args), t);
    expect(action.title).not.toBe(t("toolApprovalDialog.toolApprovalTitle"));
    for (const subject of subjects) expect(action.primary).toContain(subject);
  });

  it.each(["future_builtin", "__proto__", "constructor"])("never routes builtin %s through the external execution fallback", (name) => {
    const action = approvalAction(request(name, { path: "/workspace/report.md" }), t);
    expect(action.title).not.toBe(t("toolApprovalDialog.toolApprovalTitle"));
    expect(action.primary?.trim()).toBeTruthy();
  });

  it("describes an existing agent's resumption", () => {
    const action = approvalAction(request("agent_spawn", { resumeId: "child-42" }), t);
    expect(action.title).toBe(t("toolApprovalDialog.resumeActionTitle"));
    expect(action.primary).toContain("child-42");
  });

  it.each(["mcp", "plugin"] as const)("retains the generic execution fallback for unattributed %s tools", (source) => {
    const action = approvalAction({ ...request("external_action"), source }, t);
    expect(action.title).toBe(t("toolApprovalDialog.toolApprovalTitle"));
    expect(action.primary).toBeNull();
  });
});
