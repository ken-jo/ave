// Folder view against the real app: real files in the isolated profile's default project, real IPC, and the real window size.
import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { BrowserWindow } from "electron";
import { setWindowSize } from "./seeded-electron.js";
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
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)).then(() => undefined));
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
});
