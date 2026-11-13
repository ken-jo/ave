import { build } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "./fixtures.js";
import { setWindowSize } from "./seeded-electron.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { MAIN_BUNDLE_EXTERNALS } from "../../../scripts/lib/main-bundle-externals.mjs";

test.use({ seedViewFixturePlugin: false, seedLocale: "en" });

test.afterEach(async ({ app }) => {
  await app.evaluate(async () => {
    const driver = (globalThis as unknown as { __skillConsentDriver?: { stop(): Promise<void> } }).__skillConsentDriver;
    await driver?.stop();
  });
  // Close through the driver while the inspector still accepts requests; a second
  // app.quit after will-quit can wait on the debugger it is trying to close.
  await app.close();
});

test("remote skill activation requires the explicit per-skill code-execution consent card", async ({ app, mainWindow }, testInfo) => {
  const driverPath = resolve("test-results/mcp-skill-driver.mjs");
  await build({ entryPoints: [resolve("test/e2e/ui/mcp-skill-driver.ts")], outfile: driverPath,
    bundle: true, format: "esm", platform: "node", target: "node22", external: [...MAIN_BUNDLE_EXTERNALS],
    banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, logLevel: "silent" });
  const chunks = resolve("dist/src/main/chunks");
  const servicesChunks = readdirSync(chunks).filter((name) => name.endsWith(".js") && readFileSync(resolve(chunks, name), "utf8").includes('"getServices"'));
  expect(servicesChunks).toHaveLength(1);
  const [servicesChunk] = servicesChunks;
  if (!servicesChunk) throw new Error("Services module is unavailable");
  const servicesUrl = pathToFileURL(resolve(chunks, servicesChunk)).href;
  await setWindowSize(app, 1000, 800);
  const sessionId = await mainWindow.evaluate(async () => (await window.aveApi.chatSessions({ kind: "main" })).current);
  expect(sessionId).toBeTruthy();
  await app.evaluate(async (_, params) => {
    const vm = process.getBuiltinModule("node:vm");
    const load = vm.compileFunction("return import(url)", ["url"], { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    const module = await load(params.servicesUrl);
    const getServices = Object.values(module).find((value) => typeof value === "function" && value.name === "getServices") as () => unknown;
    const driver = await load(params.driverUrl);
    const state = globalThis as unknown as { __skillConsentDriver: { start(): void } };
    state.__skillConsentDriver = await driver.installSkillDriver(getServices(), params.sessionId);
    state.__skillConsentDriver.start();
  }, { servicesUrl, driverUrl: pathToFileURL(driverPath).href, sessionId });

  const card = mainWindow.getByTestId("tool-approval-panel");
  await expect(card).toBeVisible();
  await expect(card).toContainText("docs-server");
  await expect(card).toContainText("skill://reports/SKILL.md");
  await expect(card.getByTestId("approval-impact-summary")).toBeVisible();
  await expect(card.getByTestId("approval-impact-summary")).toContainText("execute code on this computer");
  // One-shot cards keep remembering choices visible but disabled, with their refusal reason.
  await expect(card.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
  const screenshot = testInfo.outputPath("explicit-skill-consent.png");
  await card.screenshot({ path: screenshot });
  await testInfo.attach("explicit-skill-consent", { path: screenshot, contentType: "image/png" });
  await card.getByTestId(TEST_IDS.denyButton).focus();
  await card.getByTestId(TEST_IDS.denyButton).press("Enter");
  const readState = () => app.evaluate(() => (globalThis as unknown as { __skillConsentDriver: { state: { complete: boolean; isError: boolean; output: string; reads: number } } }).__skillConsentDriver.state);
  await expect.poll(async () => (await readState()).complete).toBe(true);
  expect((await readState()).isError).toBe(true);
  expect((await readState()).output).not.toContain("Read references/guide.md.");

  await app.evaluate(() => (globalThis as unknown as { __skillConsentDriver: { start(): void } }).__skillConsentDriver.start());
  await expect(card).toBeVisible();
  await card.getByTestId(TEST_IDS.approveButton).focus();
  await card.getByTestId(TEST_IDS.approveButton).press("Enter");
  await expect.poll(async () => (await readState()).complete).toBe(true);
  const approved = await readState();
  expect(approved.isError).toBe(false);
  expect(approved.output).toContain('origin="mcp" server="docs-server"');
  expect(approved.reads).toBe(2);
});
