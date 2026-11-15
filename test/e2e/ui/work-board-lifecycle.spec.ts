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
    await plannedCard.getByTestId("work-board-move").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("combobox").getByRole("option", { name: "Review", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("work-board-unavailable-lanes")).toContainText("cannot be assigned manually");
    await expect(page.getByTestId("work-board-move-confirm")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const handle = plannedCard.getByTestId("work-board-drag-handle");
    const target = narrow ? page.getByTestId("work-board-tab-in-progress") : page.getByTestId("work-board-column-in-progress");
    const sourceBox = await handle.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Board drag geometry is unavailable");
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 10, sourceBox.y + sourceBox.height / 2, { steps: 3 });
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 12 });
    await expect(target).toHaveAttribute("data-drop-enabled", "true");
    await page.mouse.up();
    await expect(page.getByTestId("work-board-move-dialog")).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveValue("in_progress");
    await page.getByTestId("work-board-move-confirm").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if (narrow) await page.getByTestId("work-board-tab-in-progress").click();
    await expect(page.getByTestId("work-board-column-in-progress")).toContainText("Outline export checklist");
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
    if (narrow) await page.getByTestId("work-board-tab-in-progress").click();
    const forbidden = narrow ? page.getByTestId("work-board-tab-review") : page.getByTestId("work-board-column-review");
    const retrySource = await handle.boundingBox();
    const forbiddenBox = await forbidden.boundingBox();
    if (!retrySource || !forbiddenBox) throw new Error("Forbidden target geometry is unavailable");
    await page.mouse.move(retrySource.x + retrySource.width / 2, retrySource.y + retrySource.height / 2);
    await page.mouse.down();
    await page.mouse.move(retrySource.x + retrySource.width / 2 + 10, retrySource.y + retrySource.height / 2, { steps: 3 });
    await page.mouse.move(forbiddenBox.x + forbiddenBox.width / 2, forbiddenBox.y + forbiddenBox.height / 2, { steps: 12 });
    await expect(forbidden).toHaveAttribute("data-drop-enabled", "false");
    await expect(forbidden).not.toHaveAttribute("data-drop-target", "true");
    await expect(forbidden).not.toHaveClass(/ring-2/);
    await expect(page.getByTestId("work-board-drop-feedback")).toContainText("cannot be assigned manually");
    await page.screenshot({ path: testInfo.outputPath(`forbidden-drop-${width}.png`) });
    await page.mouse.up();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("work-board-column-in-progress")).toContainText("Outline export checklist");
    expect(JSON.parse(readFileSync(join(context.aveHome, "work-board", "board.json"), "utf8"))).toEqual(saved);
    await app.context().tracing.stop({ path: testInfo.outputPath(`lifecycle-${width}.zip`) });
  });
}

for (const locale of ["en", "ko"] as const) {
  test(`reloads a stale detail snapshot before completing in ${locale}`, async ({ browserName }, testInfo) => {
    expect(browserName).toBe("chromium");
    context = await launchSeededElectron({
      settings: buildE2eBaseSettings(true, locale),
      historyRows: [{ role: "user", content: "Review project work" }, { role: "assistant", content: "Ready." }],
      prepareHome: (home) => {
        mkdirSync(join(home, "work-board"), { recursive: true });
        const now = new Date().toISOString();
        writeFileSync(join(home, "work-board", "board.json"), JSON.stringify({ version: 1, nextId: 2, items: [
          { id: 1, title: "Export notes", status: "planned", priority: "medium", created_at: now, updated_at: now },
        ] }));
      },
    });
    const { page, app } = context;
    await setWindowSize(app, 1243, 900);
    await page.getByTestId("main-toolbar").first().waitFor({ timeout: 60_000 });
    await page.getByTestId("toolbar-work-board").click();
    const panel = page.getByTestId("work-board-panel");
    await expect(panel).toBeVisible();
    if (await panel.getAttribute("data-layout") === "narrow") await page.getByTestId("work-board-tab-planned").click();
    await page.getByTestId("work-board-card").getByRole("button", { name: "Export notes", exact: true }).click();
    const title = page.getByTestId("work-board-detail-title");
    await expect(title).toHaveValue("Export notes");
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    await title.fill("Unsaved title");
    const changed = await page.evaluate(() => window.aveApi.updateWorkBoardItem(1, { title: "Edited elsewhere" }));
    expect("status" in changed && changed.status).toBe("updated");
    await page.getByTestId("work-board-detail-toggle").click();
    const alert = page.getByTestId("work-board-detail-error");
    await expect(alert).toHaveText(locale === "en"
      ? "This item changed. Reload it to see the latest details before trying again. Reloading discards unsaved edits."
      : "작업이 변경되었습니다. 항목을 다시 불러와 최신 내용을 확인한 뒤 다시 시도하세요. 저장하지 않은 편집 내용은 사라집니다.");
    await expect(title).toHaveValue("Unsaved title");
    expect(JSON.parse(readFileSync(join(context.aveHome, "work-board", "board.json"), "utf8")).items[0].status).toBe("planned");
    await page.screenshot({ path: testInfo.outputPath(`stale-detail-${locale}.png`) });
    await page.getByRole("button", { name: locale === "en" ? "Reload item" : "항목 다시 불러오기", exact: true }).click();
    await expect(title).toHaveValue("Edited elsewhere");
    await expect(alert).toHaveCount(0);
    await page.getByTestId("work-board-detail-toggle").click();
    await expect(page.getByTestId("work-board-detail-dialog")).toHaveCount(0);
    expect(JSON.parse(readFileSync(join(context.aveHome, "work-board", "board.json"), "utf8")).items[0]).toMatchObject({ title: "Edited elsewhere", status: "completed" });
    await app.context().tracing.stop({ path: testInfo.outputPath(`stale-detail-${locale}.zip`) });
  });
}
