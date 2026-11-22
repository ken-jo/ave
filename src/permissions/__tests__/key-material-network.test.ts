import { afterEach, expect, it, vi } from "vitest";

const probes = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>();
  return { ...actual, ...actual.win32 };
});
vi.mock("../../shared/shell-native-path.js", async original => {
  const actual = await original<typeof import("../../shared/shell-native-path.js")>();
  return { ...actual, isWindowsNetworkOrDevicePath: (path: string) => actual.isWindowsNetworkOrDevicePath(path, "win32") };
});
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const refuse = (path: unknown): never => {
    if (/^[\\/]{2}[^\\/]/u.test(String(path))) probes.calls.push(String(path));
    throw Object.assign(new Error("Filesystem access refused by fixture"), { code: "ENOENT" });
  };
  return { ...actual, lstatSync: refuse, openSync: refuse, readdirSync: refuse, realpathSync: Object.assign(refuse, { native: refuse }) };
});

import { allowKeyMaterialInspection, createSensitivePathMatcher } from "../sensitive-paths.js";

afterEach(() => { probes.calls.length = 0; });

it.each(["//host/share/clé.pem", "//host/share/K.pem", "//./pipe/clé.pem", "//?/UNC/host/share/clé.pem"])(
  "keeps a granted opaque key name off the filesystem: %s", path => {
    const withdraw = allowKeyMaterialInspection(() => true);
    try {
      const match = createSensitivePathMatcher("read", undefined, value => value.normalize("NFC"));
      expect(match(path)).toBe("**/*.pem");
      expect(probes.calls).toEqual([]);
    } finally { withdraw(); }
  },
);
