import { afterEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ home: "/srv/fixtures/habitat" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const overrides = { homedir: () => fixture.home, platform: () => "linux" };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
import { serializeRuntimeAuditData } from "../runtime-audit-json.js";

afterEach(() => {
  fixture.home = "/srv/fixtures/habitat";
  vi.resetModules();
});
describe("bounded runtime audit JSON", () => {
  it.each([0, 497, 498])("preserves a payload that fits the output bound: %i", (length) => {
    const data = "x".repeat(length);
    expect(serializeRuntimeAuditData(data)).toBe(JSON.stringify(data));
  });
  it.each([
    { name: "boundary", data: "x".repeat(499) },
    { name: "path", data: { path: `D:\\fixtures\\${"long-root\\".repeat(60)}output` } },
    { name: "escapes", data: { detail: '"\\\r\n😀'.repeat(150) } },
  ])("encodes overflow as a bounded truncation marker: $name", ({ data }) => {
    const serialized = JSON.stringify(data);
    expect(serialized.length).toBeGreaterThan(500);
    const output = serializeRuntimeAuditData(data) ?? "";
    expect(output.length).toBeLessThanOrEqual(500);
    const marker = JSON.parse(output) as { truncated: boolean; originalLength: number; preview: string };
    expect(marker).toMatchObject({ truncated: true, originalLength: serialized.length });
    expect(marker.preview.length).toBeGreaterThan(0);
    expect(serialized.startsWith(marker.preview)).toBe(true);
    expect(marker.preview).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
  it("preserves an absent payload", () => { expect(serializeRuntimeAuditData(undefined)).toBeUndefined(); });
});

it("redacts literal and encoded homes before measuring the audit output bound", async () => {
  const { homedir } = await import("node:os");
  const home = homedir();
  const payload = { literal: `${home}/literal`, encoded: `${encodeURIComponent(home)}/encoded` };
  const output = serializeRuntimeAuditData(payload) ?? "";
  expect(JSON.parse(output)).toEqual({ literal: "[home]/literal", encoded: "[home-token]" });
  const overflowing = serializeRuntimeAuditData({ ...payload, padding: "x".repeat(600) }) ?? "";
  expect(overflowing.length).toBeLessThanOrEqual(500);
  expect(JSON.parse(overflowing)).toMatchObject({ truncated: true });
  expect(overflowing).not.toContain(home);
  expect(overflowing).not.toContain(encodeURIComponent(home));
});

describe("structural runtime audit redaction", () => {
  it("keeps a home ending in a literal backslash inside valid JSON", async () => {
    fixture.home = "/srv/fixtures/ab" + "\\";
    vi.resetModules();
    const { serializeRuntimeAuditData: serialize } = await import("../runtime-audit-json.js");
    const output = serialize({ p: fixture.home, other: 1 }) ?? "";
    expect(JSON.parse(output)).toEqual({ p: "[home]\\", other: 1 });
  });

  it("redacts normalized string values and object keys without changing their structure", () => {
    const data = {
      [fixture.home]: [fixture.home, { [encodeURIComponent(fixture.home)]: `${fixture.home}/file` }],
      ["__proto__"]: { value: "retained" },
      omitted: undefined,
      missing: [undefined, Number.NaN],
      converted: { toJSON: () => ({ path: fixture.home }) },
    };
    const output = serializeRuntimeAuditData(data) ?? "";
    expect(JSON.parse(output)).toEqual({
      "[home]": ["[home]", { "[home-token]": "[home]/file" }],
      ["__proto__"]: { value: "retained" },
      missing: [null, null],
      converted: { path: "[home]" },
    });
  });

  it("evaluates serialization hooks once before redacting normalized data", () => {
    const toJSON = vi.fn(() => ({ path: fixture.home }));
    const readPath = vi.fn(() => fixture.home);
    const data = { converted: { toJSON }, get path() { return readPath(); } };
    expect(JSON.parse(serializeRuntimeAuditData(data) ?? "")).toEqual({
      converted: { path: "[home]" }, path: "[home]",
    });
    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(readPath).toHaveBeenCalledTimes(1);
  });

  it("omits unsupported top-level values consistently with JSON serialization", () => {
    for (const data of [undefined, Symbol("absent"), () => fixture.home]) {
      expect(serializeRuntimeAuditData(data)).toBeUndefined();
    }
  });

  it("fails closed without exception details when payloads cannot be serialized", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const data of [circular, 1n, { toJSON() { throw new Error(fixture.home); } }, {
      get path() { throw new Error(fixture.home); },
    }]) {
      expect(JSON.parse(serializeRuntimeAuditData(data) ?? "")).toEqual({ unserializable: true });
    }
  });

  it.each(["/srv/fixtures/habitat", "/srv/fixtures/ab" + "\\"])(
    "keeps adversarial strings, arrays and object keys bounded and parseable for %s",
    async (home) => {
      fixture.home = home;
      vi.resetModules();
      const { serializeRuntimeAuditData: serialize } = await import("../runtime-audit-json.js");
      for (const padding of [0, 420, 450, 480, 490, 497, 498, 499, 500, 501, 600]) {
        for (const backslashes of [0, 1, 2, 3, 4, 8, 17]) {
          for (const unicode of ["", "😀", "\ud800", "\udfff", "\ud800x\udfff"]) {
            const detail = `${"x".repeat(padding)}${unicode}${"\\".repeat(backslashes)}"\r\n`;
            const encoded = encodeURIComponent(home);
            const data = { [home]: [home, encoded, { [encoded]: home }], detail };
            const output = serialize(data) ?? "";
            expect(output.length).toBeLessThanOrEqual(500);
            const parsed = JSON.parse(output);
            expect(output).not.toContain(home);
            expect(output).not.toContain(encoded);
            const normalized = JSON.stringify({
              [home.endsWith("\\") ? "[home]\\" : "[home]"]: [
                home.endsWith("\\") ? "[home]\\" : "[home]", "[home-token]",
                { "[home-token]": home.endsWith("\\") ? "[home]\\" : "[home]" },
              ],
              detail,
            });
            if (normalized.length <= 500) {
              expect(output).toBe(normalized);
            } else {
              expect(parsed).toMatchObject({ truncated: true, originalLength: normalized.length });
              expect(normalized.startsWith(parsed.preview)).toBe(true);
              expect(parsed.preview).not.toMatch(/[\uD800-\uDBFF]$/u);
            }
          }
        }
      }
    },
  );

  it.each(["/srv/fixtures/habitat", "/srv/fixtures/ab" + "\\"])(
    "redacts homes before, across and after the output cap for %s",
    async (home) => {
      fixture.home = home;
      vi.resetModules();
      const { serializeRuntimeAuditData: serialize } = await import("../runtime-audit-json.js");
      for (const padding of [450, 478, 479, 480, 489, 497, 498, 499, 500, 501]) {
        const prefix = `${"x".repeat(padding)} `;
        for (const spelling of [home, encodeURIComponent(home)]) {
          for (const suffix of ["", ' /file"\\\r\n😀', " /file\ud800"]) {
            const output = serialize(prefix + spelling + suffix) ?? "";
            const marker = spelling === home ? home.endsWith("\\") ? "[home]\\" : "[home]" : "[home-token]";
            const expected = JSON.stringify(prefix + marker + suffix);
            expect(output.length).toBeLessThanOrEqual(500);
            const parsed = JSON.parse(output);
            expect(output).not.toContain(home);
            expect(output).not.toContain(encodeURIComponent(home));
            if (expected.length <= 500) {
              expect(output).toBe(expected);
            } else {
              expect(parsed).toMatchObject({ truncated: true, originalLength: expected.length });
              expect(parsed.preview.length).toBeGreaterThan(0);
              expect(expected.startsWith(parsed.preview)).toBe(true);
              expect(parsed.preview).not.toMatch(/[\uD800-\uDBFF]$/u);
            }
          }
        }
      }
    },
  );
});

it("retains every value when literal and encoded keys redact to an existing marker", () => {
  const home = fixture.home;
  const output = serializeRuntimeAuditData({
    [home]: { event: 1 },
    [encodeURIComponent(home)]: { event: 2 },
    "[home]": { event: 3 },
    untouched: { event: 4 },
  }) ?? "";
  expect(JSON.parse(output)).toEqual({
    "[home-token]": { event: 2 },
    "[home]#2": { event: 1 },
    "[home]": { event: 3 },
    untouched: { event: 4 },
  });
});

it("assigns stable distinct keys and retains the cap when collision order and value lengths vary", () => {
  const home = fixture.home;
  const encoded = encodeURIComponent(home);
  const entity = home.replaceAll("/", "&#47;");
  for (const padding of [0, 410, 420, 430, 440, 450, 470, 480, 490, 500, 501, 600]) {
    for (const unicode of ["", "😀", "\ud800", "\udfff"]) {
      const detail = `${"x".repeat(padding)}${unicode}"\\\n`;
      const pairs = [
        [home, [home, detail]],
        [encoded, { [home]: encoded }],
        [entity, { [encoded]: `${home}/entity` }],
        ["[home]", { marker: 3 }],
        ["[home]#2", { reserved: 4 }],
      ] as const;
      const expected = [
        ["[home]#3", ["[home]", detail]],
        ["[home-token]", { "[home]": "[home-token]" }],
        ["[home-token]#2", { "[home-token]": "[home]/entity" }],
        ["[home]", { marker: 3 }],
        ["[home]#2", { reserved: 4 }],
      ] as const;
      for (const reverse of [false, true]) {
        const output = serializeRuntimeAuditData(Object.fromEntries(reverse ? [...pairs].reverse() : pairs)) ?? "";
        const normalized = JSON.stringify(Object.fromEntries(reverse ? [...expected].reverse() : expected));
        expect(output.length).toBeLessThanOrEqual(500);
        const parsed = JSON.parse(output);
        expect(output).not.toContain(home);
        expect(output).not.toContain(encoded);
        expect(output).not.toContain(entity);
        if (normalized.length <= 500) {
          expect(output).toBe(normalized);
        } else {
          expect(parsed).toMatchObject({ truncated: true, originalLength: normalized.length });
          expect(normalized.startsWith(parsed.preview)).toBe(true);
          expect(parsed.preview).not.toMatch(/[\uD800-\uDBFF]$/u);
        }
      }
    }
  }
});

it("keeps raw numeric lexemes while redacting another value", () => {
  const { rawJSON } = JSON as typeof JSON & { rawJSON(value: string): object };
  const data = { n: rawJSON("1e400"), int64: rawJSON("9223372036854775807"), path: fixture.home };
  expect(serializeRuntimeAuditData(data)).toBe('{"n":1e400,"int64":9223372036854775807,"path":"[home]"}');
});

it("reads getters once when renaming an object key", () => {
  const read = vi.fn(() => fixture.home);
  const convert = vi.fn(() => encodeURIComponent(fixture.home));
  const data = { get [fixture.home]() { return read(); }, encoded: { toJSON: convert } };
  expect(serializeRuntimeAuditData(data)).toBe('{"[home]":"[home]","encoded":"[home-token]"}');
  expect(read).toHaveBeenCalledTimes(1);
  expect(convert).toHaveBeenCalledTimes(1);
});

it.each(["users", "homepage"])("does not read the getter for unchanged trigger key %s twice", key => {
  let calls = 0;
  const data = { get [key]() { return ++calls; } };
  expect(JSON.parse(serializeRuntimeAuditData(data) ?? "")).toEqual({ [key]: 1 });
  expect(calls).toBe(1);
});

it("keeps the original toJSON key and native getter order across a renamed property", () => {
  const home = fixture.home;
  let state = 0;
  const calls: string[] = [];
  const child = {
    toJSON(key: string) {
      calls.push(key);
      state = 1;
      return key === home;
    },
  };
  const data = {
    [home]: child,
    get flag() {
      calls.push("flag");
      return state;
    },
    ignored: undefined,
    nested: [{ [home]: 3, "[home]": 4 }],
  };
  expect(JSON.parse(serializeRuntimeAuditData(data) ?? "")).toEqual({
    "[home]": true, flag: 1, nested: [{ "[home]#2": 3, "[home]": 4 }],
  });
  expect(calls).toEqual([home, "flag"]);
});

it("rewrites keys ahead of a large string with bounded stack use", async () => {
  const { stringifyHomeRedacted } = await import("../home-path-json.js");
  const later = "x ".repeat(4 * 1024 * 1024);
  const value = { [fixture.home]: 7, later };
  const expected = JSON.stringify({ "[home]": 7, later });
  expect(stringifyHomeRedacted(value)).toBe(expected);
  const bounded = serializeRuntimeAuditData(value) ?? "";
  expect(bounded.length).toBeLessThanOrEqual(500);
  expect(JSON.parse(bounded)).toMatchObject({
    truncated: true, originalLength: expected.length, preview: expect.stringContaining('"[home]":7'),
  });
});

it("fails closed at the runtime audit boundary when native serialization exhausts its stack", async () => {
  const { stringifyHomeRedacted } = await import("../home-path-json.js");
  let value: unknown = fixture.home;
  for (let depth = 0; depth < 25_000; depth++) value = { child: value };
  expect(() => stringifyHomeRedacted(value)).toThrow(RangeError);
  expect(serializeRuntimeAuditData(value)).toBe('{"unserializable":true}');
});

it("propagates application RangeErrors through structured judge arguments", async () => {
  const { redactJudgeRequest } = await import("../../permissions/judge/judge-redaction.js");
  const { judgeInvocation, judgeRequest } = await import("../../permissions/judge/__tests__/judge-request-fixture.js");
  const failure = new RangeError("application serialization error");
  const reject = () => { throw failure; };
  for (const argument of [{ get p() { return reject(); } }, { p: { toJSON: reject } }]) {
    const request = judgeRequest({ invocation: judgeInvocation({ finalInput: { argument } }) });
    let caught: unknown;
    try { redactJudgeRequest(request); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(serializeRuntimeAuditData(argument)).toBe('{"unserializable":true}');
  }
});
