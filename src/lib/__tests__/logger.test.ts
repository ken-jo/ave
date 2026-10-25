/** Re-import per scenario because logger format constants are evaluated at module load. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const NOT_SET = Symbol("NOT_SET");

async function importLogger(
  envOverrides: Record<string, string | undefined> = {},
  processOverrides: {
    electronVersion?: string | null | typeof NOT_SET;
    defaultApp?: boolean | null | typeof NOT_SET;
  } = {},
) {
  vi.resetModules();

  const { electronVersion = NOT_SET, defaultApp = NOT_SET } = processOverrides;

  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const versionsProxy = process.versions as Record<string, string | undefined>;
  const savedElectron = versionsProxy.electron;
  const changeElectron = electronVersion !== NOT_SET;
  if (changeElectron) {
    if (electronVersion === null || electronVersion === undefined) {
      delete versionsProxy.electron;
    } else {
      versionsProxy.electron = electronVersion;
    }
  }

  const procAny = process as NodeJS.Process & { defaultApp?: boolean };
  const hadDefaultApp = "defaultApp" in procAny;
  const savedDefaultApp = procAny.defaultApp;
  const changeDefaultApp = defaultApp !== NOT_SET;
  if (changeDefaultApp) {
    if (defaultApp === null || defaultApp === undefined) {
      delete procAny.defaultApp;
    } else {
      procAny.defaultApp = defaultApp;
    }
  }

  try {
    const mod = await import("../logger.js");
    return mod;
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (changeElectron) {
      if (savedElectron === undefined) {
        delete versionsProxy.electron;
      } else {
        versionsProxy.electron = savedElectron;
      }
    }
    if (changeDefaultApp) {
      if (!hadDefaultApp) {
        delete procAny.defaultApp;
      } else {
        procAny.defaultApp = savedDefaultApp;
      }
    }
  }
}

describe("logger format selection", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses pino-pretty transport when NODE_ENV=development and AVE_DEV=1", async () => {
    const { logger, transport } = await importLogger({
      NODE_ENV: "development",
      AVE_LOG_FORMAT: undefined,
      VITEST: undefined,
      AVE_DEV: "1",
    });
    expect(logger.level).toBe("debug");
    expect(transport).toBeDefined();
    expect((transport as { target: string }).target).toBe("pino-pretty");
  });

  it("uses JSON (no transport) when NODE_ENV=production", async () => {
    const { logger, transport } = await importLogger({
      NODE_ENV: "production",
      AVE_LOG_FORMAT: undefined,
      VITEST: undefined,
    });
    expect(logger.level).toBe("info");
    expect(transport).toBeUndefined();
  });

  it("forces JSON (transport=undefined) when AVE_LOG_FORMAT=json regardless of NODE_ENV", async () => {
    const { logger, transport } = await importLogger({
      NODE_ENV: "development",
      AVE_LOG_FORMAT: "json",
      VITEST: undefined,
      AVE_DEV: "1",
    });
    expect(logger.level).toBe("debug");
    expect(transport).toBeUndefined();
  });

  it("delegates to console in an unpackaged test environment", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { createLogger } = await importLogger(
        { VITEST: "1", NODE_ENV: "test" },
        { electronVersion: "32.0.0", defaultApp: true },
      );
      createLogger("test-module").info("test message");
      expect(spy).toHaveBeenCalledWith("[test-module] test message");
    } finally {
      spy.mockRestore();
    }
  });

  it("isProduction=false gives debug level by default", async () => {
    const { logger } = await importLogger({
      NODE_ENV: "development",
      LOG_LEVEL: undefined,
      AVE_LOG_FORMAT: undefined,
      VITEST: undefined,
      AVE_DEV: "1",
    });
    expect(logger.level).toBe("debug");
  });

  it("respects LOG_LEVEL override", async () => {
    const { logger } = await importLogger({
      NODE_ENV: "development",
      LOG_LEVEL: "warn",
      AVE_LOG_FORMAT: undefined,
      VITEST: undefined,
      AVE_DEV: "1",
    });
    expect(logger.level).toBe("warn");
  });

  it("Electron + unpackaged (defaultApp=true) → pino-pretty, not JSON", async () => {
    const { transport } = await importLogger(
      {
        NODE_ENV: "development",
        AVE_LOG_FORMAT: undefined,
        VITEST: undefined,
        AVE_DEV: undefined,
      },
      { electronVersion: "32.0.0", defaultApp: true },
    );
    expect(transport).toBeDefined();
    expect((transport as { target: string }).target).toBe("pino-pretty");
  });

  it("Electron + packaged (defaultApp absent) → JSON (no transport), info level", async () => {
    const { transport, logger } = await importLogger(
      {
        NODE_ENV: "development", // packaged Electron does not set NODE_ENV=production
        AVE_LOG_FORMAT: undefined,
        VITEST: undefined,
        AVE_DEV: undefined,
      },
      { electronVersion: "32.0.0", defaultApp: null }, // null = delete the key
    );
    expect(transport).toBeUndefined();
    expect(logger.level).toBe("info");
  });

  it("Electron + packaged + AVE_DEV=1 → still JSON: a packaged binary ignores the dev flag", async () => {
    // Packaged builds must ignore development flags when choosing log format.
    const { transport, logger } = await importLogger(
      {
        NODE_ENV: "development",
        AVE_LOG_FORMAT: undefined,
        VITEST: undefined,
        AVE_DEV: "1",
      },
      { electronVersion: "32.0.0", defaultApp: null },
    );
    expect(transport).toBeUndefined();
    expect(logger.level).toBe("info");
  });

  it("packaged Electron ignores VITEST and NODE_ENV=test for logger path and redaction", async () => {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { createLogger, logger, transport } = await importLogger(
        {
          NODE_ENV: "test",
          VITEST: "1",
          AVE_LOG_FORMAT: undefined,
          AVE_DEV: "1",
        },
        { electronVersion: "32.0.0", defaultApp: null },
      );
      createLogger("packaged-test-env").info(
        { token: "secret-token", retained: "visible" },
        "packaged logger",
      );
      expect(transport).toBeUndefined();
      expect(logger.level).toBe("info");
      expect(consoleLog).not.toHaveBeenCalled();
      const output = writes.join("");
      expect(output).toContain("packaged logger");
      expect(output).toContain("[redacted]");
      expect(output).not.toContain("secret-token");
      expect(output).toContain("visible");
    } finally {
      consoleLog.mockRestore();
      stdout.mockRestore();
    }
  });

  it("plain Node.js (no process.versions.electron) → isElectronRuntime=false → pino-pretty for dev", async () => {
    const { transport } = await importLogger(
      {
        NODE_ENV: "development",
        AVE_LOG_FORMAT: undefined,
        VITEST: undefined,
        AVE_DEV: "1",
      },
      { electronVersion: null }, // null = delete the key
    );
    expect(transport).toBeDefined();
    expect((transport as { target: string }).target).toBe("pino-pretty");
  });
});

describe("logger redaction (#1499 disk-persistence defense)", () => {
  it("censors secret-bearing fields in JSON output", async () => {
    // Exercise the real JSON stream and assert redaction at top level and one level deep.
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(chunk.toString());
        return true;
      }) as typeof process.stdout.write);
    try {
      const { logger } = await importLogger({
        AVE_LOG_FORMAT: "json",
        VITEST: undefined,
        NODE_ENV: "development",
        AVE_DEV: "1",
      });
      logger.info(
        { apiKey: "sk-secret", provider: { token: "tok-123" }, sessionId: "keep-me" },
        "redaction probe",
      );
    } finally {
      spy.mockRestore();
    }
    const line = writes.join("");
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("sk-secret");
    expect(line).not.toContain("tok-123");
    expect(line).toContain("keep-me");
  });
});

describe("initFileLogSink — fail-closed lifecycle (#1499)", () => {
  it("swallows a createLogFileSink failure and returns null (never bricks boot)", async () => {
    // Occupy the parent with a file to force sink creation failure; boot must receive null rather than throw.
    const dir = mkdtempSync(join(tmpdir(), "ave-logfail-"));
    const parentFile = join(dir, "not-a-dir");
    writeFileSync(parentFile, "x");
    const badDir = join(parentFile, "logs"); // parent is a file → mkdir fails

    const { initFileLogSink, closeFileLogSink } = await importLogger();
    let sink: unknown;
    let threw = false;
    try {
      sink = initFileLogSink({ dir: badDir });
    } catch {
      threw = true;
    } finally {
      closeFileLogSink();
      await cleanupTmpDir(dir);
    }
    expect(threw).toBe(false);
    expect(sink).toBeNull();
  });

  it("returns a live sink for a valid directory (happy path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-logok-"));
    const { initFileLogSink, closeFileLogSink } = await importLogger();
    const sink = initFileLogSink({ dir, retentionDays: 7 });
    try {
      expect(sink).not.toBeNull();
      expect(typeof sink?.currentFile).toBe("string");
      expect(sink?.currentFile.startsWith(dir)).toBe(true);
      if (sink) {
        await vi.waitFor(() => {
          expect(existsSync(sink.currentFile)).toBe(true);
        });
      }
    } finally {
      closeFileLogSink();
      // Wait for file readiness and close callbacks, then retry residual filesystem locks.
      await new Promise((r) => setTimeout(r, 0));
      await cleanupTmpDir(dir);
    }
  });
});
