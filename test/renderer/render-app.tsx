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
  /** Which groups' loops were released — see `makeMockAveApi`. */
  releasedGroupIds: () => string[];
  emitChatStream: (ev: unknown) => void;
  emitChatFallback: ReturnType<typeof makeMockAveApi>["emitChatFallback"];
  emitAgentSpawnEvent: ReturnType<typeof makeMockAveApi>["emitAgentSpawnEvent"];
  emitSkillLoaded: ReturnType<typeof makeMockAveApi>["emitSkillLoaded"];
  emitSessionTasksChanged: ReturnType<typeof makeMockAveApi>["emitSessionTasksChanged"];
  emitOverlayShow: (item: unknown) => void;
  emitOverlayDismiss: (id: string) => void;
  emitRoutineFired: (r: unknown) => void;
  emitRoutineRunningStarted: (p: unknown) => void;
  emitPluginEvent: (eventType: string, payload: unknown) => void;
  emitViewActivate: (v: string, settingsTab?: string) => void;
  emitAskUserQuestion: (r: unknown) => void;
  emitApproval: (r: unknown) => void;
  /** The host retired a parked request — see `ave:approval:settled`. */
  emitApprovalSettled: (requestId: string) => void;
  emitPluginRuntimeUpdated: (payload: { pluginId: string }) => void;
  emitNotificationToast: (payload: unknown) => void;
  emitNotificationClicked: (payload: unknown) => void;
};

/**
 * Seed the app mode the shell reads before first paint ("work" is the harness
 * default), and return the undo. Lives here rather than in each suite because
 * two suites spelling the same seed is exactly what the duplicate-helper gate
 * refuses — and a second spelling could drift from the preload key.
 */
export function startInChatMode(): () => void {
  (window as { __aveInitialAppMode?: string }).__aveInitialAppMode = "chat";
  return () => {
    delete (window as { __aveInitialAppMode?: string }).__aveInitialAppMode;
  };
}

export async function renderApp(opts: RenderAppOpts = {}): Promise<RenderAppReturn> {
  const { aveEnv, pendingApprovals, ...apiOpts } = opts;
  const {
    api,
    releasedGroupIds,
    emitChatStream,
    emitChatFallback,
    emitAgentSpawnEvent,
    emitSkillLoaded,
    emitSessionTasksChanged,
    emitOverlayShow,
    emitOverlayDismiss,
    emitRoutineFired,
    emitRoutineRunningStarted,
    emitPluginEvent,
    emitViewActivate,
    emitAskUserQuestion,
    emitPluginRuntimeUpdated,
    emitNotificationToast,
    emitNotificationClicked,
  } = makeMockAveApi(apiOpts);
  const { ns, emitApproval, emitApprovalSettled } = makeMockAveNamespace({ env: aveEnv, pendingApprovals });

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
    releasedGroupIds,
    emitChatStream,
    emitChatFallback,
    emitAgentSpawnEvent,
    emitSkillLoaded,
    emitSessionTasksChanged,
    emitOverlayShow,
    emitOverlayDismiss,
    emitRoutineFired,
    emitRoutineRunningStarted,
    emitPluginEvent,
    emitViewActivate,
    emitAskUserQuestion,
    emitApproval,
    emitApprovalSettled,
    emitPluginRuntimeUpdated,
    emitNotificationToast,
    emitNotificationClicked,
  };
}

/**
 * Whether the app is showing the conversation rather than a view.
 *
 * The conversations stay MOUNTED across view navigation — a tile subscribes to
 * its group's stream when it mounts, so unmounting them to show another view
 * would drop the frames of a turn still running. "At home" is therefore whether
 * the surface is SHOWING, not whether it exists.
 *
 * It lives here rather than in each suite because check-test-duplicates rejects
 * the same helper body in two test files.
 */
export function atHome(container: HTMLElement): boolean {
  return container
    .querySelector('[data-testid="chat-surface"]')
    ?.getAttribute("data-visible") === "true";
}
