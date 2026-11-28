import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "../../context.js";
import { createBootHostFixture } from "../../../__tests__/support/host-runtime.js";

const h = vi.hoisted(() => ({
  warn: vi.fn(),
  notificationOptions: vi.fn(),
  readPartitions: vi.fn(async (): Promise<string[] | null> => null),
  wirePersistence: vi.fn(),
  seedPartitions: vi.fn(),
}));

vi.mock("../../../main/notification-service.js", () => ({
  NotificationService: class {
    constructor(options: unknown) { h.notificationOptions(options); }
  },
}));

vi.mock("../../../main/plugin-auth-partition-store.js", () => ({
  readPersistedPluginAuthPartitions: h.readPartitions,
  writePersistedPluginAuthPartitions: vi.fn(async () => undefined),
  deletePersistedPluginAuthPartitions: vi.fn(async () => undefined),
  cleanupStaleTmpFiles: vi.fn(async () => undefined),
}));

vi.mock("../../../main/plugin-auth-partition-tracker.js", () => ({
  wirePluginAuthPartitionPersistence: h.wirePersistence,
  seedPluginAuthPartitions: h.seedPartitions,
}));

vi.mock("../../../i18n/index.js", () => ({ t: vi.fn((key: string) => key) }));
vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ warn: h.warn, info: vi.fn() })),
}));

import { setupNotifications } from "../notifications.js";
import { createDesktopHostFixture } from "../../../__tests__/support/host-runtime.js";

function makeContext(host = createBootHostFixture()): BootContext {
  return {
    host,
    getMainWindow: () => null,
    aveHomeDocUpgradeMarkers: [],
    settingsService: {
      get: vi.fn(() => ({})),
    },
  } as unknown as BootContext;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.readPartitions.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("setupNotifications OS notification presenter", () => {
  it("does not repeat native identity registration during service setup", async () => {
    const initializeNotificationPresenter = vi.fn(() => true);
    const desktop = createDesktopHostFixture({ initializeNotificationPresenter });
    const ctx = makeContext(createBootHostFixture({ desktop }));

    await setupNotifications(ctx);

    expect(initializeNotificationPresenter).not.toHaveBeenCalled();
  });

  it("boots a host without a desktop surface", async () => {
    const ctx = makeContext();

    await setupNotifications(ctx);

    expect(ctx.host.desktop).toBeUndefined();
    expect(ctx.notificationService).toBeDefined();
  });
});

it("keeps live notification preferences authoritative over desktop options", async () => {
  const desktop = createDesktopHostFixture({
    notificationOptions: { isOsNotificationsEnabled: () => true },
  });
  const ctx = makeContext(createBootHostFixture({ desktop }));
  await setupNotifications(ctx);
  const options = h.notificationOptions.mock.calls[0][0] as {
    isOsNotificationsEnabled: () => boolean;
  };
  let enabled = false;
  vi.mocked(ctx.settingsService.get).mockImplementation(((key: string) => key === "alerts"
    ? { osNotificationsEnabled: enabled }
    : {}) as never);
  expect(options.isOsNotificationsEnabled()).toBe(false);
  enabled = true;
  expect(options.isOsNotificationsEnabled()).toBe(true);
});

it("fails closed on corrupt live partition state and emits a warning", async () => {
  const failure = new Error("corrupt partition state");
  h.readPartitions.mockRejectedValue(failure);

  await expect(setupNotifications(makeContext())).rejects.toBe(failure);
  expect(h.warn).toHaveBeenCalledWith(
    { event: "plugin_auth_partition_load_failed", sessionId: "boot" },
    "plugin_auth_partition_load_failed",
  );
  expect(h.wirePersistence).not.toHaveBeenCalled();
});
