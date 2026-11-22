import { expect, it, vi } from "vitest";
import { createBootHostFixture, createDesktopHostFixture } from "../../../__tests__/support/host-runtime.js";
import { t } from "../../../i18n/index.js";
import { en } from "../../../i18n/messages/en.js";
import { ko } from "../../../i18n/messages/ko.js";
import type { NotificationService } from "../../../main/notification-service.js";
import { noticeLegacyBoardKept } from "../work-board-setup.js";

const paths = ["/home/example/.ave/plugins/a/data/board.json", "/home/example/.ave/plugins/b/data/board.json"];

function marker() {
  const files = new Map<string, unknown>();
  return {
    files,
    readJson: vi.fn(async (path: string) => (files.get(path) ?? null) as never),
    writeJson: vi.fn(async (path: string, value: unknown) => { files.set(path, value); }),
  };
}

const service = (accepted: boolean) => ({ deliver: vi.fn(() => ({ accepted })) });
const desktop = () => createBootHostFixture({ desktop: createDesktopHostFixture() });

it("names every legacy board left as it is in one system notice, once per home, marked only once it was shown", async () => {
  const stored = marker();
  const refused = service(false);
  await noticeLegacyBoardKept(paths, { host: desktop(), notificationService: refused as unknown as NotificationService }, stored);
  expect(refused.deliver).toHaveBeenCalledExactlyOnceWith({
    kind: "system", title: t("be_workBoard.legacyBoardKeptTitle"), body: t("be_workBoard.legacyBoardKept", { path: paths.join(", ") }), bypassFocusGate: true,
  });
  expect(stored.files.size).toBe(0);
  const shown = service(true);
  await noticeLegacyBoardKept(paths, { host: desktop(), notificationService: shown as unknown as NotificationService }, stored);
  expect(shown.deliver).toHaveBeenCalledOnce();
  expect(stored.files.size).toBe(1);
  await noticeLegacyBoardKept(paths, { host: desktop(), notificationService: shown as unknown as NotificationService }, stored);
  expect(shown.deliver).toHaveBeenCalledOnce();
});

it("shows nothing off the desktop", async () => {
  const shown = service(true);
  await noticeLegacyBoardKept(paths, { host: createBootHostFixture(), notificationService: shown as unknown as NotificationService }, marker());
  expect(shown.deliver).not.toHaveBeenCalled();
});

it.each([["en", en], ["ko", ko]] as const)("says in %s where the legacy board is", (_locale, catalog) => {
  expect(catalog).toHaveProperty(["be_workBoard.legacyBoardKeptTitle"]);
  expect(catalog).toHaveProperty(["be_workBoard.legacyBoardKept"], expect.stringContaining("{path}"));
});
