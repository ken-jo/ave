import { expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
const acknowledge = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/logger.js")>();
  return { ...actual, createLogger: (name: string) => ({ ...actual.createLogger(name), warn }) };
});
vi.mock("../../../shared/ave-home.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../shared/ave-home.js")>(), acknowledgeHomeBoundaryRepair: acknowledge,
}));
import { createBootHostFixture, createDesktopHostFixture } from "../../../__tests__/support/host-runtime.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { NotificationService } from "../../../main/notification-service.js";
import { translate } from "../../../i18n/index.js";
import { isModelFacingKey } from "../../../i18n/model-facing.js";
import { notifyHomeBoundaryRepairs, notifyHomeConfigurationPreserved } from "../home-privacy-notice.js";

function notificationFixture() {
  const show = vi.fn();
  const present = vi.fn(() => ({ show, on: vi.fn() }));
  const notificationService = new NotificationService({
    getMainWindow: () => null,
    isReady: () => true,
    isTestEnv: () => false,
    notificationFactory: present,
  });
  return { show, present, notificationService };
}

it("names an outside root configuration copy in a system boot notice", () => {
  const { show, present, notificationService } = notificationFixture();
  const path = "/fixture/policy.json.post-migration-20261026T000000Z";
  notifyHomeConfigurationPreserved([`Legacy configuration preserved at ${path}`], {
    host: createBootHostFixture({ desktop: createDesktopHostFixture() }), notificationService,
  });
  expect(show).toHaveBeenCalledOnce();
  expect(present).toHaveBeenCalledWith(expect.objectContaining({
    title: translate("ko", "homePrivacy.configurationPreservedTitle"),
    body: expect.stringContaining("policy.json.post-migration-20261026T000000Z"),
  }));
});

it("does not issue a configuration notice for successful cleanup", () => {
  const { present, notificationService } = notificationFixture();
  notifyHomeConfigurationPreserved([], { host: createBootHostFixture({ desktop: createDesktopHostFixture() }), notificationService });
  expect(present).not.toHaveBeenCalled();
});

it("presents exactly one system notice per repaired boundary", () => {
  const { show, present, notificationService } = notificationFixture();
  const host = createBootHostFixture({ desktop: createDesktopHostFixture() });
  notifyHomeBoundaryRepairs({ enforcement: "win32-dacl", home: "/fixture", sid: "fixture",
    repairs: ["/fixture/secrets", "/fixture/keys"] }, { host, notificationService });
  expect(show).toHaveBeenCalledTimes(2);
  expect(present).toHaveBeenCalledTimes(2);
  expect(present).toHaveBeenCalledWith(expect.objectContaining({
    title: translate("ko", "homePrivacy.boundaryRepairedTitle"),
    body: translate("ko", "homePrivacy.boundaryRepaired"),
  }));
  expect(translate("en", "homePrivacy.boundaryRepaired")).toContain("Sign out and sign in again");
  expect(translate("ko", "homePrivacy.boundaryRepaired")).toContain("다시 로그인");
  expect([...translate("en", "homePrivacy.boundaryRepaired")].length).toBeLessThanOrEqual(80);
  expect([...translate("ko", "homePrivacy.boundaryRepaired")].length).toBeLessThanOrEqual(80);
  expect(isModelFacingKey("homePrivacy.boundaryRepaired")).toBe(false);
  expect(isModelFacingKey("homePrivacy.boundaryRepairedTitle")).toBe(false);
});

it("presents no repair notice on a clean boot", () => {
  const { show, present, notificationService } = notificationFixture();
  const host = createBootHostFixture({ desktop: createDesktopHostFixture() });
  notifyHomeBoundaryRepairs({ enforcement: "win32-dacl", home: "/fixture", sid: "fixture" }, { host, notificationService });
  expect(show).not.toHaveBeenCalled();
  expect(present).not.toHaveBeenCalled();
});

it("keeps repair notices out of desktop delivery on a headless host", () => {
  const { show, present, notificationService } = notificationFixture();
  notifyHomeBoundaryRepairs({ enforcement: "win32-dacl", home: "/fixture", sid: "fixture",
    repairs: ["/fixture/secrets"] }, { host: createBootHostFixture(), notificationService });
  expect(show).not.toHaveBeenCalled();
  expect(present).not.toHaveBeenCalled();
});

