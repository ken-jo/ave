// Harness-only consumers still need registered cleanup so app trees and subscriptions cannot leak between tests.
import { afterAll, describe, expect, it } from "vitest";

import { renderApp } from "./render-app.js";

afterAll(() => {
  expect(document.body.textContent?.trim() ?? "").toBe("");
});

describe("renderApp cleanup contract", () => {
  it("mounts the app for a suite that imports only the harness", async () => {
    await renderApp({ hasApiKey: true });
    // Assert a tree existed so an empty app cannot satisfy the cleanup assertion.
    expect(document.body.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});
