import { test, expect } from "./fixtures.js";

test.use({ seedViewFixturePlugin: false });

test("background keyboard input passes the gesture gate while synthetic input is refused", async ({ app, mainWindow }, testInfo) => {
  await expect.poll(() => mainWindow.evaluate(() => document.hasFocus())).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isFocused()))).toBe(false);
  const cdp = await mainWindow.context().newCDPSession(mainWindow);
  await mainWindow.evaluate(() => {
    const input = document.createElement("input");
    input.id = "background-keyboard";
    input.setAttribute("aria-label", "Background keyboard");
    document.body.append(input);
    input.focus();
    const results: unknown[] = [];
    (window as unknown as { backgroundInputResults: unknown[] }).backgroundInputResults = results;
    input.addEventListener("keydown", (event) => {
      void window.ave.permission.addRule("background-focus-probe", "deny").then((result) => results.push({ trusted: event.isTrusted, result }));
    });
  });
  // Evaluation helpers grant transient activation themselves. Read through the protocol without granting a gesture before the negative control.
  await expect.poll(async () => {
    const reply = await cdp.send("Runtime.evaluate", { expression: "navigator.userActivation.isActive", userGesture: false, returnByValue: true });
    return reply.result.value;
  }).toBe(false);
  await cdp.send("Runtime.evaluate", { expression: 'document.getElementById("background-keyboard").dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))', userGesture: false });
  const results = () => mainWindow.evaluate(() => (window as unknown as { backgroundInputResults: unknown[] }).backgroundInputResults);
  await expect.poll(results).toEqual([{ trusted: false, result: expect.objectContaining({ ok: false, error: "user-keyboard-required" }) }]);
  await mainWindow.keyboard.press("a");
  await expect.poll(results).toEqual([
    { trusted: false, result: expect.objectContaining({ ok: false, error: "user-keyboard-required" }) },
    { trusted: true, result: expect.objectContaining({ ok: true }) },
  ]);
  await expect(mainWindow.getByLabel("Background keyboard")).toHaveValue("a");
  expect(await mainWindow.getByLabel("Background keyboard").evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isFocused()))).toBe(false);
  await mainWindow.screenshot({ path: testInfo.outputPath("background-keyboard.png") });
});
