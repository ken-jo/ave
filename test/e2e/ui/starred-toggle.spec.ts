import { test, expect, type Page } from "@playwright/test";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron";

type StarredEntry = { sessionId: string; messageIndex: number; role: string; text: string };

function starredList(page: Page): Promise<StarredEntry[]> {
  return page.evaluate(() =>
    (window as unknown as { aveApi: { starredList: () => Promise<StarredEntry[]> } }).aveApi.starredList(),
  );
}

test.describe("pinned message toggle", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  let ctx: SeededElectronContext | null = null;

  test.afterEach(async () => {
    if (ctx) await teardownSeededElectron(ctx);
    ctx = null;
  });

  test("pins a finished assistant turn and unpins it again", async () => {
    const now = Date.now();
    ctx = await launchSeededElectron({
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      sessionTitle: "pinned toggle",
      historyRows: [
        { index: 0, role: "user", content: "Name one prime number.", createdAt: now - 2_000 },
        { index: 1, role: "assistant", content: "Seven is a prime number.", createdAt: now - 1_000 },
      ],
      userDataPrefix: "ave-pin-toggle-user-data-",
      homePrefix: "ave-pin-toggle-home-",
    });
    const { page } = ctx;

    await expect(page.getByText("Seven is a prime number.")).toBeVisible({ timeout: 20_000 });
    const pin = page.getByTestId("turn-pin-button").first();
    await expect(pin).toBeVisible();
    const icon = pin.locator("svg");
    await expect(icon).not.toHaveClass(/fill-emphasis/);
    expect(await starredList(page)).toEqual([]);

    await pin.click();
    await expect(icon).toHaveClass(/fill-emphasis/);
    await expect.poll(async () => (await starredList(page)).map((entry) => entry.text))
      .toEqual([expect.stringContaining("Seven is a prime number.")]);

    await pin.click();
    await expect(icon).not.toHaveClass(/fill-emphasis/);
    await expect.poll(async () => (await starredList(page)).length).toBe(0);
  });
});
