import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "../../context.js";
import { createBootHostFixture } from "../../../__tests__/support/host-runtime.js";

const h = vi.hoisted(() => ({
  construct: vi.fn(),
  notificationOptions: vi.fn(),
  setupChain: vi.fn(),
  log: vi.fn(),
  flush: vi.fn(async () => undefined),
  rotate: vi.fn(async () => undefined),
  readPartitions: vi.fn(async (): Promise<string[] | null> => null),
  wirePersistence: vi.fn(),
  seedPartitions: vi.fn(),
}));

vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

vi.mock("../../../audit/audit-logger.js", () => ({
  AuditLogger: class {
    constructor() {
      h.construct();
    }
    setupPermissionAuditChain = h.setupChain;
    log = h.log;
    flush = h.flush;
    rotateAndPrune = h.rotate;
  },
}));

vi.mock("../../../audit/hmac-chain.js", () => ({
  FileSecretStore: class {},
  SafeStorageSecretStore: class {},
  ensureAuditSecret: vi.fn(() => "s".repeat(64)),
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
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn() })),
}));

import { setupAuditAndNotification } from "../audit-notification.js";
import { createDesktopHostFixture } from "../../../__tests__/support/host-runtime.js";

function makeContext(host = createBootHostFixture()): BootContext {
  return {
    host,
    getMainWindow: () => null,
    aveHomeDocUpgradeMarkers: [],
    settingsService: {
      get: vi.fn((key: string) =>
        key === "audit"
          ? { auditRotationMaxBytes: 1024, auditRetentionDays: 7 }
          : {},
      ),
    },
  } as unknown as BootContext;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.readPartitions.mockResolvedValue(null);
  h.flush.mockResolvedValue(undefined);
  h.rotate.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("setupAuditAndNotification audit lifecycle", () => {
  it("uses the shared runtime logger for audit maintenance", async () => {
    const ctx = makeContext();
    await setupAuditAndNotification(ctx);

    expect(h.construct).toHaveBeenCalledOnce();
    expect(h.rotate).toHaveBeenCalledWith({ maxBytes: 1024, retentionDays: 7 });
    expect(ctx.bootAuditLogger.rotateAndPrune).toBe(h.rotate);
  });

  it("drains a corrupt auth-partition audit record before boot rejects", async () => {
    const failure = new Error("corrupt auth partition state");
    h.readPartitions.mockRejectedValue(failure);

    await expect(setupAuditAndNotification(makeContext())).rejects.toBe(failure);

    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "boot",
      type: "error",
      input: "plugin-auth-partition-store: load failed at boot",
    }));
    expect(h.flush).toHaveBeenCalledOnce();
    expect(h.log.mock.invocationCallOrder[0]).toBeLessThan(
      h.flush.mock.invocationCallOrder[0],
    );
  });
});

describe("setupAuditAndNotification OS notification presenter", () => {
  // Initialize the presenter at boot so Windows registers persisted-toast activation before the first cue.
  it("initialises the desktop notification presenter once during boot", async () => {
    const initializeNotificationPresenter = vi.fn(() => true);
    const desktop = createDesktopHostFixture({ initializeNotificationPresenter });
    const ctx = makeContext(createBootHostFixture({ desktop }));

    await setupAuditAndNotification(ctx);

    expect(initializeNotificationPresenter).toHaveBeenCalledOnce();
  });

  it("initialises the presenter even when OS notifications are unsupported", async () => {
    const initializeNotificationPresenter = vi.fn(() => false);
    const desktop = createDesktopHostFixture({ initializeNotificationPresenter });

    await setupAuditAndNotification(makeContext(createBootHostFixture({ desktop })));

    expect(initializeNotificationPresenter).toHaveBeenCalledOnce();
  });

  it("boots a host without a desktop surface", async () => {
    const ctx = makeContext();

    await setupAuditAndNotification(ctx);

    expect(ctx.host.desktop).toBeUndefined();
    expect(ctx.notificationService).toBeDefined();
  });
});

it("keeps live notification preferences authoritative over desktop options", async () => {
  const desktop = createDesktopHostFixture({
    notificationOptions: { isTurnCompletionSoundEnabled: () => true, isOsNotificationsEnabled: () => true },
  });
  const ctx = makeContext(createBootHostFixture({ desktop }));
  await setupAuditAndNotification(ctx);
  const options = h.notificationOptions.mock.calls[0][0] as {
    isTurnCompletionSoundEnabled: () => boolean;
    isOsNotificationsEnabled: () => boolean;
  };
  let enabled = false;
  vi.mocked(ctx.settingsService.get).mockImplementation(((key: string) => key === "alerts"
    ? { osNotificationsEnabled: enabled }
    : { turnCompletionSoundEnabled: enabled }) as never);
  expect(options.isTurnCompletionSoundEnabled()).toBe(false);
  expect(options.isOsNotificationsEnabled()).toBe(false);
  enabled = true;
  expect(options.isTurnCompletionSoundEnabled()).toBe(true);
  expect(options.isOsNotificationsEnabled()).toBe(true);
});
