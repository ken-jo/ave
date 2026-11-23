import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const SWITCH = "NoDefaultCurrentDirectoryInExePath";
const platform = process.platform;
let saved: string | undefined;

beforeEach(() => {
  vi.resetModules();
  saved = process.env[SWITCH];
  delete process.env[SWITCH];
});
afterEach(() => {
  setProcessPlatform(platform);
  if (saved === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = saved;
});

it("on Windows the host looks a bare program name up on PATH alone, and every process it starts inherits that", async () => {
  setProcessPlatform("win32");
  await import("../windows-program-lookup.js");
  expect(process.env[SWITCH]).toBe("1");
});

it("elsewhere the environment is left as it is", async () => {
  setProcessPlatform("linux");
  await import("../windows-program-lookup.js");
  expect(process.env[SWITCH]).toBeUndefined();
});

it.each(["../../main.ts", "../../headless-host.ts"])("%s sets it before any other module loads", (entry) => {
  const text = readFileSync(new URL(entry, import.meta.url), "utf8");
  expect(text.split("\n").find(line => line.startsWith("import "))).toBe('import "./main/windows-program-lookup.js";');
});
