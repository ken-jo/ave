import { expect, it, vi } from "vitest";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import { pickNativeFiles, pickNativeSavePath, showNativeError, showNativeMessage } from "../approval-presentation.js";

const native = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/fixture/input"] })),
  showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: "/fixture/output" })),
  showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })),
  showErrorBox: vi.fn(),
}));
vi.mock("electron", () => ({ dialog: native }));

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
