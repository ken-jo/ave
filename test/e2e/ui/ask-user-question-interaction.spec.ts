import type { ElectronApplication, Page } from "playwright";
import { expect, test } from "./fixtures.js";

type CapturedResponse = {
  requestId?: string;
  answers?: Array<{ choice?: string; choices?: string[] }>;
  dismissed?: boolean;
};

// A question belongs to one conversation; only the tile that owns it draws the card (use-workflow-tools.ts).
async function currentSessionId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const listed = await (window as unknown as { aveApi: { chatSessions: (opts?: { kind?: string }) => Promise<{ current?: string }> } })
      .aveApi.chatSessions({ kind: "main" });
    if (typeof listed.current !== "string" || listed.current.length === 0) throw new Error("current chat session id unavailable");
    return listed.current;
  });
}

async function installQuestionHarness(
  app: ElectronApplication,
  page: Page,
  requestId: string,
  responseResult: { ok: boolean; error?: string } = { ok: true },
): Promise<void> {
  const sessionId = await currentSessionId(page);
  await app.evaluate(
    ({ BrowserWindow, ipcMain }, payload) => {
      const state = globalThis as unknown as { __askUserQuestionResponses: unknown[] };
      state.__askUserQuestionResponses = [];
      ipcMain.removeHandler("ave:ask-user-question:respond");
      ipcMain.handle("ave:ask-user-question:respond", (_event, response: unknown) => {
        state.__askUserQuestionResponses.push(response);
        return payload.responseResult;
      });

      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      win?.webContents.send("ave:ask-user-question:request", {
        id: payload.requestId,
        sessionId: payload.sessionId,
        createdAt: Date.now(),
        questions: [
          {
            question: "진행 방식을 선택하세요.",
            choices: ["계속 진행", "중단"],
          },
        ],
      });
    },
    { requestId, responseResult, sessionId },
  );
}

async function capturedResponses(app: ElectronApplication): Promise<CapturedResponse[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __askUserQuestionResponses?: CapturedResponse[] })
        .__askUserQuestionResponses ?? [],
  );
}

async function expectResponseCount(app: ElectronApplication, count: number): Promise<void> {
  await expect.poll(() => capturedResponses(app).then((responses) => responses.length), {
    timeout: 5_000,
  }).toBe(count);
}

test.use({ seedViewFixturePlugin: false });

test.describe("ask_user_question interaction", () => {
  test("submits a declared choice and removes the resolved card", async ({ app, mainWindow }) => {
    await installQuestionHarness(app, mainWindow, "e2e-choice-submit");

    const card = mainWindow.getByTestId("ask-user-question-card");
    await expect(card).toBeVisible();
    await expect(card.locator('[data-testid="ask-freetext-input"]')).toHaveCount(0);
    await card.getByRole("option", { name: "계속 진행" }).click();

    await expectResponseCount(app, 1);
    await expect(card).toHaveCount(0);
    expect(await capturedResponses(app)).toEqual([
      {
        requestId: "e2e-choice-submit",
        answers: [{ choice: "계속 진행" }],
      },
    ]);
  });

  test("dismisses the card without synthesizing a manual answer", async ({ app, mainWindow }) => {
    await installQuestionHarness(app, mainWindow, "e2e-choice-dismiss");

    const card = mainWindow.getByTestId("ask-user-question-card");
    await expect(card).toBeVisible();
    await card.getByTestId("ask-skip-button").click();

    await expectResponseCount(app, 1);
    await expect(card).toHaveCount(0);
    expect(await capturedResponses(app)).toEqual([
      { requestId: "e2e-choice-dismiss", dismissed: true },
    ]);
  });

  test("keeps the card visible when main rejects the response", async ({ app, mainWindow }) => {
    await installQuestionHarness(app, mainWindow, "e2e-choice-rejected", {
      ok: false,
      error: "invalid-answer",
    });

    const card = mainWindow.getByTestId("ask-user-question-card");
    await expect(card).toBeVisible();
    await card.getByRole("option", { name: "계속 진행" }).click();

    await expectResponseCount(app, 1);
    await expect(card).toBeVisible();
    await expect(card.getByRole("option", { name: "중단" })).toBeEnabled();
  });
});
