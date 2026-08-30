/**
 * renderApp helper.
 *
 * Stubs window.aveApi / window.ave with the provided overrides, renders
 * <App /> via @testing-library/react, returns the mock fns so tests can
 * assert IPC calls.
 */
// Registers RTL's `afterEach(cleanup)` (plus the jsdom polyfills) for EVERY
// consumer of this harness. Rendering the whole App and never unmounting it
// leaves its effects — including real timers — running past the end of the test
// file, and they then fire into a destroyed jsdom. Importing it here rather than
// asking each suite to remember means a new suite cannot forget.
import "./setup.js";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import {
  makeMockAveApi,
  makeMockAveNamespace,
  type MockAveApi,
} from "./mock-ave-api.js";

type RenderAppOpts = Parameters<typeof makeMockAveApi>[0] & {
  aveEnv?: Partial<{
    isDev: boolean;
    isE2E: boolean;
    enableDevConsole: boolean;
    debugStream: boolean;
  }>;
  /** Approval requests the host is already parked on when the window mounts. */
  pendingApprovals?: unknown[];
};

export type RenderAppReturn = {
  container: RenderResult["container"];
  rerender: RenderResult["rerender"];
  unmount: RenderResult["unmount"];
  api: MockAveApi;
  emitChatStream: (ev: unknown) => void;
  emitAgentSpawnEvent: ReturnType<typeof makeMockAveApi>["emitAgentSpawnEvent"];
  emitSkillLoaded: ReturnType<typeof makeMockAveApi>["emitSkillLoaded"];
  emitOverlayShow: (item: unknown) => void;
  emitOverlayDismiss: (id: string) => void;
  emitRoutineFired: (r: unknown) => void;
  emitPluginEvent: (eventType: string, payload: unknown) => void;
  emitViewActivate: (v: string, settingsTab?: string) => void;
  emitAskUserQuestion: (r: unknown) => void;
  emitApproval: (r: unknown) => void;
  emitPluginRuntimeUpdated: (payload: { pluginId: string }) => void;
  emitNotificationToast: (payload: unknown) => void;
  emitNotificationClicked: (payload: unknown) => void;
};

export async function renderApp(opts: RenderAppOpts = {}): Promise<RenderAppReturn> {
  const { aveEnv, pendingApprovals, ...apiOpts } = opts;
  const {
    api,
    emitChatStream,
    emitAgentSpawnEvent,
    emitSkillLoaded,
    emitOverlayShow,
    emitOverlayDismiss,
    emitRoutineFired,
    emitPluginEvent,
    emitViewActivate,
    emitAskUserQuestion,
    emitPluginRuntimeUpdated,
    emitNotificationToast,
    emitNotificationClicked,
  } = makeMockAveApi(apiOpts);
  const { ns, emitApproval } = makeMockAveNamespace({ env: aveEnv, pendingApprovals });

  vi.stubGlobal("aveApi", api);
  vi.stubGlobal("ave", ns);
  (window as unknown as { aveApi: MockAveApi }).aveApi = api;
  (window as unknown as { ave: unknown }).ave = ns;

  const { App } = await import("../../src/renderer.js");
  const result = render(<App />);

  return {
    container: result.container,
    rerender: result.rerender,
    unmount: result.unmount,
    api,
    emitChatStream,
    emitAgentSpawnEvent,
    emitSkillLoaded,
    emitOverlayShow,
    emitOverlayDismiss,
    emitRoutineFired,
    emitPluginEvent,
    emitViewActivate,
    emitAskUserQuestion,
    emitApproval,
    emitPluginRuntimeUpdated,
    emitNotificationToast,
    emitNotificationClicked,
  };
}
