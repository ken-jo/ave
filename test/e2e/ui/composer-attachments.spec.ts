import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

// What these cases drive for real: main's picker handler behind a stubbed native dialog, a native file drag dispatched by the
// browser's own input pipeline (the renderer receives OS-backed File objects and the drop-token path runs end to end:
// preload path resolution, main's registration and redemption), and paste events carrying either image bytes or OS-backed
// files. What they cannot drive: a drag that starts in the operating system's file manager, and the system clipboard,
// which belongs to the person at the machine and is never written here.

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const textarea = (page: Page) => page.locator(testIdSelector(TEST_IDS.composerTextarea));
const chips = (page: Page) => page.locator('[data-testid="attachment-chip"]');
const attachButton = (page: Page) => page.locator('[data-testid="iab-attach-button"]');
const notice = (page: Page) => page.locator('[data-testid="status-toast"]');

function writeFiles(directory: string, names: readonly string[]): string[] {
  return names.map((name) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, `content of ${name}\n`);
    return file;
  });
}

/** Make main's native open dialog answer with `filePaths`. Everything after the dialog is the app's own code. */
async function stubOpenDialog(app: ElectronApplication, filePaths: readonly string[]): Promise<void> {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: selected })) as typeof dialog.showOpenDialog;
  }, [...filePaths]);
}

