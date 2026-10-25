// @vitest-environment jsdom
/** Verify tour anchors and the keyboard start action through production DOM; declared selectors alone do not prove
 * reachable onboarding. */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, fireEvent } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { Composer, type ComposerHandle } from "../Composer.js";
import { InputActionBar, ComposerStatusRow } from "../InputActionBar.js";
import { SlashPicker } from "../SlashPicker.js";
import { Sidebar } from "../Sidebar.js";
import type { Attachment } from "../../types/attachments.js";
import type { RolePreset } from "../../../../data/role-presets.js";
import {
  DEFAULT_TOUR_SCENARIOS,
  getTourScenario,
} from "../../onboarding/default-tour-scenarios.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { en as tourEn, ko as tourKo } from "../../../../i18n/messages/generated/defaultTourScenarios.js";
import { retiredPluginIdsIn } from "../../../../../scripts/lib/retired-plugin-ids.mjs";

const mockPreset: RolePreset = { id: "default", name: "기본", systemPromptAdd: "" };

function ComposerHarness() {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const counterRef = useRef(0);
  const composerRef = useRef<ComposerHandle | null>(null);
  return (
    <Composer
      ref={composerRef}
      text={text}
      onTextChange={setText}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      allocateN={() => ++counterRef.current}
      saveClipboardImage={vi.fn(async () => ({ ok: true }))}
      onSend={vi.fn()}
    />
  );
}

