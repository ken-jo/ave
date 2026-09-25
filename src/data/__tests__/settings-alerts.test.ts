import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockedElectron = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    getSelectedStorageBackend: vi.fn(() => "gnome_libsecret" as const),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  safeStorage: mockedElectron.safeStorage,
}));

import { SettingsService } from "../settings-store.js";
import { DEFAULT_SETTINGS } from "../settings-defaults.js";
import {
  normalizeAlertSettings,
  normalizeRetiredPluginConfigs,
} from "../settings-normalization.js";
import {
  ALERT_HOST_PLUGIN_ID,
  isAlertKindKey,
  type AlertInheritRule,
  type AlertKindChoice,
  type RetiredPluginConfigRecord,
} from "../../shared/alerts-types.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SETTINGS_FILE = "ave-settings.json";
const HOST_DUE_SOON = `${ALERT_HOST_PLUGIN_ID}:due-soon`;

/** What a malformed kind entry is stored as: off, unseen, lowest visibility, marked repaired. */
const FAIL_CLOSED: AlertKindChoice = {
  enabled: false,
  osNotification: false,
  visibility: "silent",
  seenByUser: false,
  repaired: true,
};

const ENABLED_RULE: AlertInheritRule = {
  key: "disabledDetectors",
  listed: "disabled",
  values: ["due-soon", "legacy-due-soon"],
};
const OS_RULE: AlertInheritRule = {
  key: "osNotificationIntents",
  listed: "enabled",
  values: ["due-soon"],
  masterKey: "osNotificationsEnabled",
};

function choice(overrides: Partial<AlertKindChoice> = {}): AlertKindChoice {
  return {
    enabled: true,
    osNotification: false,
    visibility: "user-visible",
    seenByUser: false,
    ...overrides,
  };
}

function retiredRecord(overrides: Partial<RetiredPluginConfigRecord> = {}): RetiredPluginConfigRecord {
  return {
    config: { disabledDetectors: ["reply"], osNotificationsEnabled: true, nested: { list: [1, "two", null] } },
    enabled: true,
    sourceId: "ave",
    retiredAtAppVersion: "0.12.0",
    successors: {
      plugins: [{ pluginId: "fixturemail" }, { pluginId: "fixtureep", anySource: true }],
      hostKinds: [
        { kind: HOST_DUE_SOON, enabled: ENABLED_RULE, osNotification: OS_RULE },
        { kind: `${ALERT_HOST_PLUGIN_ID}:reminder`, enabled: ENABLED_RULE },
      ],
    },
    consumedBy: [],
    ...overrides,
  };
}

/** A record whose one host-kind mapping is `hostKind`, typed loosely so a broken shape can be written. */
function withHostKind(hostKind: unknown): unknown {
  const record = retiredRecord();
  return { ...record, successors: { ...record.successors, hostKinds: [hostKind] } };
}

describe("alert kind keys", () => {
  it("accept plugin and host kinds in the manifest grammar and nothing else", () => {
    expect(isAlertKindKey("fixturemail:mail-reply")).toBe(true);
    expect(isAlertKindKey(HOST_DUE_SOON)).toBe(true);
    // The bounds of each half: plugin ids 3 to 64 characters, kind ids 2 to 32.
    expect(isAlertKindKey("abc:de")).toBe(true);
    expect(isAlertKindKey(`${"p".repeat(64)}:${"k".repeat(32)}`)).toBe(true);
    for (const bad of [
      "ab:mail-reply",              // plugin id below the manifest minimum
      `${"p".repeat(65)}:mail`,     // plugin id above the manifest maximum
      "fixturemail:m",              // kind id below its minimum
      "fixturemail",                // no kind
      "fixturemail:",               // empty kind
      ":mail-reply",                // empty plugin
      "Fixture:mail-reply",         // uppercase
      "fixturemail:Mail",
      "fixture--mail:reply",        // double hyphen splits ambiguously
      "fixturemail:mail--reply",
      "fixturemail:-reply",         // kind must start with a letter
      "fixturemail:reply-",         // and end with a letter or digit
      "fixturemail:mail:reply",     // one separator only
      "@other:kind",                // only the host namespace uses @
      "@hosts:due-soon",
      `fixturemail:${"k".repeat(33)}`, // kind cap is 32
      42,
      null,
    ]) {
      expect(isAlertKindKey(bad), String(bad)).toBe(false);
    }
  });
});

