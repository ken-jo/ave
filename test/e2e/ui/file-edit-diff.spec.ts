import { writePermissionSettingsFixture } from "../../../src/__tests__/support/permission-settings-fixture.js";
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildE2eBaseSettings, buildLlmSettings, builtMainExists, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";
import { startScriptedModel, type ScriptedStep } from "./scripted-model.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";

/**
 * Diff cards and keep/undo, driven by REAL tool calls: a scripted loopback model asks for write_file and
 * edit_file, the app runs them, and the cards are whatever the real tool results produce.
 */
/**
 * Let the turn run to its final answer. A change to a file the model has just read is asked once, whatever the mode, so
 * each card is answered as the person would, after checking that it shows the requested change. Returns the cards as
 * "tool file".
 */
async function allowUntil(page: Page, finalText: string): Promise<string[]> {
  const done = page.getByText(finalText);
  const dock = page.getByTestId(TEST_IDS.approvalDock).first();
  const allow = dock.getByTestId(TEST_IDS.approveButton);
  // "tool file" of the card on screen, or "" when there is none.
  const shown = (): Promise<string> => dock.evaluateAll((nodes) => {
    const card = nodes[0];
    if (!card) return "";
    const tool = card.querySelector("code")?.textContent ?? "";
    const target = card.querySelector('[data-testid="approval-action-primary"]')?.textContent ?? "";
    return `${tool.replace(/^builtin:/u, "")} ${target.split("/").pop() ?? ""}`;
  });
  const asked: string[] = [];
  for (;;) {
    await expect(done.or(allow).first()).toBeVisible({ timeout: 90_000 });
    if (await done.isVisible()) return asked;
    const card = await shown();
    // A card that asks for an edit shows the change itself before the answer.
    if (/^(?:edit_file|multi_edit) /u.test(card)) await expect(dock.getByTestId("approval-edit-diff")).toBeVisible();
    asked.push(card);
    await allow.click();
    await expect.poll(shown, { timeout: 30_000 }).not.toBe(card);
  }
}

const thirtyLines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join("");

async function runScriptedTurn(steps: (directory: string) => ScriptedStep[], prepare: (directory: string) => void,
  body: (page: Page, directory: string, toolResults: () => string[], app: ElectronApplication) => Promise<void>): Promise<void> {
  expect(builtMainExists()).toBe(true);
  // The model answers from this list; it is filled once the isolated profile's project folder exists.
  const script: ScriptedStep[] = [];
  const model = await startScriptedModel(script);
  const settings = buildLlmSettings("openai-compatible", model.model);
  settings.appearance = buildE2eBaseSettings(true, "en").appearance;
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl = model.baseUrl;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  try {
    ctx = await launchSeededElectron({ sessionTitle: "File diff cards", settings, historyRows: [] });
    writePermissionSettingsFixture(ctx.aveHome, JSON.stringify({ permissions: { reviewer: { interactive: { autoApprove: "off" } } } }));
    // Files of the default project, where a person's own files are.
    const project = join(ctx.aveHome, "workspace");
    mkdirSync(project, { recursive: true });
    const directory = join(realpathSync(project), "diff-e2e");
    mkdirSync(directory);
    prepare(directory);
    script.push(...steps(directory));
    await ctx.page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-file-diff");
      const mode = await window.ave.permission.setMode("allow");
      if (!mode.ok) throw new Error("Could not select the allow mode");
    });
    const composer = ctx.page.locator('[data-composer-surface="main"] [data-testid="composer-textarea"]');
    await composer.fill("Change the files.");
    await composer.press("Enter");
    await body(ctx.page, directory, model.toolResults, ctx.app);
  } finally {
    if (ctx) await teardownSeededElectron(ctx, { terminate: true });
    await model.close();
  }
}