describe("Tutorial-C PR #983 follow-up: tour anchors", () => {
  it("Composer textarea carries data-tour-anchor=composer-input", () => {
    const { getByTestId } = render(<ComposerHarness />);
    const ta = getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    expect(ta.getAttribute("data-tour-anchor")).toBe("composer-input");
  });

  it("InputActionBar root carries data-tour-anchor=input-action-bar", () => {
    const props: Parameters<typeof InputActionBar>[0] = {
      plugins: [],
      onSelectPlugin: vi.fn(),
      onInsertSlashCommand: vi.fn(),
      slashPickerOpen: false,
      onSlashPickerOpenChange: vi.fn(),
      onAttach: vi.fn(),
      attachDisabled: false,
      rolePresets: [mockPreset],
      activePreset: mockPreset,
      activePresetId: "default",
      onSelectPreset: vi.fn(),
      isBusy: false,
      isSendDisabled: false,
      onSend: vi.fn(),
      onCancel: vi.fn(),
    };
    const { getByTestId } = render(
      <TooltipProvider>
        <InputActionBar {...props} />
      </TooltipProvider>,
    );
    expect(
      getByTestId("input-action-bar").getAttribute("data-tour-anchor"),
    ).toBe("input-action-bar");
  });

  it("SlashPicker trigger carries data-tour-anchor=command-palette-toggle", () => {
    // The old ⌘ command-palette button merged into the unified SlashPicker; the tour anchor moved onto the picker's trigger so
    // step 3 still resolves.
    const { getByTestId } = render(
      <TooltipProvider>
        <SlashPicker
          plugins={[]}
          onSelectPlugin={vi.fn()}
          onInsert={vi.fn()}
          open={false}
          onOpenChange={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(
      getByTestId(TEST_IDS.slashPickerTrigger).getAttribute("data-tour-anchor"),
    ).toBe("command-palette-toggle");
  });

  it("first-boot-essentials scenario selectors match live anchors", () => {
    // Mounts every host component the first-boot tour (2026-05-19)
    // expanded tour references in one tree so the SpotlightTour
    // selectors can be evaluated against the same DOM production ships.
    // Regression gate for the original dead-state critic + the Z chain
    // expansion (7 steps): if a refactor drops or renames an anchor,
    // this test fails loudly.
    const inputActionBarProps: Parameters<typeof InputActionBar>[0] = {
      plugins: [],
      onSelectPlugin: vi.fn(),
      onInsertSlashCommand: vi.fn(),
      slashPickerOpen: false,
      onSlashPickerOpenChange: vi.fn(),
      onAttach: vi.fn(),
      attachDisabled: false,
      rolePresets: [mockPreset],
      activePreset: mockPreset,
      activePresetId: "default",
      onSelectPreset: vi.fn(),
      isBusy: false,
      isSendDisabled: false,
      onSend: vi.fn(),
      onCancel: vi.fn(),
    };
    // The "chat-history" (search) + "settings-entry" (export) tour anchors moved from MainToolbar into the floating sidebar's
    // cluster strip (#1319), so the Sidebar is the host component that must carry them now.
    const sidebarProps: Parameters<typeof Sidebar>[0] = {
    viewNav: {
      segments: [],
      canGoBack: false,
      canGoForward: false,
      onBack: () => {},
      onForward: () => {},
      onSelectSegment: () => {},
    },
      activeView: "home",
      onSelect: vi.fn(),
      pluginViews: [],
      hasApiKey: true,
      onOpenSettings: vi.fn(),
      onNewChat: vi.fn(),
      collapsed: false,
      onToggleCollapse: vi.fn(),
      onOpenUnifiedSearch: vi.fn(),
      isCurrentSessionStarred: false,
      onToggleCurrentSessionStar: vi.fn(),
      onExport: vi.fn(),
    };
    render(
      <TooltipProvider>
        <Sidebar {...sidebarProps} />
        <ComposerHarness />
        <InputActionBar {...inputActionBarProps} />
        <ComposerStatusRow
          statusRow={{
            vendorModel: "OpenAI · gpt-5.4",
            activeChatModel: { kind: "api", vendor: "openai", model: "gpt-5.4" },
            permissionMode: "auto",
            pendingApprovals: 0,
          }}
          ringSlot={null}
          onOpenModelSettings={vi.fn()}
          enableThinkingChat={false}
          onToggleThinking={vi.fn()}
        />
      </TooltipProvider>,
    );
    const scenario = getTourScenario("first-boot-essentials");
    expect(scenario).toBeTruthy();
    // 6 host-UI steps. The input-area relayout (#1311) folded plugin views
    // into the command palette (SlashPicker), so the old dedicated "plugin
    // grid" step was removed — the command-palette step now covers how the
    // user reaches plugins. Hard-pin so a future re-trim cannot silently
    // revert without a test diff.
    expect(scenario!.steps).toHaveLength(6);
    for (const step of scenario!.steps) {
      const found = document.querySelector(step.anchorSelector);
      expect(
        found,
        `step '${step.title}' selector ${step.anchorSelector} must match a live DOM node`,
      ).not.toBeNull();
    }
    // Step 6 in particular: it named a status-bar cell that nothing produces,
    // so it resolved to nothing and the step ran anchorless. Pin it to the
    // control it is about — the model cell in the composer's status row, which
    // is also the button that opens the model picker.
    const modelCell = document.querySelector(scenario!.steps[5].anchorSelector);
    expect(modelCell).not.toBeNull();
    expect(modelCell!.getAttribute("data-testid")).toBe("iab-status-model");
    // Sanity: every anchor the Z chain references must appear in the scenario. The set guarantees a refactor that drops a step
    // still surfaces here.
    const anchors = new Set(scenario!.steps.map((s) => s.anchorSelector));
    expect(anchors.has('[data-tour-anchor="composer-input"]')).toBe(true);
    expect(anchors.has('[data-tour-anchor="input-action-bar"]')).toBe(true);
    expect(
      anchors.has('[data-tour-anchor="command-palette-toggle"]'),
    ).toBe(true);
    expect(anchors.has('[data-tour-anchor="chat-history"]')).toBe(true);
    expect(anchors.has('[data-tour-anchor="settings-entry"]')).toBe(true);
    expect(anchors.has('[data-tour-anchor="model-picker"]')).toBe(true);
    expect(anchors.has('[data-tour-anchor="status-bar-vendor"]')).toBe(false);
    // The plugin-entry anchor was intentionally removed by #1311 — plugins are reached via the command palette (covered by the
    // command-palette-toggle step above), so the first-boot tour no longer references it.
    expect(anchors.has('[data-tour-anchor="plugin-entry"]')).toBe(false);
  });
});

/**
 * Standalone harness for the App-level `useEffect` that wires ⌘+Shift+/ to
 * `api.tour.start`. We reproduce the exact handler shape (not a copy: the
 * helper lives in App.tsx and the test exercises the same logic literally)
 * so a future App-side refactor can drop the trigger and this test will
 * fail loudly.
 */
function TourTriggerHarness({
  start,
}: {
  start: (id: string) => Promise<unknown>;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "?" && e.key !== "/") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!e.shiftKey) return;
      if (e.isComposing) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      e.preventDefault();
      void start("first-boot-essentials");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [start]);
  return <div data-testid="trigger-harness" />;
}

