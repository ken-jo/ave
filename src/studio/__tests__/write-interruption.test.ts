// @vitest-environment jsdom
import "../../../test/renderer/setup.js";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fault = vi.hoisted(() => ({ after: 0, calls: 0 }));
vi.mock("../../main/storage/feature-namespace.js", async () => {
  const actual = await vi.importActual<typeof import("../../main/storage/feature-namespace.js")>("../../main/storage/feature-namespace.js");
  return { ...actual, writeFileAtomicAtPath: async (...args: Parameters<typeof actual.writeFileAtomicAtPath>) => {
    await actual.writeFileAtomicAtPath(...args);
    fault.calls += 1;
    if (fault.calls === fault.after) throw new Error(`Injected failure after Studio write ${fault.calls}`);
  } };
});

import { PluginStudioStore } from "../store.js";
import { createPluginStudioTools } from "../../tools/plugin-studio.js";
import { previewStudioConnector } from "../connector.js";
import { PluginStudioView } from "../../ui/renderer/tabs/git-marketplace/PluginStudioView.js";
import { t } from "../../i18n/runtime.js";
import type { PluginStudioApi, StudioDraftView } from "../../shared/plugin-studio.js";

const originalHome = process.env.AVE_HOME;
const roots: string[] = [];
const name = "team-kit";
const initialSkill = "---\nname: review\ndescription: Review work\n---\nReview work.\n";
const changedSkill = "---\nname: review\ndescription: Review work\n---\nReview the changed work.\n";
const prompt = "---\nname: summary\ndescription: Summarize\nkind: template\n---\nSummarize {args}\n";
const update = { name, version: "1.0.1", files: [
  { path: "skills/review/SKILL.md", text: changedSkill },
  { path: "ai.agent-connector.ave/prompts/summary.md", text: prompt },
] };

async function reviewedDraft(): Promise<{ store: PluginStudioStore; digest: string }> {
  const root = await mkdtemp(join(tmpdir(), "ave-studio-interruption-"));
  roots.push(root);
  process.env.AVE_HOME = join(root, "home");
  fault.after = 0;
  fault.calls = 0;
  const store = new PluginStudioStore();
  const created = await store.writeDraft({ name, version: "1.0.0", description: "A team plugin",
    files: [{ path: "skills/review/SKILL.md", text: initialSkill }] });
  await store.reviewDraft(name, created.treeDigest);
  fault.calls = 0;
  return { store, digest: created.treeDigest };
}

