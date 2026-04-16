/**
 * IPC Bridge — §4.1 Main ↔ Renderer ↔ Native
 *
 * 모든 IPC 핸들러를 등록하는 모듈.
 * main.ts에서 인라인으로 30개 핸들러를 두지 않고 여기에 집중.
 */
import { ipcMain, type BrowserWindow } from "electron";
import type { AppServices } from "./boot.js";
import type { ApprovalDecision } from "./permissions/approval-gate.js";
import { loadPolicy, savePolicy } from "./permissions/policy-store.js";

export function registerIpcHandlers(
  services: AppServices,
  getMainWindow: () => BrowserWindow | null,
): void {
  const {
    pluginRuntime,
    pluginMarketplace,
    taskService,
    settingsService,
    memoryManager,
    conversationLoop,
    approvalGate,
  } = services;

  // ─── Settings (벤더별 API 키) ────────────────────
  ipcMain.handle("ave:settings:get", () => settingsService.getAll());
  ipcMain.handle("ave:settings:update", (_e, partial) => {
    const result = settingsService.patch(partial);
    conversationLoop.refreshProvider();
    return result;
  });
  ipcMain.handle("ave:settings:set-api-key", (_e, vendor: string, apiKey: string) => {
    settingsService.setSecret(`llm.apiKey.${vendor}`, apiKey);
    conversationLoop.refreshProvider();
    return { ok: true };
  });
  ipcMain.handle("ave:settings:has-api-key", (_e, vendor?: string) => {
    const v = vendor ?? settingsService.get("llm").provider;
    return settingsService.getSecret(`llm.apiKey.${v}`) !== null;
  });
  ipcMain.handle("ave:settings:delete-api-key", (_e, vendor: string) => {
    settingsService.deleteSecret(`llm.apiKey.${vendor}`);
    conversationLoop.refreshProvider();
    return { ok: true };
  });

  // ─── Web Search Keys ───────────────────────────
  ipcMain.handle("ave:settings:set-web-api-key", (_e, provider: string, apiKey: string) => {
    settingsService.setSecret(`web.apiKey.${provider}`, apiKey);
    return { ok: true };
  });
  ipcMain.handle("ave:settings:has-web-api-key", (_e, provider: string) => {
    return settingsService.getSecret(`web.apiKey.${provider}`) !== null;
  });
  ipcMain.handle("ave:settings:delete-web-api-key", (_e, provider: string) => {
    settingsService.deleteSecret(`web.apiKey.${provider}`);
    return { ok: true };
  });

  // ─── Chat (ConversationLoop) ────────────────────
  ipcMain.handle("ave:chat:has-provider", () => conversationLoop.hasProvider());

  ipcMain.handle("ave:chat:send", async (_e, input: string) => {
    const win = getMainWindow();
    const result = await conversationLoop.runTurn(input, {
      onReasoningDelta: (text) => {
        win?.webContents.send("ave:chat:stream", { type: "reasoning_delta", text });
      },
      onTextDelta: (text) => {
        win?.webContents.send("ave:chat:stream", { type: "text_delta", text });
      },
      onAssistantRound: ({ roundIndex, text, thought, stopReason, hasToolCalls }) => {
        win?.webContents.send("ave:chat:stream", {
          type: "assistant_round",
          roundIndex,
          text,
          thought,
          stopReason,
          hasToolCalls,
        });
      },
      onToolStart: (name, toolInput, meta) => {
        win?.webContents.send("ave:chat:stream", { type: "tool_start", name, input: toolInput, ...meta });
      },
      onToolEnd: (name, toolResult, isError, meta) => {
        win?.webContents.send("ave:chat:stream", { type: "tool_end", name, result: toolResult, isError, ...meta });
      },
      onError: (error) => {
        win?.webContents.send("ave:chat:stream", { type: "error", error });
      },
    });
    win?.webContents.send("ave:chat:stream", { type: "done" });
    return result;
  });

  ipcMain.handle("ave:chat:new", () => {
    conversationLoop.newConversation();
    return { ok: true };
  });

  ipcMain.handle("ave:chat:sessions", () => ({
    current: conversationLoop.getSessionId(),
    sessions: conversationLoop.listSessions().slice(0, 20).map((s) => ({
      id: s.id,
      modifiedAt: s.modifiedAt.toISOString(),
    })),
  }));

  ipcMain.handle("ave:chat:load-session", (_e, sessionId: string) => {
    const loaded = conversationLoop.loadSession(sessionId);
    return { ok: loaded, sessionId: loaded ? sessionId : null };
  });

  // ─── Memory ─────────────────────────────────────
  ipcMain.handle("ave:memory:notes:list", () => memoryManager.listNotes());
  ipcMain.handle("ave:memory:notes:save", (_e, title: string, content: string) =>
    memoryManager.saveNote(title, content),
  );
  ipcMain.handle("ave:memory:notes:delete", (_e, filename: string) =>
    memoryManager.deleteNote(filename),
  );
  ipcMain.handle("ave:memory:notes:search", (_e, query: string) =>
    memoryManager.searchNotes(query),
  );
  ipcMain.handle("ave:memory:ave-md:get", () => memoryManager.getAveMd());
  ipcMain.handle("ave:memory:ave-md:update", (_e, content: string) =>
    memoryManager.updateAveMd(content),
  );
  ipcMain.handle("ave:memory:user-prefs:get", () => memoryManager.getUserPreferences());
  ipcMain.handle("ave:memory:user-prefs:update", (_e, content: string) =>
    memoryManager.updateUserPreferences(content),
  );

  // ─── Plugin Methods (proxy) ─────────────────────
  ipcMain.handle("ave:index:scan", () => pluginRuntime.call("index_scan"));
  ipcMain.handle("ave:index:documents", () => pluginRuntime.call("index_documents"));
  ipcMain.handle("ave:chat:preview", (_e, question: string) =>
    pluginRuntime.call("chat_preview", { question }),
  );
  ipcMain.handle("ave:meeting:start", (_e, sessionId: string, context?: unknown) =>
    pluginRuntime.call("meeting_start", { sessionId, context }),
  );
  ipcMain.handle("ave:meeting:push-chunk", (_e, sessionId: string, chunk: unknown) =>
    pluginRuntime.call("meeting_pushChunk", { sessionId, chunk }),
  );
  ipcMain.handle("ave:meeting:stop", (_e, sessionId: string) =>
    pluginRuntime.call("meeting_stop", { sessionId }),
  );
  ipcMain.handle("ave:meeting:transcript", (_e, sessionId: string) =>
    pluginRuntime.call("meeting_transcript", { sessionId }),
  );

  // ─── Marketplace ────────────────────────────────
  ipcMain.handle("ave:plugins:marketplace:list", () => pluginMarketplace.list());
  ipcMain.handle("ave:plugins:install", async (_e, pluginId: string) => {
    const result = await pluginMarketplace.install(pluginId);
    await pluginRuntime.restartAll();
    return result;
  });
  ipcMain.handle("ave:plugins:uninstall", async (_e, pluginId: string) => {
    const result = await pluginMarketplace.uninstall(pluginId);
    await pluginRuntime.restartAll();
    return result;
  });
  ipcMain.handle("ave:plugins:ui:list", () => pluginRuntime.listUiExtensions());
  ipcMain.handle("ave:plugins:call", (_e, method: string, payload?: unknown) =>
    pluginRuntime.call(method, payload),
  );

  // ─── MCP ──────────────────────────────────────
  ipcMain.handle("ave:mcp:servers", () => services.mcpManager.listServers());
  ipcMain.handle("ave:mcp:kill", (_e, serverId: string) => services.mcpManager.killSwitch(serverId));

  // ─── Permission Prompt (§6.3 Layer 3) ─────────
  ipcMain.handle("ave:permission:get-mode", () => {
    const mode = conversationLoop.permissionManager?.getMode() ?? "default";
    return { mode };
  });
  ipcMain.handle("ave:permission:set-mode", async (_e, mode: string) => {
    // §F8: whitelist 검증 — 유효하지 않은 mode는 거부
    const VALID_MODES = ["default", "strict", "auto"] as const;
    if (!VALID_MODES.includes(mode as typeof VALID_MODES[number])) {
      return { ok: false, error: "invalid-mode", message: `유효하지 않은 실행 모드: '${mode}'. 허용값: ${VALID_MODES.join(", ")}` };
    }
    const pm = conversationLoop.permissionManager;
    if (pm) {
      await pm.setModePersist(mode as import("./permissions/permission-manager.js").ExecutionMode);
    }
    return { ok: true, mode };
  });
  ipcMain.handle("ave:permission:list-rules", async () => {
    const pm = conversationLoop.permissionManager;
    if (!pm) return [];
    return pm.listPersistedRules();
  });
  ipcMain.handle("ave:permission:add-rule", async (_e, pattern: string, action: "allow" | "deny") => {
    // §F8: 입력 검증
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
      return { ok: false, error: "invalid-pattern", message: "패턴은 빈 문자열일 수 없습니다." };
    }
    if (pattern.length > 128) {
      return { ok: false, error: "invalid-pattern", message: "패턴은 128자를 초과할 수 없습니다." };
    }
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `유효하지 않은 action: '${action}'. 허용값: allow, deny` };
    }
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false };
    if (action === "allow") {
      await pm.addAlwaysAllowedPersist(pattern);
    } else {
      await pm.addAlwaysDeniedPersist(pattern);
    }
    return { ok: true };
  });
  ipcMain.handle("ave:permission:remove-rule", async (_e, pattern: string, action: "allow" | "deny") => {
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false };
    await pm.removeRule(pattern, action);
    return { ok: true };
  });

  // ─── Approval Gate (§6.3 Layer 3 + §8) ────────
  // ave:approval:request 방향은 main→renderer (webContents.send) — ipcMain.handle 불필요
  ipcMain.handle("ave:approval:respond", (_e, decision: ApprovalDecision) => {
    if (approvalGate) {
      approvalGate.resolve(decision.requestId, decision);
    }
    return { ok: true };
  });

  // ─── Policy (Governance) ──────────────────────
  ipcMain.handle("ave:policy:get", async () => {
    // §C2: LoadedPolicy (source, adminOverrides, adminPath 포함) 전체 반환
    return loadPolicy();
  });
  ipcMain.handle("ave:policy:set", async (_e, patch: Record<string, unknown>) => {
    // §F8: patch 검증 — managed 키 거부, requireExplicitApproval은 boolean만 허용
    if ("managed" in patch) {
      return { ok: false, error: "invalid-patch", message: "'managed' 필드는 사용자가 변경할 수 없습니다." };
    }
    if ("requireExplicitApproval" in patch && typeof patch.requireExplicitApproval !== "boolean") {
      return { ok: false, error: "invalid-patch", message: "'requireExplicitApproval'은 boolean이어야 합니다." };
    }
    try {
      // §C2: savePolicy(patch, userPath?, adminPath?) — admin-dir 존재 시 throw
      const updated = await savePolicy(patch as Parameters<typeof savePolicy>[0]);
      // 즉시 반영: ApprovalGate에 새 policy 주입
      if (approvalGate) {
        approvalGate.setPolicy(updated);
      }
      return { ok: true, policy: updated };
    } catch (err) {
      // managed 오류는 throw 대신 { ok: false, error: "managed" } 반환
      return { ok: false, error: "managed", message: (err as Error).message };
    }
  });

  // ─── Tasks ──────────────────────────────────────
  ipcMain.handle("ave:tasks:add", (_e, task) => taskService.add(task));
  ipcMain.handle("ave:tasks:update", (_e, id: string, patch) => taskService.update(id, patch));
  ipcMain.handle("ave:tasks:get", (_e, id: string) => taskService.get(id));
  ipcMain.handle("ave:tasks:delete", (_e, id: string) => taskService.delete(id));
  ipcMain.handle("ave:tasks:query", (_e, filter) => taskService.query(filter));
  ipcMain.handle("ave:tasks:pending", () => taskService.getPendingByPriority());
  ipcMain.handle("ave:tasks:overdue", () => taskService.getOverdue());
  ipcMain.handle("ave:tasks:today", () => taskService.getDueToday());

  // ─── Daily Briefing ──────────────────────────────
  ipcMain.handle("ave:briefing:get", () => conversationLoop.generateBriefing());
}