describe("normalizeAlertSettings", () => {
  it("falls back to the defaults for a missing or non-object block", () => {
    expect(normalizeAlertSettings(undefined)).toEqual({ osNotificationsEnabled: true, kinds: {} });
    expect(normalizeAlertSettings([])).toEqual({ osNotificationsEnabled: true, kinds: {} });
    expect(normalizeAlertSettings("on")).toEqual({ osNotificationsEnabled: true, kinds: {} });
  });

  it("keeps the master switch only as a boolean", () => {
    expect(normalizeAlertSettings({ osNotificationsEnabled: false }).osNotificationsEnabled).toBe(false);
    expect(normalizeAlertSettings({ osNotificationsEnabled: "false" }).osNotificationsEnabled).toBe(true);
  });

  it("keeps well-formed plugin and host kind entries as stored", () => {
    const kinds = {
      "fixturemail:mail-reply": choice({ osNotification: true, visibility: "summary-only", seenByUser: true }),
      [HOST_DUE_SOON]: choice({ enabled: false }),
      "fixturemail:digest": choice({ visibility: "silent", absentSinceAppVersion: "0.12.3-beta.1" }),
    };
    expect(normalizeAlertSettings({ osNotificationsEnabled: false, kinds })).toEqual({
      osNotificationsEnabled: false,
      kinds,
    });
  });

  it("drops an entry whose key is not a kind key", () => {
    const result = normalizeAlertSettings({
      kinds: {
        "fixturemail:mail-reply": choice(),
        "Bad--Key:mail-reply": choice(),
        "fixturemail:mail:reply": choice(),
        "@other:due-soon": choice(),
      },
    });
    expect(Object.keys(result.kinds)).toEqual(["fixturemail:mail-reply"]);
  });

  it("stores an out-of-shape entry as off, unseen and consented to the lowest visibility", () => {
    const result = normalizeAlertSettings({
      kinds: {
        "fixturemail:missing-seen": { enabled: true, osNotification: true, visibility: "user-visible" },
        "fixturemail:bad-visibility": choice({ visibility: "loud" as never }),
        "fixturemail:string-enabled": choice({ enabled: "true" as never }),
        "fixturemail:numeric-os": choice({ osNotification: 1 as never }),
        "fixturemail:not-object": true,
        "fixturemail:array": [choice()],
        "fixturemail:absent-kept": { enabled: "yes", absentSinceAppVersion: "0.13.0" },
      },
    });
    expect(result.kinds).toEqual({
      "fixturemail:missing-seen": FAIL_CLOSED,
      "fixturemail:bad-visibility": FAIL_CLOSED,
      "fixturemail:string-enabled": FAIL_CLOSED,
      "fixturemail:numeric-os": FAIL_CLOSED,
      "fixturemail:not-object": FAIL_CLOSED,
      "fixturemail:array": FAIL_CLOSED,
      "fixturemail:absent-kept": { ...FAIL_CLOSED, absentSinceAppVersion: "0.13.0" },
    });
  });

  it("keeps absentSinceAppVersion only as a real version string", () => {
    const kinds = normalizeAlertSettings({
      kinds: {
        "fixturemail:kind-a": choice({ absentSinceAppVersion: "0.12.0" }),
        "fixturemail:kind-b": choice({ absentSinceAppVersion: "0.12.0-beta.1" }),
        "fixturemail:kind-c": choice({ absentSinceAppVersion: "unknown" }),
        "fixturemail:kind-d": choice({ absentSinceAppVersion: 12 as never }),
        "fixturemail:kind-e": choice({ absentSinceAppVersion: "01.2.3" }),
        "fixturemail:kind-f": choice({ absentSinceAppVersion: "0.12" }),
        "fixturemail:kind-g": choice({ absentSinceAppVersion: `0.12.0-${"x".repeat(40)}` }),
      },
    }).kinds;
    expect(kinds["fixturemail:kind-a"]?.absentSinceAppVersion).toBe("0.12.0");
    expect(kinds["fixturemail:kind-b"]?.absentSinceAppVersion).toBe("0.12.0-beta.1");
    for (const key of ["c", "d", "e", "f", "g"]) {
      expect(kinds[`fixturemail:kind-${key}`], key).toEqual(choice());
    }
  });

  it("keeps the repaired mark only as literal true", () => {
    const kinds = normalizeAlertSettings({
      kinds: {
        "fixturemail:repaired": { ...FAIL_CLOSED },
        "fixturemail:string-mark": { ...choice(), repaired: "yes" },
        "fixturemail:false-mark": { ...choice(), repaired: false },
      },
    }).kinds;
    expect(kinds["fixturemail:repaired"]).toEqual(FAIL_CLOSED);
    expect(kinds["fixturemail:string-mark"]).toEqual(choice());
    expect(kinds["fixturemail:false-mark"]).toEqual(choice());
  });

  describe("with the running app version", () => {
    const absent = (version: string): AlertKindChoice => choice({ absentSinceAppVersion: version });

    it("drops an entry whose plugin has been absent for two minor releases", () => {
      const stored = {
        kinds: {
          "fixturemail:absent": absent("0.12.0"),
          "fixturemail:present": choice(),
        },
      };
      expect(Object.keys(normalizeAlertSettings(stored, "0.13.9").kinds))
        .toEqual(["fixturemail:absent", "fixturemail:present"]);
      expect(Object.keys(normalizeAlertSettings(stored, "0.14.0").kinds)).toEqual(["fixturemail:present"]);
    });

    it("drops it at any higher major, whatever the minor", () => {
      const stored = { kinds: { "fixturemail:absent": absent("0.99.0") } };
      expect(normalizeAlertSettings(stored, "1.0.0").kinds).toEqual({});
      expect(Object.keys(normalizeAlertSettings({ kinds: { "fixturemail:absent": absent("1.0.0") } }, "0.14.0").kinds))
        .toEqual(["fixturemail:absent"]);
    });

    it("ages a repaired entry by the same rule", () => {
      const repaired = { ...FAIL_CLOSED, absentSinceAppVersion: "0.12.0" };
      const stored = { kinds: { "fixturemail:repaired": { enabled: "yes", absentSinceAppVersion: "0.12.0" } } };
      expect(normalizeAlertSettings(stored, "0.13.0").kinds).toEqual({ "fixturemail:repaired": repaired });
      expect(normalizeAlertSettings(stored, "0.14.0").kinds).toEqual({});
    });

    it("drops nothing without a usable running version", () => {
      const stored = { kinds: { "fixturemail:absent": absent("0.12.0") } };
      for (const running of [undefined, "unknown", ""]) {
        expect(Object.keys(normalizeAlertSettings(stored, running).kinds), String(running))
          .toEqual(["fixturemail:absent"]);
      }
    });
  });
});

