import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { inspectBrowserTarget } from "./browser-native-target.js";
import { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { REPO_ROOT } from "./seeded-electron.js";

const run = promisify(execFile);

if (process.platform === "linux") {
  for (const width of [1360, 900]) {
    test(`@os-focus native page keyboard takeover routes system keys at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      assert.equal(process.env.AVE_E2E_OS_FOCUS, "1", "Native OS focus requires explicit opt-in");
      const fixture = await launchUiLayerFixture(width, { foreground: true });
      const { app, page, composer, host, targetId } = fixture;
      const samples: unknown[] = [];
      const commands: string[][] = [];
      const osInput = async (...args: string[]) => {
        commands.push(args);
        return (await run("xdotool", args)).stdout.trim();
      };
      const native = () => inspectBrowserTarget(app, host.windowId, fixture.url);
      const sample = async (phase: string) => {
        const state = {
          phase,
          osWindow: await osInput("getwindowfocus"),
          native: await native(),
          page: await fixture.readPage(),
          composer: await composer.evaluate(editor => {
            if (!(editor instanceof HTMLTextAreaElement)) throw new Error("Native keyboard composer unavailable");
            const probe = Reflect.get(window, "keyboardFocusProbe") as { editor: Element; blurs: number };
            return { value: editor.value, active: document.activeElement === probe.editor,
              documentFocused: document.hasFocus(), blurs: probe.blurs };
          }),
        };
        samples.push(state);
        return state;
      };
      const clickUiPoint = async (point: { x: number; y: number }) => {
        const screen = await app.evaluate(({ BaseWindow, webContents }, input) => {
          const owner = BaseWindow.fromId(input.windowId);
          const chrome = webContents.fromId(input.chromeId);
          if (!owner || !chrome) throw new Error("Native keyboard owner unavailable");
          const content = owner.getContentBounds();
          return { x: content.x + input.point.x * chrome.getZoomFactor(), y: content.y + input.point.y * chrome.getZoomFactor() };
        }, { ...host, point });
        await osInput("mousemove", "--sync", String(Math.round(screen.x)), String(Math.round(screen.y)));
        await osInput("click", "1");
      };
      const clickComposer = async () => {
        const box = await composer.boundingBox();
        assert(box, "Composer must be visible for an OS pointer click");
        await clickUiPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        await expect.poll(async () => (await native()).focusedContentsId).toBe(host.chromeId);
      };
      const typeSystem = (text: string) => osInput("type", "--clearmodifiers", "--delay", "4", "--", text);
      try {
        const owner = await app.evaluate(({ BaseWindow }, windowId) => {
          const window = BaseWindow.fromId(windowId);
          if (!window) throw new Error("Native keyboard window unavailable");
          const contents = window.getContentBounds();
          return { xid: String(window.getNativeWindowHandle().readUInt32LE(0)), contents };
        }, host.windowId);
        expect(owner.contents).toMatchObject({ width, height: 800 });
        await osInput("windowraise", owner.xid);
        await osInput("windowfocus", "--sync", owner.xid);
        await expect.poll(async () => (await native()).ownerFocused).toBe(true);
        await composer.evaluate(editor => {
          const probe = { editor, blurs: 0 };
          Reflect.set(window, "keyboardFocusProbe", probe);
          editor.addEventListener("blur", () => { probe.blurs++; });
        });
        await clickComposer();
        await typeSystem("HOSTDRAFT");
        await expect(composer).toHaveValue("HOSTDRAFT");
        const beforeAgent = await sample("before-presented-agent-click");
        await fixture.clickFromAgent();
        await expect.poll(async () => (await fixture.readPage()).clicks).toBe(1);
        const afterAgent = await sample("after-presented-agent-click");
        expect(afterAgent.native).toMatchObject({ focusedContentsId: host.chromeId, ownerFocused: true });
        expect(afterAgent.osWindow).toBe(beforeAgent.osWindow);
        expect(afterAgent.composer).toEqual(beforeAgent.composer);
        expect(afterAgent.composer).toMatchObject({ active: true, blurs: 0 });
        expect(afterAgent.page).toMatchObject({ clicks: 1, trusted: true, activation: true, value: "" });
        await typeSystem("AFTERAGENT");
        await expect(composer).toHaveValue("HOSTDRAFTAFTERAGENT");
        expect(await fixture.readPage()).toMatchObject({ value: "" });

        const hole = page.locator(`[data-ave-native-page][data-tab-id="${fixture.rendererTabId}"]`);
        const holeBox = await hole.boundingBox();
        assert(holeBox, "Native page must be presented for OS takeover");
        const local = await app.evaluate(async ({ webContents }, id) => {
          const target = webContents.fromId(id);
          if (!target) throw new Error("Native page editor unavailable");
          return target.executeJavaScript("(() => { const r=document.getElementById('editor').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
        }, targetId);
        const editorPoint = { x: holeBox.x + local.x, y: holeBox.y + local.y };
        expect(await page.evaluate(point => Boolean(document.elementFromPoint(point.x, point.y)?.closest("[data-ave-native-page]")), editorPoint)).toBe(true);
        await clickUiPoint(editorPoint);
        await expect.poll(async () => (await fixture.control()).mode).toBe("human-paused");
        await typeSystem("PAGEKEYS");
        await sample("after-os-page-key-request");
        await expect.poll(async () => (await fixture.readPage()).value, {
          message: "OS keyboard takeover typing must reach the native page",
        }).toBe("PAGEKEYS");
        await expect.poll(async () => (await native()).focusedContentsId, {
          message: "OS keyboard takeover focus must select the native page",
        }).toBe(targetId);
        expect(await fixture.readPage()).toMatchObject({ inputTrusted: true });
        await expect(composer).toHaveValue("HOSTDRAFTAFTERAGENT");
        const userTakeover = await sample("after-user-os-typing");
        expect(userTakeover.native).toMatchObject({ focusedContentsId: targetId, ownerFocused: true });
        expect(userTakeover.composer.documentFocused).toBe(false);

        await clickComposer();
        await composer.evaluate(() => {
          (Reflect.get(window, "keyboardFocusProbe") as { blurs: number }).blurs = 0;
        });
        const resumed = await page.evaluate(async tabId => {
          const tabs = window.aveApi.browserTabs;
          if (!tabs) throw new Error("Native browser resume unavailable");
          return tabs.resume(tabId);
        }, fixture.rendererTabId);
        expect(resumed.ok).toBe(true);
        await expect.poll(async () => (await fixture.control()).mode).toBe("agent-active");
        const beforeResumeClick = await sample("before-resumed-agent-click");
        fixture.requestPageClick();
        await expect.poll(async () => (await fixture.readPage()).clicks).toBe(2);
        const afterResumeClick = await sample("after-resumed-agent-click");
        expect(afterResumeClick.native).toMatchObject({ focusedContentsId: host.chromeId, ownerFocused: true });
        expect(afterResumeClick.osWindow).toBe(beforeResumeClick.osWindow);
        expect(afterResumeClick.composer).toEqual(beforeResumeClick.composer);
        expect(afterResumeClick.composer).toMatchObject({ active: true, blurs: 0 });
        expect(afterResumeClick.page).toMatchObject({ clicks: 2, trusted: true, activation: true, value: "PAGEKEYS" });
        await typeSystem("HOSTAGAIN");
        await expect(composer).toHaveValue("HOSTDRAFTAFTERAGENTHOSTAGAIN");
        expect(await fixture.readPage()).toMatchObject({ value: "PAGEKEYS", inputTrusted: true });
        await sample("after-resumed-os-typing");
      } finally {
        const sourceRevision = (await run("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"])).stdout.trim();
        const sourceDiff = (await run("git", ["-C", REPO_ROOT, "diff", "--", "src/main/browser/browser-native-surfaces.ts"])).stdout;
        const path = testInfo.outputPath(`native-keyboard-routing-${width}.json`);
        await writeFile(path, `${JSON.stringify({ sourceRevision, sourceClean: sourceDiff.length === 0,
          sourceDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
          width, height: 800, keyboardSource: "global-x11-key-events", commands, samples }, null, 2)}\n`);
        await testInfo.attach("native-keyboard-routing", { path, contentType: "application/json" });
        await fixture.close();
      }
    });
  }
}
