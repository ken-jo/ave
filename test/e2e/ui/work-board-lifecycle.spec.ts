import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildE2eBaseSettings, launchSeededElectron, teardownSeededElectron, setWindowSize, type SeededElectronContext } from "./seeded-electron.js";

let context: SeededElectronContext | undefined;
test.afterEach(async () => {
  if (context) await teardownSeededElectron(context, { terminate: true });
  context = undefined;
});

for (const width of [1243, 900]) {
  test(`review inspector and confirmed lane moves at ${width}px`, async ({ browserName }, testInfo) => {
    expect(browserName).toBe("chromium");
    context = await launchSeededElectron({
      settings: { ...buildE2eBaseSettings(true, "en"), system: { sidebarState: "rail" } },
      historyRows: [{ role: "user", content: "Review project work" }, { role: "assistant", content: "Ready." }],
      prepareHome: (home) => {
        mkdirSync(join(home, "work-board"), { recursive: true });
        const now = new Date().toISOString();
        writeFileSync(join(home, "work-board", "board.json"), JSON.stringify({ version: 1, nextId: 3, items: [
          { id: 1, title: "Outline export checklist", detail: "Cover empty entries and images.", status: "planned", priority: "medium", created_at: now, updated_at: now },
          { id: 2, title: "Export journal", status: "in_progress", priority: "high", runStatus: "completed", runId: "result-run", output: "Exported three markdown files. Empty entries were checked.", created_at: now, updated_at: now },
        ] }));
      },
    });
    const { page, app } = context;
    await setWindowSize(app, width, 768);
    await page.getByTestId("main-toolbar").first().waitFor({ timeout: 60_000 });
    await page.getByTestId("toolbar-work-board").click();
    const panel = page.getByTestId("work-board-panel");
    await expect(panel).toBeVisible();
    const narrow = await panel.getAttribute("data-layout") === "narrow";
    if (narrow) await page.getByTestId("work-board-tab-planned").click();
    const plannedCard = page.getByTestId("work-board-card").filter({ hasText: "Outline export checklist" });
    await expect(plannedCard).toBeVisible();
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    const handle = plannedCard.getByTestId("work-board-drag-handle");
    const target = narrow ? page.getByTestId("work-board-tab-in-progress") : page.getByTestId("work-board-column-in-progress");
    const sourceBox = await handle.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Board drag geometry is unavailable");
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 10, sourceBox.y + sourceBox.height / 2, { steps: 3 });
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByTestId("work-board-move-dialog")).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveValue("in_progress");
    await page.getByTestId("work-board-move-confirm").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if (narrow) await page.getByTestId("work-board-tab-in-progress").click();
    await expect(page.getByTestId("work-board-column-in-progress")).toContainText("Outline export checklist");
    await plannedCard.getByTestId("work-board-move").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("combobox").selectOption("review");
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("cannot be assigned manually");
    await expect(page.getByTestId("work-board-move-confirm")).toBeDisabled();
    await page.keyboard.press("Escape");
    if (narrow) await page.getByTestId("work-board-tab-review").click();
    await page.getByTestId("work-board-card").filter({ hasText: "Export journal" }).getByRole("button", { name: "Export journal", exact: true }).click();
    await expect(page.getByTestId("work-board-review-summary")).toContainText("Exported three markdown files");
    await page.screenshot({ path: testInfo.outputPath(`review-${width}.png`) });
    await page.getByTestId("work-board-review-complete").click();
    if (narrow) await page.getByTestId("work-board-tab-completed").click();
    await expect(page.getByTestId("work-board-column-completed")).toContainText("Export journal");
    const saved = JSON.parse(readFileSync(join(context.aveHome, "work-board", "board.json"), "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.items.map((item: { status: string }) => item.status)).toEqual(["in_progress", "completed"]);
    await page.screenshot({ path: testInfo.outputPath(`completed-${width}.png`) });
    await app.context().tracing.stop({ path: testInfo.outputPath(`lifecycle-${width}.zip`) });
  });
}