/** Drag `files` from outside the page and let go at the middle of `target`: a native file drag, as the renderer sees one. */
async function dropFiles(page: Page, target: string, files: readonly string[]): Promise<void> {
  const box = await page.locator(target).boundingBox();
  if (!box) throw new Error(`drop target ${target} has no box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [...files], dragOperationsMask: 1 };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x, y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x, y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
  await cdp.detach();
}

/** Clipboard image directories of any profile in the temp directory, by name. */
function clipboardImageRoots(): Set<string> {
  return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("ave-clipboard-")));
}

test.beforeEach(async ({ mainWindow }) => {
  await expect(textarea(mainWindow)).toBeVisible();
  await expect(attachButton(mainWindow)).toBeVisible();
});

test("the composer starts with no attachment strip, and a typed marker makes no chip", async ({ mainWindow }) => {
  await expect(mainWindow.locator('[data-testid="composer-strip"]')).toHaveCount(0);
  await textarea(mainWindow).fill("hello [Image #1] world");
  await expect(chips(mainWindow)).toHaveCount(0);
  await expect(mainWindow.locator('[data-testid="attachment-chip-collapsed"]')).toHaveCount(0);
  await expect(mainWindow.locator('[data-testid="composer-strip"]')).toHaveCount(0);
});

test("the attach button attaches a picked file and removes it again from its chip", async ({ app, mainWindow, tempHome, t }) => {
  const [notes] = writeFiles(tempHome, ["notes.md"]);
  await stubOpenDialog(app, [notes]);

  await attachButton(mainWindow).click();

  await expect(chips(mainWindow)).toHaveCount(1);
  await expect(textarea(mainWindow)).toHaveValue("[File #1] ");
  await expect(mainWindow.locator('[data-testid="chip-count-badge"]')).toContainText("1/5");

  await mainWindow.getByRole("button", { name: t("attachmentChip.removeAttachment", { label: "notes.md" }) }).click();
  await expect(chips(mainWindow)).toHaveCount(0);
  await expect(textarea(mainWindow)).toHaveValue("");
});

test("a refused pick tells the person which file and why", async ({ app, mainWindow, tempHome, t }) => {
  const [installer, notes] = writeFiles(tempHome, ["setup.exe", "notes.md"]);
  await stubOpenDialog(app, [installer, notes]);

  await attachButton(mainWindow).click();

  // The allowed file is attached; the blocked one is named with main's reason.
  await expect(chips(mainWindow)).toHaveCount(1);
  await expect(notice(mainWindow)).toContainText(
    t("attachmentRejected.one", { name: "setup.exe", reason: t("attachmentRejected.reason.deniedExtension") }),
  );
});

test("a file dropped on the conversation area is attached, once", async ({ mainWindow, tempHome }) => {
  const [report] = writeFiles(tempHome, ["report.pdf"]);

  await dropFiles(mainWindow, '[data-testid="chat-transcript-stage"]', [report]);

  await expect(chips(mainWindow)).toHaveCount(1);
  await expect(textarea(mainWindow)).toHaveValue("[File #1] ");
  // The drop affordance is gone and the page did not navigate to the file.
  await expect(mainWindow.locator('[data-testid="composer-drop-overlay"]')).toHaveCount(0);
  await expect(mainWindow.locator('[data-testid="main-toolbar"]').first()).toBeVisible();
});

test("several files dropped on the input are attached together", async ({ mainWindow, tempHome }) => {
  const files = writeFiles(tempHome, ["a.txt", "b.txt"]);

  await dropFiles(mainWindow, testIdSelector(TEST_IDS.composerTextarea), files);

  await expect(mainWindow.locator('[data-testid="attachment-chip-collapsed"]')).toBeVisible();
  await expect(mainWindow.locator('[data-testid="chip-count-badge"]')).toHaveText("2/5");
  await expect(textarea(mainWindow)).toHaveValue("[File #1] [File #2] ");
});

test("a dropped folder is refused with the reason", async ({ mainWindow, tempHome, t }) => {
  const folder = path.join(tempHome, "some-folder");
  fs.mkdirSync(folder);

  await dropFiles(mainWindow, '[data-testid="chat-transcript-stage"]', [folder]);

  await expect(notice(mainWindow)).toContainText(
    t("attachmentRejected.one", { name: "some-folder", reason: t("attachmentRejected.reason.notAFile") }),
  );
  await expect(chips(mainWindow)).toHaveCount(0);
  await expect(textarea(mainWindow)).toHaveValue("");
});

test("a pasted image becomes a chip, and removing it deletes the temp image this app wrote", async ({ mainWindow, t }) => {
  const before = clipboardImageRoots();
  await textarea(mainWindow).focus();

  await mainWindow.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    const field = document.activeElement;
    if (!field) throw new Error("the composer is not focused");
    field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, PNG_1X1);

  await expect(chips(mainWindow)).toHaveCount(1);
  await expect(textarea(mainWindow)).toHaveValue("[Image #1] ");
  const created = [...clipboardImageRoots()].filter((name) => !before.has(name));
  expect(created).toHaveLength(1);
  const root = path.join(os.tmpdir(), created[0]);
  const [imageDirectory] = fs.readdirSync(root);
  expect(fs.readdirSync(path.join(root, imageDirectory))).toEqual(["image.png"]);

  await mainWindow.getByRole("button", {
    name: t("attachmentChip.removeAttachment", { label: t("attachmentChip.imageLabel", { n: 1 }) }),
  }).click();

  await expect(chips(mainWindow)).toHaveCount(0);
  await expect(textarea(mainWindow)).toHaveValue("");
  await expect.poll(() => fs.existsSync(root)).toBe(false);
});

test("a pasted file that is not an image is attached like a dropped one", async ({ mainWindow, tempHome }) => {
  const [report] = writeFiles(tempHome, ["report.pdf"]);
  // A file input is how a page gets an OS-backed File without the system clipboard; the paste event then carries it the
  // way a paste of a file copied in the file manager does.
  await mainWindow.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "e2e-file-source";
    input.style.display = "none";
    document.body.appendChild(input);
  });
  await mainWindow.locator("#e2e-file-source").setInputFiles([report]);
  await textarea(mainWindow).focus();

  const claimed = await mainWindow.evaluate(() => {
    const source = document.getElementById("e2e-file-source") as HTMLInputElement;
    const file = source.files?.[0];
    const field = document.activeElement;
    if (!file || !field) throw new Error("the file source or the composer focus is missing");
    const transfer = new DataTransfer();
    transfer.items.add(file);
    transfer.setData("text/plain", "report.pdf");
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    return event.defaultPrevented;
  });

  expect(claimed).toBe(true);
  await expect(chips(mainWindow)).toHaveCount(1);
  // The marker, and not the file name the clipboard also carried as text.
  await expect(textarea(mainWindow)).toHaveValue("[File #1] ");
});

test("a pasted file with no file on disk is refused with the reason", async ({ mainWindow, t }) => {
  await textarea(mainWindow).focus();

  await mainWindow.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["%PDF-1.4"], "in-memory.pdf", { type: "application/pdf" }));
    const field = document.activeElement;
    if (!field) throw new Error("the composer is not focused");
    field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });

  await expect(notice(mainWindow)).toContainText(
    t("attachmentRejected.one", { name: "in-memory.pdf", reason: t("attachmentRejected.reason.noFilePath") }),
  );
  await expect(chips(mainWindow)).toHaveCount(0);
});

test("at five attachments the attach button is disabled and the composer says why", async ({ app, mainWindow, tempHome, t }) => {
  const files = writeFiles(tempHome, ["1.txt", "2.txt", "3.txt", "4.txt", "5.txt", "6.txt"]);
  await stubOpenDialog(app, files.slice(0, 4));
  await attachButton(mainWindow).click();
  await expect(mainWindow.locator('[data-testid="chip-count-badge"]')).toHaveText("4/5");
  await expect(attachButton(mainWindow)).toBeEnabled();
  await expect(mainWindow.locator('[data-testid="composer-limit-warning"]')).toHaveCount(0);

  // Two more for the one slot left: one is attached, the other is named with the limit as its reason.
  await stubOpenDialog(app, files.slice(4));
  await attachButton(mainWindow).click();

  await expect(attachButton(mainWindow)).toBeDisabled();
  await expect(mainWindow.locator('[data-testid="composer-limit-warning"]')).toHaveText(t("composer.attachLimitWarning", { max: 5 }));
  await expect(notice(mainWindow)).toContainText(
    t("attachmentRejected.one", { name: "6.txt", reason: t("attachmentRejected.reason.tooMany", { max: 5 }) }),
  );
});