test("write and edit cards render the real tool results as numbered line diffs", async () => {
  test.setTimeout(300_000);
  await runScriptedTurn(
    (directory) => [
      { tool: "write_file", args: { path: join(directory, "created.ts"), content: "export const ANSWER = 42;\nexport const NAME = \"ave\";\n" } },
      { tool: "read_file", args: { path: join(directory, "lines.txt") } },
      { tool: "edit_file", args: { path: join(directory, "lines.txt"), oldText: "line 20", newText: "line twenty" } },
      { tool: "read_file", args: { path: join(directory, "small.txt") } },
      { tool: "write_file", args: { path: join(directory, "small.txt"), content: "after content\n" } },
      { text: "All three files are changed." },
    ],
    (directory) => {
      writeFileSync(join(directory, "lines.txt"), thirtyLines);
      writeFileSync(join(directory, "small.txt"), "before content\n");
    },
    async (page, directory, toolResults, app) => {
      const asked = await allowUntil(page, "All three files are changed.");
      // Both changes to existing files were asked.
      expect(asked.filter((card) => !card.startsWith("read_file "))).toEqual(["edit_file lines.txt", "write_file small.txt"]);
      expect(readFileSync(join(directory, "lines.txt"), "utf8")).toContain("line twenty\n");

      // The model never receives file contents back from a write: the diff lives in the host's record.
      const writes = toolResults().filter((result) => result.includes("\"bytes\""));
      expect(writes).toHaveLength(2);
      for (const result of writes) expect(JSON.parse(result)).not.toHaveProperty("after");

      // A finished turn folds its work away; open it, and every tool group in it, as a reader would.
      const conversation = page.getByRole("log", { name: "Conversation" });
      await conversation.getByRole("button", { name: /^Work complete/u }).click();
      const foldedGroups = conversation.locator('button[aria-expanded="false"]').filter({ hasText: /^Tools/u });
      while (await foldedGroups.count() > 0) await foldedGroups.first().click();
      const cards = page.getByTestId("file-edit-diff");
      await expect(cards).toHaveCount(3);
      const created = cards.filter({ hasText: "created.ts" });
      await expect(created).toHaveAttribute("data-new-file", "true");
      await expect(created).toHaveAttribute("data-added", "2");
      await expect(created).toContainText("ANSWER = 42");

      // One changed token in thirty lines is one removed and one added line, numbered from the file.
      const edited = cards.filter({ hasText: "lines.txt" });
      await expect(edited).toHaveAttribute("data-numbered", "true");
      await expect(edited).toHaveAttribute("data-added", "1");
      await expect(edited).toHaveAttribute("data-removed", "1");
      await expect(edited.getByTestId("file-diff-hunk-header")).toHaveText("@@ -17,7 +17,7 @@");
      await expect(edited.locator('[data-diff-kind="removed"] [data-line-column="old"]')).toHaveText("20");
      await expect(edited.locator('[data-diff-kind="added"] [data-line-column="new"]')).toHaveText("20");
      await expect(edited.locator('[data-diff-kind="context"]')).toHaveCount(6);

      // Measure browser-composited colors; foreground-token assertions alone miss translucent-theme failures.
      for (const kind of ["removed", "added"] as const) {
        const colors = await edited.locator(`[data-diff-kind="${kind}"]`).first().evaluate((element: HTMLElement) => {
          const style = getComputedStyle(element);
          const card = element.closest('[data-testid="file-edit-diff"]');
          return {
            foreground: style.color,
            background: style.backgroundColor,
            backdrop: card ? getComputedStyle(card).backgroundColor : "rgb(255, 255, 255)",
          };
        });
        expect(wcagContrast(colors.foreground, composite(colors.background, colors.backdrop))).toBeGreaterThanOrEqual(4.5);
      }

      // A small overwrite has a diff too; before the fix only writes above 4 KB showed anything.
      const overwritten = cards.filter({ hasText: "small.txt" });
      await expect(overwritten).toHaveAttribute("data-tool", "write_file");
      await expect(overwritten).toHaveAttribute("data-numbered", "true");
      await expect(overwritten.locator('[data-diff-kind="removed"]')).toContainText("before content");
      await expect(overwritten.locator('[data-diff-kind="added"]')).toContainText("after content");

      // Real geometry: a diff card never widens the conversation.
      const overflows = await cards.evaluateAll((nodes) => nodes.map((node) => node.scrollWidth - node.clientWidth));
      expect(overflows.length).toBeGreaterThanOrEqual(3);
      for (const overflow of overflows) expect(overflow).toBeLessThanOrEqual(1);

      // At the narrowest window the header gives up the folders and keeps the whole file name inside the card.
      await setWindowSize(app, 420, 800, page);
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)).then(() => undefined));
      for (const [card, fileName] of [[created, "created.ts"], [edited, "lines.txt"]] as const) {
        const name = card.locator('[data-testid="path-label"] [data-path-part="name"]');
        await expect(name).toHaveText(fileName);
        const measured = await name.evaluate((node: HTMLElement) => {
          const own = node.getBoundingClientRect();
          const cardRect = (node.closest('[data-testid="file-edit-diff"]') as HTMLElement).getBoundingClientRect();
          return { clipped: node.scrollWidth - node.clientWidth, left: own.left, right: own.right, cardLeft: cardRect.left, cardRight: cardRect.right };
        });
        expect(measured.clipped, `${fileName} is not cut`).toBeLessThanOrEqual(1);
        expect(measured.left).toBeGreaterThanOrEqual(measured.cardLeft - 0.5);
        expect(measured.right).toBeLessThanOrEqual(measured.cardRight + 0.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // The button beside the fold control opens a folder view of the file's project with the file shown.
      await setWindowSize(app, 1280, 800, page);
      await edited.getByTestId("file-diff-show-in-folder-view").click();
      const viewer = page.getByTestId("folder-viewer");
      await expect(viewer).toHaveAttribute("data-path", /lines\.txt$/u);
      await expect(viewer).toContainText("line twenty");
      await expect(edited).toHaveAttribute("data-numbered", "true");
    },
  );
});

