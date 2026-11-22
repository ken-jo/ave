import "./setup.js";
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { installSettingsEditor } from "../../src/__tests__/support/settings-editor-fixture.js";

import { PermissionJudgeContent } from "../../src/ui/renderer/components/permissions/PermissionJudgeContent.js";
import type { PermissionJudgeSettings } from "../../src/shared/permission-judge-settings.js";

afterEach(() => { vi.unstubAllGlobals(); });

function installJudge() {
  const fixture = installSettingsEditor();
  let current = { ok: true as const, settings: {
    model: null, chain: [], mode: "shadow", categories: { shell: true, write: true, network: false },
    timeoutMs: 15_000, chainDeadlineMs: 60_000, breaker: { consecutive: 3, total: 20 },
  } as PermissionJudgeSettings, issues: [], modelOptions: [], chatModel: null, reviewerModelUnavailable: false, storedChainRejected: false };
  const listeners = new Set<() => void>();
  const judgeGet = vi.fn(async () => current);
  const judgeSet = vi.fn(async (patch: Partial<PermissionJudgeSettings>) => {
    current = { ...current, settings: { ...current.settings, ...patch } };
    for (const listener of listeners) listener();
    return current;
  });
  Object.assign(fixture.ns.permission, { judgeGet, judgeSet, onConfigChanged: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }) });
  return { ...fixture, change: () => {
    current = { ...current, settings: { ...current.settings, mode: "active", chain: [{ id: "review", provider: "builtin-llm" }] } };
    for (const listener of listeners) listener();
  } };
}

it("reads a saved evaluator after its panel remounts in the same editor", async () => {
  const fixture = installJudge();
  const view = render(fixture.content(<PermissionJudgeContent />));
  const mode = await view.findByLabelText("Custom evaluation behavior");
  expect(mode).toHaveValue("off");
  fireEvent.change(mode, { target: { value: "active" } });
  await waitFor(() => expect(fixture.saved).toHaveBeenCalledOnce());
  expect(mode).toHaveValue("active");
  view.rerender(fixture.content(null));
  view.rerender(fixture.content(<PermissionJudgeContent />));
  expect(await view.findByLabelText("Custom evaluation behavior")).toHaveValue("active");
});

it("invalidates evaluator reads when another window changes them while the panel is absent", async () => {
  const fixture = installJudge();
  const view = render(fixture.content(<PermissionJudgeContent />));
  expect(await view.findByLabelText("Custom evaluation behavior")).toHaveValue("off");
  view.rerender(fixture.content(null));
  act(() => fixture.change());
  view.rerender(fixture.content(<PermissionJudgeContent />));
  expect(await view.findByLabelText("Custom evaluation behavior")).toHaveValue("active");
});