afterEach(async () => {
  cleanup();
  fault.after = 0;
  fault.calls = 0;
  if (originalHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function expectNeedingReview(store: PluginStudioStore, view: StudioDraftView, position: number): Promise<void> {
  expect(view.draft.reviewed?.treeDigest, `write ${position}`).not.toBe(view.treeDigest);
  expect(view.reviewStatus, `write ${position}`).toBe("needs-review");
  await expect(store.reviewedFiles(name), `share after write ${position}`).rejects.toThrow(/review|incomplete/i);
  await expect(store.installableFiles(name), `install after write ${position}`).rejects.toThrow(/review|incomplete/i);
  const response = await createPluginStudioTools(store).find((tool) => tool.name === "plugin_studio_read")!
    .execute({ name }, {} as never);
  expect(response.isError).toBe(false);
  expect(JSON.parse(response.output).reviewStatus, `model read after write ${position}`).toBe("needs-review");

  const api = { listDrafts: vi.fn(async () => ({ ok: true, value: [view.draft] })),
    availableParts: vi.fn(async () => ({ ok: true, value: { skills: [], routines: [], connectors: [], prompts: [], agents: [] } })),
    readDraft: vi.fn(async () => ({ ok: true, value: view })),
    connectorCopyPreview: vi.fn(async () => ({ ok: false, code: "unavailable" })) } as unknown as PluginStudioApi;
  const page = render(createElement(PluginStudioView, { api, onInstalled: vi.fn() }));
  fireEvent.click(await screen.findByRole("button", { name }));
  expect(await screen.findByTestId("plugin-studio:review-status")).toHaveTextContent(t("pluginStudio.needsReview"));
  expect(screen.getByTestId("plugin-studio:install")).toBeDisabled();
  expect(screen.getByTestId("plugin-studio:share")).toBeDisabled();
  page.unmount();
}

describe("Studio interrupted draft update", () => {
  it("needs repair and review after a failure at every write position", async () => {
    const dryRun = await reviewedDraft();
    await dryRun.store.writeDraft(update);
    const positions = fault.calls;
    expect(positions).toBe(6);

    for (let position = 1; position <= positions; position += 1) {
      const { store, digest } = await reviewedDraft();
      fault.after = position;
      await expect(store.writeDraft(update)).rejects.toThrow(`Injected failure after Studio write ${position}`);
      fault.after = 0;
      const view = await store.readDraft(name);
      await expectNeedingReview(store, view, position);
      expect(view.treeDigest === digest && position > 1, `write ${position}`).toBe(false);
      if (position < positions) {
        expect(view.errors, `write ${position}`).toContain("Studio draft has an incomplete write; save it again before review");
        await expect(store.reviewDraft(name, view.treeDigest)).rejects.toThrow("incomplete write");
      }
      const repaired = await store.writeDraft(update);
      expect(repaired.errors, `repair after write ${position}`).toEqual([]);
      expect(repaired.reviewStatus).toBe("needs-review");
      const reviewed = await store.reviewDraft(name, repaired.treeDigest);
      expect(reviewed.reviewStatus).toBe("reviewed");
      await expect(store.installableFiles(name)).resolves.toEqual(expect.any(Array));
    }
  });

  it("keeps connector confirmation pending until every package write completes", async () => {
    async function reviewedConnectorDraft() {
      const root = await mkdtemp(join(tmpdir(), "ave-studio-connector-interruption-"));
      roots.push(root);
      process.env.AVE_HOME = join(root, "home");
      fault.after = 0;
      fault.calls = 0;
      let arg = "studio-sample==1.0.0";
      const manager = { getStudioConnectorSource: async () => ({ spec: { id: "sample", transport: "stdio" as const,
        command: "uvx" }, args: [arg], env: { SAMPLE: "visible-value" } }) };
      const preview = () => previewStudioConnector(manager as never, "sample");
      const store = new PluginStudioStore(async () => ({ digest: (await preview()).specDigest, argsCount: 1, envCount: 1 }));
      await store.writeDraft({ name, version: "1.0.0", description: "A team plugin",
        references: [{ kind: "connector", name: "sample" }] });
      const first = await preview();
      const confirmed = await store.confirmConnectorCopy(name, "sample", first, { specDigest: first.specDigest,
        args: first.args.map(({ index, digest }) => ({ index, digest })),
        env: first.env.map(({ name: envName, digest }) => ({ name: envName, digest })) });
      await store.reviewDraft(name, confirmed.treeDigest);
      arg = "studio-sample==1.0.1";
      fault.calls = 0;
      return { store, preview: await preview() };
    }
    const dryRun = await reviewedConnectorDraft();
    const fullConfirmation = (preview: Awaited<ReturnType<typeof previewStudioConnector>>) => ({ specDigest: preview.specDigest,
      args: preview.args.map(({ index, digest }) => ({ index, digest })),
      env: preview.env.map(({ name: envName, digest }) => ({ name: envName, digest })) });
    await dryRun.store.confirmConnectorCopy(name, "sample", dryRun.preview, fullConfirmation(dryRun.preview));
    const positions = fault.calls;
    expect(positions).toBe(5);

    for (let position = 1; position <= positions; position += 1) {
      const { store, preview } = await reviewedConnectorDraft();
      fault.after = position;
      await expect(store.confirmConnectorCopy(name, "sample", preview, fullConfirmation(preview)))
        .rejects.toThrow(`Injected failure after Studio write ${position}`);
      fault.after = 0;
      const view = await store.readDraft(name);
      await expectNeedingReview(store, view, position);
      if (position < positions) expect(view.errors).toContain("Studio draft has an incomplete write; save it again before review");
      const repaired = await store.confirmConnectorCopy(name, "sample", preview, fullConfirmation(preview));
      expect(repaired.errors).toEqual([]);
      expect((await store.reviewDraft(name, repaired.treeDigest)).reviewStatus).toBe("reviewed");
    }
  });
});