test("the latest turn's changes can be undone per file and for the whole turn, with no confirmation", async () => {
  test.setTimeout(300_000);
  await runScriptedTurn(
    (directory) => [
      { tool: "read_file", args: { path: join(directory, "lines.txt") } },
      { tool: "multi_edit", args: { path: join(directory, "lines.txt"), replacements: [
        { oldText: "line 2\n", newText: "line two\n" }, { oldText: "line 25\n", newText: "line twenty-five\n" }] } },
      { tool: "read_file", args: { path: join(directory, "small.txt") } },
      { tool: "write_file", args: { path: join(directory, "small.txt"), content: "after content\n" } },
      { text: "Both files are changed." },
    ],
    (directory) => {
      writeFileSync(join(directory, "lines.txt"), thirtyLines);
      writeFileSync(join(directory, "small.txt"), "before content\n");
    },
    async (page, directory) => {
      await allowUntil(page, "Both files are changed.");
      const summary = page.getByTestId("latest-turn-summary");
      await expect(summary.getByTestId("latest-turn-summary-file")).toHaveCount(2);

      // Undo one file from its row: the file is written back at once and leaves the list.
      await summary.getByRole("button", { name: /Undo changes to .*small\.txt/ }).click();
      await expect(summary.getByTestId("latest-turn-summary-file")).toHaveCount(1);
      expect(readFileSync(join(directory, "small.txt"), "utf8")).toBe("before content\n");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);

      // Keep marks the rest as reviewed and writes nothing.
      await summary.getByRole("button", { name: "Keep all of this turn's changes" }).click();
      await expect(summary.locator('[data-testid="turn-decision"][data-scope="turn"]')).toHaveAttribute("data-kept", "true");
      expect(readFileSync(join(directory, "lines.txt"), "utf8")).toContain("line two\n");

      // Undo the whole turn: every remaining change is written back and the summary goes away.
      await summary.getByRole("button", { name: "Undo all of this turn's changes" }).click();
      await expect(summary).toHaveCount(0);
      expect(readFileSync(join(directory, "lines.txt"), "utf8")).toBe(thirtyLines);
    },
  );
});

type Rgb = [number, number, number];

function wcagContrast(foreground: string, background: Rgb): number {
  const luminance = ([r, g, b]: Rgb): number => {
    const linear = (channel: number): number => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const [r, g, b] = parseRgba(foreground);
  const foregroundLuminance = luminance([r, g, b]);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

/** The color a translucent foreground wash shows over an opaque backdrop. */
function composite(foreground: string, background: string): Rgb {
  const [fr, fg, fb, alpha] = parseRgba(foreground);
  const [br, bg, bb] = parseRgba(background);
  return [fr * alpha + br * (1 - alpha), fg * alpha + bg * (1 - alpha), fb * alpha + bb * (1 - alpha)];
}

function parseRgba(color: string): [number, number, number, number] {
  const channels = color.match(/[\d.]+/g)?.map(Number) ?? [];
  const [r, g, b, alpha = 1] = channels;
  if ((channels.length !== 3 && channels.length !== 4) || r === undefined || g === undefined || b === undefined || channels.some(Number.isNaN)) {
    throw new Error(`unsupported computed color: ${color}`);
  }
  return [r, g, b, alpha];
}
