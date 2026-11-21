// Folder view against the real app: real files in the isolated profile's default project, real IPC, and the real window size.
import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { BrowserWindow } from "electron";
import { sendRendererStreamEvent, setWindowSize } from "./seeded-electron.js";
import { test, expect } from "./fixtures.js";

/** The isolated profile's default project root, which the folder view lists first. */
function projectRoot(aveHome: string): string {
  return path.join(aveHome, "workspace");
}

function writeProjectFile(aveHome: string, relativePath: string, content: string | Buffer): string {
  const target = path.join(projectRoot(aveHome), relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

async function openFolderView(page: Page): Promise<void> {
  await page.getByTestId("sidebar-folder").click();
  await expect(page.getByTestId("folder-view")).toBeVisible();
}

function row(page: Page, name: string): Locator {
  return page.locator(`[data-testid="folder-row"][data-path$="/${name}"]`);
}

/** Resolve once every running layout transition (the sidebar folding at a new window width, for example) has finished. */
async function layoutSettled(page: Page): Promise<void> {
  // A looping animation (a loader) never finishes, so only the finite ones are awaited.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map((animation) => animation.finished)).then(() => undefined));
}

/** A viewer action wherever the header currently keeps it: in its row, or (when the viewer is narrow) in the "more" menu,
 * which this opens. */
async function viewerAction(page: Page, id: string): Promise<Locator> {
  const header = page.getByTestId("folder-viewer-header");
  await expect(header).toBeVisible();
  await layoutSettled(page);
  if (await header.getAttribute("data-compact") === "true" && await page.getByTestId("folder-viewer-more-menu").count() === 0) {
    await page.getByTestId("folder-viewer-more").click();
  }
  return page.getByTestId(`folder-viewer-action-${id}`);
}

/** The path of the row that has keyboard focus, or null when focus is elsewhere. */
function focusedRowPath(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-path") ?? null);
}

/** A container's rectangle and its buttons' rectangles from one layout read, for geometry assertions. */
async function headerGeometry(container: Locator): Promise<{
  left: number; right: number; overflows: boolean; buttons: Array<{ label: string; left: number; right: number }>;
}> {
  return container.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      overflows: node.scrollWidth > node.clientWidth,
      buttons: [...node.querySelectorAll("button")].map((button) => {
        const box = button.getBoundingClientRect();
        return { label: button.getAttribute("aria-label") ?? button.textContent ?? "", left: box.left, right: box.right };
      }),
    };
  });
}