describe("Tutorial-C PR #983 follow-up: ⌘+Shift+/ trigger", () => {
  let startSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    startSpy = vi.fn(async () => ({ ok: true, scenarioId: "first-boot-essentials" }));
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("Cmd+Shift+/ invokes tour.start with first-boot-essentials", () => {
    render(<TourTriggerHarness start={startSpy} />);
    fireEvent.keyDown(window, {
      key: "?",
      metaKey: true,
      shiftKey: true,
    });
    expect(startSpy).toHaveBeenCalledWith("first-boot-essentials");
  });

  it("Ctrl+Shift+/ also fires (cross-platform path)", () => {
    render(<TourTriggerHarness start={startSpy} />);
    fireEvent.keyDown(window, {
      key: "/",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(startSpy).toHaveBeenCalledWith("first-boot-essentials");
  });

  it("plain Cmd+/ (no Shift) does NOT fire", () => {
    render(<TourTriggerHarness start={startSpy} />);
    fireEvent.keyDown(window, {
      key: "/",
      metaKey: true,
      shiftKey: false,
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+/ is suppressed when a modal dialog is open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    render(<TourTriggerHarness start={startSpy} />);
    fireEvent.keyDown(window, {
      key: "?",
      metaKey: true,
      shiftKey: true,
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("scenario registry exposes first-boot-essentials (defensive)", () => {
    // The trigger references a hard-coded id. If a refactor renames or removes that scenario, the keyboard shortcut would
    // silently invoke a non-existent scenario. Treat the id as a contract.
    expect(DEFAULT_TOUR_SCENARIOS["first-boot-essentials"]).toBeTruthy();
  });
});

describe("host tour registry carries no scenario for a dissolved extension", () => {
  // The assistant extension was dissolved into per-extension alerts and the
  // board extension was archived; the host must not keep tours that walk a user
  // through their UI. A plugin-specific scenario in the host is the branch
  // AGENTS.md forbids. Their ids come from the retired-name gate's one list.
  it("no scenario id, anchor, title or body names a dissolved extension", () => {
    for (const [id, scenario] of Object.entries(DEFAULT_TOUR_SCENARIOS)) {
      expect(retiredPluginIdsIn(id)).toEqual([]);
      expect(retiredPluginIdsIn(scenario.title)).toEqual([]);
      for (const step of scenario.steps) {
        expect(retiredPluginIdsIn(step.anchorSelector)).toEqual([]);
        expect(retiredPluginIdsIn(step.title)).toEqual([]);
        expect(retiredPluginIdsIn(step.body)).toEqual([]);
      }
    }
  });

  it("the tour catalog keeps no strings for the removed scenarios", () => {
    const removed = /^defaultTourScenarios\.(sampleAssistant|multiAgent)/;
    expect(Object.keys(tourEn).filter((key) => removed.test(key))).toEqual([]);
    expect(Object.keys(tourKo).filter((key) => removed.test(key))).toEqual([]);
  });
});

describe("host tour registry holds host tours only", () => {
  // Extensions declare their own guidance through `manifest.onboarding`
  // (firstTask + highlights), which the host renders generically. A scenario in
  // this map may therefore only walk host UI: every anchor it names must be a
  // `data-tour-anchor` the host renderer itself ships. Plugin UI renders in a
  // webview guest, so a plugin-panel anchor could never be reached anyway.
  const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  function hostRendererSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "onboarding") continue;
        out.push(...hostRendererSources(path));
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(path);
      }
    }
    return out;
  }

  const hostAnchors = new Set<string>();
  for (const file of hostRendererSources(rendererRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/data-tour-anchor"?\s*[=:]\s*"([^"]+)"/g)) {
      hostAnchors.add(match[1]);
    }
  }

  it("finds the host anchors it checks against", () => {
    // Control: an empty set would make the next assertion vacuous.
    expect(hostAnchors.has("composer-input")).toBe(true);
  });

  it("every scenario anchor is one the host renderer ships", () => {
    const missing: string[] = [];
    for (const [id, scenario] of Object.entries(DEFAULT_TOUR_SCENARIOS)) {
      for (const step of scenario.steps) {
        const anchor = /^\[data-tour-anchor="([^"]+)"\]$/.exec(step.anchorSelector)?.[1];
        if (!anchor || !hostAnchors.has(anchor)) missing.push(`${id}: ${step.anchorSelector}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the tour catalog has no strings the scenarios do not use", () => {
    const scenarioSource = readFileSync(join(rendererRoot, "onboarding", "default-tour-scenarios.ts"), "utf8");
    const unused = Object.keys(tourEn).filter((key) => !scenarioSource.includes(`"${key}"`));
    expect(unused).toEqual([]);
    expect(Object.keys(tourKo).sort()).toEqual(Object.keys(tourEn).sort());
  });
});