describe("normalizeRetiredPluginConfigs", () => {
  it("returns an empty map for a missing or non-object block", () => {
    expect(normalizeRetiredPluginConfigs(undefined)).toEqual({});
    expect(normalizeRetiredPluginConfigs("gone")).toEqual({});
    expect(normalizeRetiredPluginConfigs([retiredRecord()])).toEqual({});
  });

  it("keeps a complete record, including a null source and a host kind without an OS rule", () => {
    const record = retiredRecord();
    expect(normalizeRetiredPluginConfigs({ retiredfixture: record })).toEqual({ retiredfixture: record });
    const unbound = retiredRecord({ sourceId: null, enabled: false, successors: { plugins: [], hostKinds: [] } });
    expect(normalizeRetiredPluginConfigs({ retiredfixture: unbound })).toEqual({ retiredfixture: unbound });
  });

  it("drops a record whole when any field is out of shape", () => {
    const record = retiredRecord();
    const hostKind = record.successors.hostKinds[0];
    const cases: Record<string, unknown> = {
      missingEnabled: { ...record, enabled: undefined },
      stringEnabled: { ...record, enabled: "yes" },
      numericSource: { ...record, sourceId: 7 },
      emptySource: { ...record, sourceId: "" },
      missingSource: { ...record, sourceId: undefined },
      unknownVersion: { ...record, retiredAtAppVersion: "unknown" },
      missingSuccessors: { ...record, successors: undefined },
      successorsWithoutHostKinds: { ...record, successors: { plugins: [] } },
      successorsWithoutPlugins: { ...record, successors: { hostKinds: [] } },
      anySourceFalse: { ...record, successors: { plugins: [{ pluginId: "fixtureep", anySource: false }], hostKinds: [] } },
      badSuccessorId: { ...record, successors: { plugins: [{ pluginId: "not a plugin id" }], hostKinds: [] } },
      pluginKindInHostKinds: withHostKind({ ...hostKind, kind: "fixturemail:due-soon" }),
      hostKindWithoutEnabled: withHostKind({ kind: HOST_DUE_SOON, osNotification: OS_RULE }),
      badRuleListed: withHostKind({ ...hostKind, enabled: { ...ENABLED_RULE, listed: "off" } }),
      badRuleValues: withHostKind({ ...hostKind, enabled: { ...ENABLED_RULE, values: ["due-soon", 3] } }),
      emptyRuleValues: withHostKind({ ...hostKind, enabled: { ...ENABLED_RULE, values: [] } }),
      emptyRuleKey: withHostKind({ ...hostKind, enabled: { ...ENABLED_RULE, key: "" } }),
      badMasterKey: withHostKind({ ...hostKind, osNotification: { ...OS_RULE, masterKey: false } }),
      badOsRule: withHostKind({ ...hostKind, osNotification: "on" }),
      missingConsumedBy: { ...record, consumedBy: undefined },
      stringConsumedBy: { ...record, consumedBy: "fixturemail" },
      badConsumedById: { ...record, consumedBy: ["fixturemail", "not a plugin id"] },
      numericConsumedBy: { ...record, consumedBy: [7] },
      arrayConfig: { ...record, config: [] },
      reservedConfigKey: { ...record, config: JSON.parse('{"__proto__": {"polluted": true}}') },
      notObject: "record",
    };
    for (const [name, broken] of Object.entries(cases)) {
      // Through JSON, as the loader sees it: a reserved key survives only as an own property there.
      const stored = JSON.parse(JSON.stringify({ retiredfixture: broken })) as unknown;
      expect(normalizeRetiredPluginConfigs(stored), name).toEqual({});
    }
  });

  it("drops a record under an invalid plugin id and keeps the others", () => {
    const record = retiredRecord();
    expect(normalizeRetiredPluginConfigs({ "*": record, "bad id": record, retiredfixture: record }))
      .toEqual({ retiredfixture: record });
  });

  describe("with the running app version", () => {
    // Retired at 0.12.0 with two successors, fixturemail and fixtureep.
    const waiting = retiredRecord({ consumedBy: ["fixturemail"] });
    const spent = retiredRecord({ consumedBy: ["fixtureep", "fixturemail", "fixturemail"] });

    it("keeps a record while any successor has not inherited, however old it is", () => {
      for (const running of ["0.14.0", "0.20.0", "1.0.0"]) {
        expect(normalizeRetiredPluginConfigs({ retiredfixture: waiting }, running), running)
          .toEqual({ retiredfixture: waiting });
      }
    });

    it("drops a record once every successor inherited and it is two minor releases old", () => {
      expect(normalizeRetiredPluginConfigs({ retiredfixture: spent }, "0.13.9")).toEqual({ retiredfixture: spent });
      expect(normalizeRetiredPluginConfigs({ retiredfixture: spent }, "0.14.0")).toEqual({});
    });

    it("drops a spent record at any higher major, and keeps one from a later major", () => {
      expect(normalizeRetiredPluginConfigs({ retiredfixture: spent }, "1.0.0")).toEqual({});
      const later = retiredRecord({ retiredAtAppVersion: "1.0.0", consumedBy: ["fixtureep", "fixturemail"] });
      expect(normalizeRetiredPluginConfigs({ retiredfixture: later }, "0.14.0")).toEqual({ retiredfixture: later });
    });

    it("drops nothing without a usable running version", () => {
      for (const running of [undefined, "unknown", ""]) {
        expect(normalizeRetiredPluginConfigs({ retiredfixture: spent }, running), String(running))
          .toEqual({ retiredfixture: spent });
      }
    });
  });
});

