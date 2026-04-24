/**
 * Phase 1 — renderApp helper.
 *
 * Stubs window.aveApi / window.ave with the provided overrides, renders
 * <App /> via @testing-library/react, returns the mock fns so tests can
 * assert IPC calls.
 */
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import {
  makeMockAveApi,
  makeMockAveNamespace,
  type MockAveApi,
} from "./mock-ave-api.js";

type RenderAppOpts = Parameters<typeof makeMockAveApi>[0];

export type RenderAppReturn = {
  container: RenderResult["container"];
  rerender: RenderResult["rerender"];
  unmount: RenderResult["unmount"];
  api: MockAveApi;
  emitChatStream: (ev: unknown) => void;
  emitRoutineBriefing: (b: unknown) => void;
  emitViewActivate: (v: string) => void;
  emitApproval: (r: unknown) => void;
};

export async function renderApp(opts: RenderAppOpts = {}): Promise<RenderAppReturn> {
  const { api, emitChatStream, emitRoutineBriefing, emitViewActivate } = makeMockAveApi(opts);
  const { ns, emitApproval } = makeMockAveNamespace();

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
    emitRoutineBriefing,
    emitViewActivate,
    emitApproval,
  };
}