test.describe("folder view", () => {
  test("keeps every viewer action reachable at 420 wide, and in a row at 1280", async ({ app, mainWindow, aveHome, t }) => {
    writeProjectFile(aveHome, "README.md", "# Demo project\n\nSome **bold** text.\n");
    await setWindowSize(app, 1280, 800, mainWindow);
    await openFolderView(mainWindow);
    await row(mainWindow, "README.md").click();
    const header = mainWindow.getByTestId("folder-viewer-header");
    await expect(mainWindow.getByTestId("folder-markdown-rendered")).toBeVisible();

    // Wide: the actions sit in the header as a row, all inside it.
    await expect(mainWindow.getByTestId("folder-viewer-actions")).toBeVisible();
    await expect(mainWindow.getByTestId("folder-viewer-action-open-external")).toBeVisible();
    await layoutSettled(mainWindow);
    const wide = await headerGeometry(header);
    expect(wide.overflows).toBe(false);
    expect(wide.buttons.length).toBeGreaterThanOrEqual(5);
    for (const button of wide.buttons) {
      expect(button.right, `${button.label} ends inside the header`).toBeLessThanOrEqual(wide.right + 0.5);
    }

    // Narrow: the real window is 420 wide; nothing in the header may reach past the header or the window.
    await setWindowSize(app, 420, 800, mainWindow);
    await expect(header).toHaveAttribute("data-compact", "true");
    const more = mainWindow.getByTestId("folder-viewer-more");
    await expect(more).toBeVisible();
    await expect(mainWindow.getByTestId("folder-viewer-actions")).toHaveCount(0);
    await layoutSettled(mainWindow);
    // The window's content is exactly 420 wide. The app's view sits inside it, inset by the native resize edge, and the
    // page is exactly that view: it is the width the header has to fit.
    const native = await (await app.browserWindow(mainWindow)).evaluate((target: BrowserWindow) => {
      const view = target.contentView.children.find((child) => "webContents" in child && child.webContents === target.webContents);
      return { content: target.getContentSize()[0], view: view?.getBounds().width };
    });
    expect(native.content).toBe(420);
    // The view is a real, narrow one: inside the window, not empty.
    expect(native.view).toBeGreaterThan(0);
    expect(native.view).toBeLessThanOrEqual(420);
    const windowWidth = await mainWindow.evaluate(() => window.innerWidth);
    expect(windowWidth).toBe(native.view);
    const narrow = await headerGeometry(header);
    expect(narrow.overflows).toBe(false);
    expect(narrow.right).toBeLessThanOrEqual(windowWidth + 0.5);
    expect(narrow.buttons.map((button) => button.label)).toContain(t("folderView.moreActions"));
    for (const button of narrow.buttons) {
      expect(button.left, `${button.label} starts inside the header`).toBeGreaterThanOrEqual(narrow.left - 0.5);
      expect(button.right, `${button.label} ends inside the header`).toBeLessThanOrEqual(narrow.right + 0.5);
    }
    expect(await mainWindow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // The menu holds every action, each fully inside the window, and they work from there.
    await more.click();
    const menu = mainWindow.getByTestId("folder-viewer-more-menu");
    await expect(menu).toBeVisible();
    for (const id of ["markdown-mode", "copy-content", "reveal", "copy-path", "open-external"]) {
      const item = menu.getByTestId(`folder-viewer-action-${id}`);
      await expect(item).toBeVisible();
      const box = await item.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? -1, `${id} starts inside the window`).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0), `${id} ends inside the window`).toBeLessThanOrEqual(windowWidth + 0.5);
    }
    await expect(menu.getByTestId("folder-viewer-action-open-external")).toHaveText(t("folderView.openExternal"));
    await menu.getByTestId("folder-viewer-action-markdown-mode").click();
    await expect(mainWindow.getByTestId("folder-markdown-rendered")).toHaveCount(0);
    await expect(mainWindow.getByTestId("folder-viewer")).toContainText("# Demo project");
  });

  test("shows what is on disk now: refresh, a search of the open folder, and a count for what a large folder leaves out", async ({ app, mainWindow, aveHome, t }) => {
    for (let index = 0; index < 120; index++) writeProjectFile(aveHome, `src/mod-${String(index).padStart(3, "0")}.ts`, "export {};\n");
    writeProjectFile(aveHome, "src/needle-report.ts", "export const report = 1;\n");
    writeProjectFile(aveHome, "other/needle-elsewhere.ts", "export {};\n");
    for (let index = 0; index < 1100; index++) writeProjectFile(aveHome, `many/f${String(index).padStart(4, "0")}.txt`, "x");
    writeProjectFile(aveHome, "many/zz-last-folder/inside.txt", "x");
    await setWindowSize(app, 1280, 800, mainWindow);
    await openFolderView(mainWindow);

    // Search looks in the folder that is open, by file name, among more files than a column's first screen holds.
    await row(mainWindow, "src").click();
    await expect(row(mainWindow, "mod-000.ts")).toBeVisible();
    await mainWindow.getByTestId("folder-search").fill("needle");
    const results = mainWindow.getByTestId("folder-search-results").getByRole("option");
    await expect(results).toHaveCount(1);
    await expect(results.first()).toHaveText("needle-report.ts");
    await results.first().click();
    await expect(row(mainWindow, "needle-report.ts")).toHaveAttribute("aria-selected", "true");
    await expect(mainWindow.getByTestId("folder-viewer")).toContainText("export const report = 1;");

    // A file made outside the app shows after the refresh button; one removed outside disappears when the window is
    // focused again; one made by a tool shows when the tool finishes.
    const made = writeProjectFile(aveHome, "src/made-outside.ts", "export {};\n");
    await expect(row(mainWindow, "made-outside.ts")).toHaveCount(0);
    await mainWindow.getByTestId("folder-refresh").click();
    await expect(row(mainWindow, "made-outside.ts")).toBeVisible();
    fs.rmSync(made);
    await mainWindow.evaluate(() => { window.dispatchEvent(new Event("focus")); });
    await expect(row(mainWindow, "made-outside.ts")).toHaveCount(0);
    writeProjectFile(aveHome, "src/made-by-tool.ts", "export {};\n");
    await sendRendererStreamEvent(app, mainWindow, {
      type: "tool_end", name: "write_file", groupId: "folder-view-e2e", toolUseId: "folder-view-e2e-1", result: "ok", isError: false, durationMs: 5,
    });
    await expect(row(mainWindow, "made-by-tool.ts")).toBeVisible();
    // The open file is read again too.
    writeProjectFile(aveHome, "src/needle-report.ts", "export const report = 2;\n");
    await mainWindow.getByTestId("folder-refresh").click();
    await expect(mainWindow.getByTestId("folder-viewer")).toContainText("export const report = 2;");

    // 1,100 files and a folder: the folder is among the 1,000 shown, and the 101 left out are counted in two places.
    await row(mainWindow, "many").click();
    await expect(row(mainWindow, "zz-last-folder")).toBeVisible();
    await expect(mainWindow.getByTestId("folder-column-truncated")).toHaveText(t("folderView.truncated", { shown: "1,000", omitted: "101" }));
    await expect(mainWindow.getByTestId("folder-status")).toContainText(t("folderView.statusOmitted", { count: "101" }));
    await expect(mainWindow.locator('[data-testid="folder-row"][data-path*="/many/"]')).toHaveCount(1000);
  });

  test("moves through a list from the keyboard and offers each row's actions in a menu", async ({ app, mainWindow, aveHome, t }) => {
    for (const name of ["apple.txt", "banana.txt", "cherry.txt", "date.txt"]) writeProjectFile(aveHome, `keys/${name}`, `${name}\n`);
    writeProjectFile(aveHome, "keys/big.ts", `// big\n${"x".repeat(2_100_000)}`);
    await setWindowSize(app, 1280, 800, mainWindow);
    await openFolderView(mainWindow);
    await row(mainWindow, "keys").click();
    await row(mainWindow, "apple.txt").click();
    const inKeys = (name: string) => expect.poll(() => focusedRowPath(mainWindow)).toMatch(new RegExp(`/keys/${name.replace(".", "\\.")}$`, "u"));

    await mainWindow.keyboard.press("End");
    await inKeys("date.txt");
    await mainWindow.keyboard.press("Home");
    await inKeys("apple.txt");
    // Typing a name goes to the row that starts with it.
    await mainWindow.keyboard.type("ch");
    await inKeys("cherry.txt");

    // The row's menu opens from the keyboard and from the pointer, drawn inside the window, and Escape returns to the row.
    await mainWindow.keyboard.press("Shift+F10");
    const menu = mainWindow.getByTestId("file-row-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText([
      t("chatPreviewRail.ctxOpen"), t("folderView.openInEditor"), t(process.platform === "darwin" ? "folderView.revealFinder" : process.platform === "win32" ? "folderView.revealExplorer" : "folderView.revealFileManager"), t("folderView.copyPath"),
      t("folderView.copyRelativePath"), t("folderView.addToContext"), t("folderView.openTerminalHere"),
    ]);
    await mainWindow.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await inKeys("cherry.txt");
    await row(mainWindow, "banana.txt").click({ button: "right" });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    const viewport = await mainWindow.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(box).not.toBeNull();
    expect((box?.x ?? -1)).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
    // "Open" from the menu shows that row's file.
    await menu.getByTestId("file-row-action-open").click();
    await expect(menu).toHaveCount(0);
    await expect(mainWindow.getByTestId("folder-viewer")).toContainText("banana.txt");

    // Search results are reachable with the arrow keys, and Enter goes to the file.
    await mainWindow.getByTestId("folder-search").fill("date");
    const results = mainWindow.getByTestId("folder-search-results").getByRole("option");
    await expect(results).toHaveCount(1);
    await mainWindow.getByTestId("folder-search").press("ArrowDown");
    await expect(results.first()).toBeFocused();
    await mainWindow.keyboard.press("Enter");
    await expect(row(mainWindow, "date.txt")).toHaveAttribute("aria-selected", "true");

    // A code file's header has the file manager and the path; one too large to preview says what can be done with it,
    // without pointing at a default app that does not take the type.
    await row(mainWindow, "cherry.txt").click();
    for (const id of ["reveal", "copy-path", "open-in-editor"]) await expect(await viewerAction(mainWindow, id)).toBeVisible();
    await mainWindow.keyboard.press("Escape");
    await row(mainWindow, "big.ts").click();
    const [before, after] = t("folderView.reasonTooLargeNoDefaultApp", { size: "\u0000" }).split("\u0000");
    await expect(mainWindow.getByTestId("folder-viewer")).toContainText(before ?? "");
    await expect(mainWindow.getByTestId("folder-viewer")).toContainText(after ?? "");
    await expect(mainWindow.getByTestId("folder-open-external")).toHaveCount(0);
    await expect(mainWindow.getByTestId("folder-reveal")).toBeVisible();
    await expect(mainWindow.getByTestId("folder-copy-path")).toBeVisible();
  });

  test("opens a file in the editor command the user set, after sending them to the setting when there is none", async ({ app, mainWindow, aveHome, tempHome, t }) => {
    const file = writeProjectFile(aveHome, "src/it's a file.ts", "export const a = 1;\n");
    // A stand-in editor: the test runner's own runtime, running a script that records the arguments it was started with.
    const recorder = path.join(tempHome, "record-arguments.cjs");
    const recorded = path.join(tempHome, "editor-arguments.json");
    fs.writeFileSync(recorder, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n');
    const command = `"${process.execPath}" "${recorder}" "${recorded}" --goto {file}:{line}`;
    await setWindowSize(app, 1280, 800, mainWindow);
    await openFolderView(mainWindow);
    await row(mainWindow, "src").click();
    await row(mainWindow, "it's a file.ts").click();

    // No command yet: the viewer says so and offers the setting; nothing is started.
    await (await viewerAction(mainWindow, "open-in-editor")).click();
    const alert = mainWindow.getByTestId("folder-viewer-alert");
    await expect(alert).toContainText(t("folderView.editorNotConfigured"));
    await alert.getByTestId("file-action-open-settings").click();
    const field = mainWindow.getByTestId("document-editor-command");
    await expect(field).toBeVisible();
    await expect(field).toBeEnabled();
    await field.fill(command);
    await field.press("Enter");
    await expect.poll(() => mainWindow.evaluate(async () => {
      const api = (globalThis as unknown as { aveApi: { getSettings(): Promise<{ documents: { editorCommand: string } }> } }).aveApi;
      return (await api.getSettings()).documents.editorCommand;
    })).toBe(command);
    expect(fs.existsSync(recorded)).toBe(false);

    // With the command set, the header action starts it with the real path and line 1, as two whole arguments.
    await openFolderView(mainWindow);
    await row(mainWindow, "src").click();
    await row(mainWindow, "it's a file.ts").click();
    await (await viewerAction(mainWindow, "open-in-editor")).click();
    await expect.poll(() => (fs.existsSync(recorded) ? fs.readFileSync(recorded, "utf8") : "")).not.toBe("");
    expect(JSON.parse(fs.readFileSync(recorded, "utf8"))).toEqual(["--goto", `${fs.realpathSync(file)}:1`]);
    await expect(mainWindow.getByTestId("folder-viewer-alert")).toHaveCount(0);

    // The row menu's action does the same.
    fs.rmSync(recorded);
    await row(mainWindow, "it's a file.ts").click({ button: "right" });
    await mainWindow.getByTestId("file-row-action-open-in-editor").click();
    await expect.poll(() => (fs.existsSync(recorded) ? fs.readFileSync(recorded, "utf8") : "")).not.toBe("");
    expect(JSON.parse(fs.readFileSync(recorded, "utf8"))).toEqual(["--goto", `${fs.realpathSync(file)}:1`]);
  });

  test("edits a file in the viewer: saves in the file's own line endings and never over a file that changed meanwhile", async ({ app, mainWindow, aveHome, t }) => {
    const target = writeProjectFile(aveHome, "notes.txt", "first\r\nsecond\r\n");
    await setWindowSize(app, 1280, 800, mainWindow);
    await openFolderView(mainWindow);
    await row(mainWindow, "notes.txt").click();
    await expect(mainWindow.getByTestId("folder-viewer")).toContainText("second");

    // Edit and save with the pointer: the file on disk keeps its CRLF endings around the edit.
    await mainWindow.getByTestId("folder-viewer-action-edit").click();
    const editor = mainWindow.getByTestId("folder-text-editor");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("first\nsecond\n");
    const save = mainWindow.getByTestId("folder-viewer-action-edit-save");
    await expect(save).toBeDisabled();
    await editor.fill("first\nsecond\nthird by hand\n");
    await expect(mainWindow.getByTestId("folder-viewer-subtitle")).toContainText(t("folderView.editUnsaved"));
    await save.click();
    await expect(editor).toHaveCount(0);
    expect(fs.readFileSync(target, "utf8")).toBe("first\r\nsecond\r\nthird by hand\r\n");
    await expect(mainWindow.getByTestId("folder-viewer")).toContainText("third by hand");
    await expect(mainWindow.getByTestId("folder-viewer-alert")).toHaveCount(0);

    // Save from the keyboard while the text has focus.
    await mainWindow.getByTestId("folder-viewer-action-edit").click();
    await expect(editor).toBeFocused();
    await mainWindow.keyboard.press("ControlOrMeta+ArrowDown");
    await mainWindow.keyboard.type("typed");
    await mainWindow.keyboard.press("ControlOrMeta+s");
    await expect(editor).toHaveCount(0);
    expect(fs.readFileSync(target, "utf8")).toBe("first\r\nsecond\r\nthird by hand\r\ntyped");

    // The file changes in another program while a draft is open: the save writes nothing and the draft stays.
    await mainWindow.getByTestId("folder-viewer-action-edit").click();
    await editor.fill("my draft\n");
    fs.writeFileSync(target, "changed elsewhere\n");
    await save.click();
    await expect(mainWindow.getByTestId("folder-viewer-alert")).toHaveText(t("folderView.editChanged"));
    await expect(editor).toHaveValue("my draft\n");
    expect(fs.readFileSync(target, "utf8")).toBe("changed elsewhere\n");

    // Discarding is immediate, and the viewer shows what is on disk.
    await mainWindow.getByTestId("folder-viewer-action-edit-discard").click();
    await expect(editor).toHaveCount(0);
    await expect(mainWindow.getByTestId("folder-viewer")).toContainText("changed elsewhere");
  });
});