it("reports a repaired home root once, without its path in the log and without a pending notice", () => {
  const { show, present, notificationService } = notificationFixture();
  warn.mockClear(); acknowledge.mockClear();
  const home = "C:\\Users\\example\\ave";
  notifyHomeBoundaryRepairs({ enforcement: "win32-dacl", home, sid: "fixture", repairs: [home, `${home}\\keys`] },
    { host: createBootHostFixture({ desktop: createDesktopHostFixture() }), notificationService });
  expect(show).toHaveBeenCalledTimes(2);
  expect(present).toHaveBeenCalledWith(expect.objectContaining({
    title: translate("ko", "homePrivacy.boundaryRepairedTitle"), body: translate("ko", "homePrivacy.rootRepaired"),
  }));
  // The root path names the user's profile; the log names the role. Only the subdirectory has a notice marker to acknowledge.
  const rootLine = warn.mock.calls.find((call) => String(call[0]).includes("AVE_HOME root repaired"));
  expect(rootLine).toBeDefined();
  expect(JSON.stringify(rootLine)).not.toContain("someone");
  expect(acknowledge.mock.calls.map((call) => call[1])).toEqual([`${home}\\keys`]);
  for (const locale of ["en", "ko"] as const) expect([...translate(locale, "homePrivacy.rootRepaired")].length).toBeLessThanOrEqual(80);
  expect(isModelFacingKey("homePrivacy.rootRepaired")).toBe(false);
});

it("tells the user a reset runtime boundary will be rebuilt instead of asking them to sign in again", () => {
  const { present, notificationService } = notificationFixture();
  const host = createBootHostFixture({ desktop: createDesktopHostFixture() });
  notifyHomeBoundaryRepairs({ enforcement: "win32-dacl", home: "/fixture", sid: "fixture",
    repairs: ["/fixture/runtime"] }, { host, notificationService });
  expect(present).toHaveBeenCalledOnce();
  expect(present).toHaveBeenCalledWith(expect.objectContaining({
    title: translate("ko", "homePrivacy.boundaryRepairedTitle"),
    body: translate("ko", "homePrivacy.runtimeReset"),
  }));
  // The same instruction as the rebuild-needed error, short enough to reach the user untruncated.
  expect(translate("en", "homePrivacy.runtimeReset")).toContain("connect to the network and restart Ave".replace(/^c/, "C"));
  expect(translate("en", "be_pythonRuntime.errRebuildNeeded", { message: "" })).toContain("connect to the network and restart Ave");
  expect(translate("en", "homePrivacy.runtimeReset")).not.toContain("Sign out");
});


it("keeps boot repair and configuration records until the real renderer subscribes, without repeating OS cues", () => {
  const contents = { send: vi.fn(), on: vi.fn(), once: vi.fn(), isDestroyed: () => false };
  const win = { webContents: contents, isDestroyed: () => false, isMinimized: () => false };
  const show = vi.fn();
  const service = new NotificationService({ getMainWindow: () => win as unknown as Electron.BrowserWindow,
    isReady: () => true, isTestEnv: () => false, notificationFactory: () => ({ show, on: vi.fn() }) });
  const host = createBootHostFixture({ desktop: createDesktopHostFixture() });
  notifyHomeBoundaryRepairs({ enforcement: "win32-dacl", home: "/fixture", sid: "fixture", repairs: ["/fixture/secrets"] },
    { host, notificationService: service });
  notifyHomeConfigurationPreserved(["Legacy configuration preserved at /fixture/policy.json"], { host, notificationService: service });
  expect(show).toHaveBeenCalledTimes(2);
  expect(contents.send).not.toHaveBeenCalled();
  service.setHistorySubscriber(contents as unknown as Electron.WebContents, true);
  expect(contents.send).toHaveBeenCalledTimes(2);
  expect(contents.send.mock.calls.map(([channel]) => channel)).toEqual([CHANNELS.notification.toast, CHANNELS.notification.toast]);
  expect(contents.send.mock.calls.map(([, payload]) => payload.title)).toEqual([
    translate("ko", "homePrivacy.boundaryRepairedTitle"), translate("ko", "homePrivacy.configurationPreservedTitle"),
  ]);
  service.setHistorySubscriber(contents as unknown as Electron.WebContents, true);
  expect(contents.send).toHaveBeenCalledTimes(4);
  expect(contents.send.mock.calls.slice(0, 2)).toEqual(contents.send.mock.calls.slice(2));
  expect(show).toHaveBeenCalledTimes(2);
});