describe("SettingsService alerts and retired plugin configs", () => {
  let userDataPath: string;
  const writeStored = (stored: Record<string, unknown>): void => {
    writeFileSync(join(userDataPath, SETTINGS_FILE), JSON.stringify(stored), "utf-8");
  };
  const load = (): SettingsService =>
    new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-alerts-"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("starts from the defaults on a fresh install and on a file without the keys", () => {
    expect(DEFAULT_SETTINGS.alerts).toEqual({ osNotificationsEnabled: true, kinds: {} });
    expect(DEFAULT_SETTINGS.retiredPluginConfigs).toEqual({});

    const fresh = load();
    expect(fresh.get("alerts")).toEqual({ osNotificationsEnabled: true, kinds: {} });
    expect(fresh.get("retiredPluginConfigs")).toEqual({});

    writeStored({ chat: { autoCompact: false } });
    const older = load();
    expect(older.get("alerts")).toEqual({ osNotificationsEnabled: true, kinds: {} });
    expect(older.get("retiredPluginConfigs")).toEqual({});
  });

  it("normalises both blocks when reading the file", () => {
    writeStored({
      alerts: {
        osNotificationsEnabled: false,
        kinds: {
          "fixturemail:mail-reply": choice({ seenByUser: true }),
          "fixturemail:broken": { enabled: true },
          "Bad:key": choice(),
        },
      },
      retiredPluginConfigs: {
        retiredfixture: retiredRecord(),
        brokenfixture: retiredRecord({ retiredAtAppVersion: "unknown" }),
      },
    });
    const service = load();
    expect(service.get("alerts")).toEqual({
      osNotificationsEnabled: false,
      kinds: {
        "fixturemail:mail-reply": choice({ seenByUser: true }),
        "fixturemail:broken": FAIL_CLOSED,
      },
    });
    expect(service.get("retiredPluginConfigs")).toEqual({ retiredfixture: retiredRecord() });
  });

  it("leaves both blocks alone when a generic patch carries them", async () => {
    const kinds = { "fixturemail:mail-reply": choice({ seenByUser: true }) };
    writeStored({
      alerts: { osNotificationsEnabled: true, kinds },
      retiredPluginConfigs: { retiredfixture: retiredRecord() },
    });
    const service = load();
    await service.patch({
      chat: { autoCompact: false },
      // @ts-expect-error — the alerts service is the only writer of `alerts`.
      alerts: { osNotificationsEnabled: false, kinds: {} },
    });
    await service.patch({
      // @ts-expect-error — only a retirement writes `retiredPluginConfigs`.
      retiredPluginConfigs: {},
    });
    expect(service.get("chat").autoCompact).toBe(false);
    expect(service.get("alerts")).toEqual({ osNotificationsEnabled: true, kinds });
    expect(service.get("retiredPluginConfigs")).toEqual({ retiredfixture: retiredRecord() });

    const reloaded = load();
    expect(reloaded.get("chat").autoCompact).toBe(false);
    expect(reloaded.get("alerts")).toEqual({ osNotificationsEnabled: true, kinds });
    expect(reloaded.get("retiredPluginConfigs")).toEqual({ retiredfixture: retiredRecord() });
  });

  it("drops outlived entries on load when it knows the running version, and only then", () => {
    const waiting = retiredRecord({ consumedBy: ["fixturemail"] });
    const spent = retiredRecord({ consumedBy: ["fixturemail", "fixtureep"] });
    const present = choice({ seenByUser: true });
    writeStored({
      alerts: {
        kinds: {
          "fixturemail:absent": choice({ absentSinceAppVersion: "0.12.0" }),
          "fixturemail:present": present,
        },
      },
      retiredPluginConfigs: { waitingfixture: waiting, spentfixture: spent },
    });

    const current = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, appVersion: "0.14.0" });
    expect(current.get("alerts").kinds).toEqual({ "fixturemail:present": present });
    expect(current.get("retiredPluginConfigs")).toEqual({ waitingfixture: waiting });

    const unversioned = load();
    expect(Object.keys(unversioned.get("alerts").kinds)).toEqual(["fixturemail:absent", "fixturemail:present"]);
    expect(Object.keys(unversioned.get("retiredPluginConfigs"))).toEqual(["waitingfixture", "spentfixture"]);
  });

  it("is given the running version by the boot step that creates it", () => {
    const bootSource = readFileSync(new URL("../../boot/services.ts", import.meta.url), "utf8");
    const construction = /new SettingsService\(\{[^}]*\}\)/.exec(bootSource)?.[0] ?? "";
    expect(construction).toContain("appVersion: getAveAppVersion()");
  });

  it("persists a whole-block set and reads it back through the normaliser", async () => {
    const service = load();
    const kinds = {
      "fixturemail:mail-reply": choice({ absentSinceAppVersion: "0.12.0" }),
      [HOST_DUE_SOON]: choice({ enabled: false, seenByUser: true }),
    };
    await service.set("alerts", { osNotificationsEnabled: false, kinds });
    await service.set("retiredPluginConfigs", { retiredfixture: retiredRecord() });

    const onDisk = JSON.parse(readFileSync(join(userDataPath, SETTINGS_FILE), "utf-8")) as Record<string, unknown>;
    expect(onDisk.alerts).toEqual({ osNotificationsEnabled: false, kinds });
    expect(onDisk.retiredPluginConfigs).toEqual({ retiredfixture: retiredRecord() });

    const reloaded = load();
    expect(reloaded.get("alerts")).toEqual({ osNotificationsEnabled: false, kinds });
    expect(reloaded.get("retiredPluginConfigs")).toEqual({ retiredfixture: retiredRecord() });
  });
});
