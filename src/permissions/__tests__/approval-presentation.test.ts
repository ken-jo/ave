import { expect, it, vi } from "vitest";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import { desktopApprovalCardPresenters, pickNativeFiles, pickNativeSavePath, showNativeError, showNativeMessage } from "../../main/desktop-approval-presentation.js";
import { presentRequiredApproval, UnattendedApprovalPresentationError } from "../approval-presentation.js";

const native = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/fixture/input"] })),
  showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: "/fixture/output" })),
  showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })),
  showErrorBox: vi.fn(),
}));
vi.mock("electron", () => ({ dialog: native }));

it("throws a typed refusal before invoking required presentation in the shared core", () => {
  const present = vi.fn(() => "presented");
  expect(() => turnExtensionPolicyContext.run({ unattendedStage: true, allowExternalHooks: false }, () =>
    presentRequiredApproval(present),
  )).toThrow(new UnattendedApprovalPresentationError("unattended-approval-denied"));
  expect(present).not.toHaveBeenCalled();
  expect(presentRequiredApproval(present)).toBe("presented");
});

it("throws before sending a required question card in an unattended turn", () => {
  const surface = makeMockWebContents();
  expect(() => turnExtensionPolicyContext.run({ unattendedStage: true, allowExternalHooks: false }, () => {
    desktopApprovalCardPresenters.presentQuestionCard(surface, {
      id: "question", sessionId: "stage", questions: [{ question: "Continue?", choices: ["Yes", "No"] }], createdAt: Date.now(),
    });
  })).toThrow("unattended-approval-denied");
  expect(surface.send).not.toHaveBeenCalled();
});

it("refuses native open, save, confirmation and error presentations in an unattended turn", async () => {
  await turnExtensionPolicyContext.run({ unattendedStage: true, allowExternalHooks: false }, async () => {
    await expect(pickNativeFiles({})).resolves.toEqual({ canceled: true, filePaths: [] });
    await expect(pickNativeSavePath({})).resolves.toEqual({ canceled: true, filePath: "" });
    await expect(showNativeMessage({ message: "Continue?" })).resolves.toBeUndefined();
    await showNativeError("Error", "Details");
  });
  for (const presenter of Object.values(native)) expect(presenter).not.toHaveBeenCalled();

  await expect(pickNativeFiles({})).resolves.toEqual({ canceled: false, filePaths: ["/fixture/input"] });
  await expect(pickNativeSavePath({})).resolves.toEqual({ canceled: false, filePath: "/fixture/output" });
  await expect(showNativeMessage({ message: "Continue?" })).resolves.toMatchObject({ response: 1 });
  await showNativeError("Error", "Details");
  for (const presenter of Object.values(native)) expect(presenter).toHaveBeenCalledOnce();
});
