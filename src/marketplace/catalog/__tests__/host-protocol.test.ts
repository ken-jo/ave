import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../__tests__/fixtures/mixed-host-protocols.json" with { type: "json" };
import { validateIndexText } from "../validate.js";
import { chooseVersion } from "../aggregate.js";

const log = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../../log.js", () => ({ createMarketplaceLogger: () => log }));

const context = { sourceId: "ave", official: true };
const check = (document: unknown) => validateIndexText(JSON.stringify(document), context);
const document = () => structuredClone(fixture);
beforeEach(() => vi.clearAllMocks());

describe("catalog host protocol admission", () => {
  it("keeps and offers the current version while diagnosing the foreign authority before validation", () => {
    const result = check(document());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index.packages).toHaveLength(1);
    const entry = result.value.index.packages[0]!;
    expect(entry.versions?.map((version) => version.version)).toEqual(["0.10.3"]);
    expect(result.value.diagnostics).toEqual([{ subject: "plugin/meeting", message: "version 0.10.2: foreign-host-protocol" }]);
    expect(chooseVersion("ave", { ...entry, versions: entry.versions! }, [], {
      appVersion: "0.14.0", platform: "darwin", canaryOptIn: false, installationId: "catalog-test",
    })).toMatchObject({ state: "candidate", version: { version: "0.10.3" } });
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ versionsSkipped: 1, packagesDropped: 0 }, "Catalog foreign-host-protocol versions skipped");
  });

  it("drops packages with no remaining versions and aggregates one counts-only log", () => {
    const input = document();
    input.packages[0]!.versions.shift();
    input.packages[0]!.latest = "0.10.2";
    input.packages.push({ ...structuredClone(input.packages[0]!), name: "calendar", path: "plugins/calendar" });
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { index: { packages: [] } } });
    expect(result.ok && result.value.diagnostics).toEqual([
      { subject: "plugin/meeting", message: "version 0.10.2: foreign-host-protocol" },
      { subject: "plugin/meeting", message: "no versions remain after foreign-host-protocol exclusions" },
      { subject: "plugin/calendar", message: "version 0.10.2: foreign-host-protocol" },
      { subject: "plugin/calendar", message: "no versions remain after foreign-host-protocol exclusions" },
    ]);
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ versionsSkipped: 2, packagesDropped: 2 }, "Catalog foreign-host-protocol versions skipped");
  });

  it.each(["5", undefined, null, 3, "", "unknown"])("strictly validates an invalid authority with protocol %j", (protocol) => {
    const input = document();
    const current = input.packages[0]!.versions[0]!;
    Object.assign(current, { hostProtocol: protocol });
    Object.assign(current.authority, { pluginAccess: input.packages[0]!.versions[1]!.authority.pluginAccess });
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { index: { packages: [] } } });
    expect(result.ok && result.value.diagnostics.some((diagnostic) => diagnostic.message.includes("additional properties"))).toBe(true);
  });

  it("validates a missing declaration instead of taking the authority's foreign protocol", () => {
    const input = document();
    const old = input.packages[0]!.versions[1]!;
    Reflect.deleteProperty(old, "hostProtocol");
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { index: { packages: [] } } });
    expect(result.ok && result.value.diagnostics).toEqual([{ subject: "plugin/meeting", message: expect.stringContaining("additional properties") }]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("admits a schema-valid undeclared version while install compatibility still withholds it", () => {
    const input = document();
    input.packages[0]!.versions.pop();
    const current = input.packages[0]!.versions[0]!;
    Reflect.deleteProperty(current, "hostProtocol");
    Reflect.deleteProperty(current.authority.requires, "hostProtocol");
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { diagnostics: [] } });
    if (!result.ok) return;
    const entry = result.value.index.packages[0]!;
    expect(chooseVersion("ave", { ...entry, versions: entry.versions! }, [], {
      appVersion: "0.14.0", platform: "darwin", canaryOptIn: false, installationId: "catalog-test",
    })).toEqual({ state: "unavailable", reason: "withheld" });
    expect(log.info).not.toHaveBeenCalled();
  });

  it("removes only a latest hint that names an excluded version", () => {
    const input = document();
    input.packages[0]!.versions[0]!.hostProtocol = "6";
    Object.assign(input.packages[0]!.versions[1]!, structuredClone(fixture.packages[0]!.versions[0]!), { version: "0.10.2" });
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { index: { packages: [{ versions: [{ version: "0.10.2" }] }] } } });
    expect(result.ok && result.value.index.packages[0]!.latest).toBeUndefined();
    input.packages[0]!.latest = "9.0.0";
    expect(check(input)).toMatchObject({ ok: true, value: { index: { packages: [] } } });
  });
});
