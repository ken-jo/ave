import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

// Unmarked legacy disabled mode migrates to strict once; marked user choices and other modes remain unchanged. Persist the marker so upgrades cannot silently replace fail-closed semantics with pass-through.
import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readPermissionSettings,
  migrateLegacyDisabledMode,
} from "../permission-settings-store.js";
import { PermissionTestResources } from "./test-resources.js";
import * as configurationAccess from "../../shared/ave-home-configuration-access.js";
import { AveHomeConfigurationUntrustedError } from "../../shared/ave-home.js";

const resources = new PermissionTestResources();

afterEach(async () => {
  await resources.cleanup();
});

function writeRaw(dir: string, body: object): string {
  const p = join(dir, "settings.json");
  writeFileSync(p, JSON.stringify(body, null, 2), { mode: 0o600 });
  return p;
}

describe("migrateLegacyDisabledMode — issue #664 idempotency", () => {
  it("(a) pre-#664 file: mode:disabled + no marker → mutates to strict + stamps marker", () => {
    const parsed: Record<string, unknown> = {
      permissions: {
        reviewer: {
          mode: "disabled",
          fallbackOnError: "deny",
          interactive: { autoApprove: "off" },
        },
      },
    };
    const migrated = migrateLegacyDisabledMode(parsed);
    expect(migrated).toBe(true);
    const r = (parsed.permissions as Record<string, unknown>).reviewer as Record<string, unknown>;
    expect(r.mode).toBe("strict");
    expect(typeof r.disabledMigratedAt).toBe("string");
    // ISO-8601 timestamp shape
    expect(r.disabledMigratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("(b) post-#664 file with marker → never re-migrates", () => {
    const parsed: Record<string, unknown> = {
      permissions: {
        reviewer: {
          mode: "strict",
          fallbackOnError: "deny",
          interactive: { autoApprove: "off" },
          disabledMigratedAt: "2026-05-17T00:00:00.000Z",
        },
      },
    };
    const migrated = migrateLegacyDisabledMode(parsed);
    expect(migrated).toBe(false);
    const r = (parsed.permissions as Record<string, unknown>).reviewer as Record<string, unknown>;
    expect(r.mode).toBe("strict");
    expect(r.disabledMigratedAt).toBe("2026-05-17T00:00:00.000Z");
  });

  it("(c) user-chosen disabled after migration: marker present → no re-migration", () => {
    const parsed: Record<string, unknown> = {
      permissions: {
        reviewer: {
          mode: "disabled",
          fallbackOnError: "deny",
          interactive: { autoApprove: "off" },
          disabledMigratedAt: "2026-05-17T00:00:00.000Z",
        },
      },
    };
    const migrated = migrateLegacyDisabledMode(parsed);
    expect(migrated).toBe(false);
    const r = (parsed.permissions as Record<string, unknown>).reviewer as Record<string, unknown>;
    // User's deliberate choice preserved — pass-through-LOW semantic.
    expect(r.mode).toBe("disabled");
  });

  it("(d) non-disabled modes (rule/llm/strict) → never migrated", () => {
    for (const mode of ["rule", "llm", "strict"]) {
      const parsed: Record<string, unknown> = {
        permissions: {
          reviewer: { mode, provider: "openai", model: "gpt-4o-mini" },
        },
      };
      const migrated = migrateLegacyDisabledMode(parsed);
      expect(migrated).toBe(false);
      const r = (parsed.permissions as Record<string, unknown>).reviewer as Record<string, unknown>;
      expect(r.mode).toBe(mode);
      expect(r.disabledMigratedAt).toBeUndefined();
    }
  });

  it("(e) malformed structures → no migration, no throw", () => {
    expect(migrateLegacyDisabledMode({})).toBe(false);
    expect(migrateLegacyDisabledMode({ permissions: null as unknown as object })).toBe(false);
    expect(
      migrateLegacyDisabledMode({ permissions: { reviewer: null as unknown as object } }),
    ).toBe(false);
    expect(
      migrateLegacyDisabledMode({ permissions: { reviewer: "not-an-object" } }),
    ).toBe(false);
  });
});

describe("readPermissionSettings — issue #664 migration end-to-end", () => {
  it("surfaces a boundary failure during migration instead of returning normal settings", () => {
    const dir = resources.makeTmpDir("ave-migration-boundary-");
    const path = writeRaw(dir, { permissions: { reviewer: { mode: "disabled" } } });
    const before = readFileSync(path, "utf8");
    const failure = new AveHomeConfigurationUntrustedError(path, "Unverified boundary");
    const write = vi.spyOn(configurationAccess, "tryWithAveHomeConfigurationWrite").mockImplementationOnce(() => { throw failure; });
    try {
      expect(() => readPermissionSettings(path)).toThrow(failure);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally { write.mockRestore(); }
  });

  it("persists the migrated file on first read", () => {
    const dir = resources.makeTmpDir("ave-664-mig-");
    const filePath = writeRaw(dir, {
      permissions: {
        reviewer: {
          mode: "disabled",
          fallbackOnError: "deny",
          interactive: { autoApprove: "off" },
        },
      },
    });

    const result = readPermissionSettings(filePath);
    expect(result.permissions.reviewer.mode).toBe("strict");
    expect(typeof result.permissions.reviewer.disabledMigratedAt).toBe("string");

    // On-disk file converged to the post-shape.
    const persisted = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(persisted.permissions.reviewer.mode).toBe("strict");
    expect(typeof persisted.permissions.reviewer.disabledMigratedAt).toBe("string");

    const before = readFileSync(filePath, "utf-8");
    readPermissionSettings(filePath);
    const after = readFileSync(filePath, "utf-8");
    expect(after).toBe(before);
  });

  it("preserves user-chosen disabled after migration marker present", () => {
    const dir = resources.makeTmpDir("ave-664-userpick-");
    const filePath = writeRaw(dir, {
      permissions: {
        reviewer: {
          mode: "disabled",
          fallbackOnError: "deny",
          interactive: { autoApprove: "off" },
          disabledMigratedAt: "2026-05-17T00:00:00.000Z",
        },
      },
    });

    const result = readPermissionSettings(filePath);
    expect(result.permissions.reviewer.mode).toBe("disabled");
    expect(result.permissions.reviewer.disabledMigratedAt).toBe(
      "2026-05-17T00:00:00.000Z",
    );
  });
});
