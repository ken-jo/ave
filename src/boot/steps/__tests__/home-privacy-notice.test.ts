import { expect, it, vi } from "vitest";
import { createBootHostFixture, createDesktopHostFixture } from "../../../__tests__/support/host-runtime.js";
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
