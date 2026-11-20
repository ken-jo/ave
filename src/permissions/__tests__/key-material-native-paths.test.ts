import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  files: new Map<string, { bytes: Buffer; identity: bigint }>(),
  aliases: new Map<string, string>(),
  opened: [] as string[],
  lookups: [] as string[],
  grants: [] as string[],
  caseSensitive: false,
}));

vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>();
  return { ...actual, ...actual.win32 };
});
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => "C:\\Users\\owner" }));
vi.mock("../../shared/ave-home.js", () => ({ aveHome: () => "C:\\Users\\owner\\.ave" }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const path = await import("node:path");
  const handles = new Map<number, { bytes: Buffer; identity: bigint }>();
  let nextHandle = 1;
  const normalize = (value: unknown): string => path.normalize(String(value)).replace(/^[a-z]:/iu, drive => drive.toUpperCase());
  const storedName = (value: unknown): string | undefined => {
    const candidate = normalize(value);
    if (filesystem.files.has(candidate)) return candidate;
    return filesystem.caseSensitive ? undefined : [...filesystem.files.keys()].find(name => name.toUpperCase() === candidate.toUpperCase());
  };
  const directory = (value: unknown): string | undefined => {
    const candidate = normalize(value);
    if (candidate === "C:\\") return candidate;
    return [...filesystem.files.keys()].map(name => path.dirname(name)).find(name =>
      filesystem.caseSensitive ? name === candidate : name.toUpperCase() === candidate.toUpperCase());
  };
  const aliasTarget = (value: unknown): string | undefined => {
    const candidate = normalize(value);
    const name = filesystem.aliases.has(candidate) ? candidate : filesystem.caseSensitive ? undefined
      : [...filesystem.aliases.keys()].find(name => name.toUpperCase() === candidate.toUpperCase());
    return name === undefined ? undefined : filesystem.aliases.get(name);
  };
  const missing = (): Error => Object.assign(new Error("File does not exist"), { code: "ENOENT" });
  const stat = (file?: { bytes: Buffer; identity: bigint }) => ({
    dev: 1n, ino: file?.identity ?? 0n, size: BigInt(file?.bytes.length ?? 0),
    isFile: () => file !== undefined, isDirectory: () => file === undefined, isSymbolicLink: () => false,
  });
  const realpath = (value: unknown): string => {
    filesystem.lookups.push(String(value));
    const target = aliasTarget(value) ?? value;
    const result = storedName(target) ?? directory(target);
    if (result === undefined) throw missing();
    return result;
  };
  return {
    ...actual,
    existsSync: (value: unknown) => {
      filesystem.lookups.push(String(value));
      return aliasTarget(value) !== undefined || storedName(value) !== undefined || directory(value) !== undefined;
    },
    realpathSync: Object.assign(realpath, { native: realpath }),
    readlinkSync: (value: unknown) => {
      filesystem.lookups.push(String(value));
      const target = aliasTarget(value);
      if (target === undefined) throw missing();
      return target;
    },
    lstatSync: (value: unknown, options?: { throwIfNoEntry?: boolean }) => {
      filesystem.lookups.push(String(value));
      if (aliasTarget(value) !== undefined) return { ...stat(), isDirectory: () => false, isSymbolicLink: () => true };
      const stored = storedName(value);
      if (stored !== undefined) return stat(filesystem.files.get(stored));
      if (directory(value) !== undefined) return stat();
      if (options?.throwIfNoEntry === false) return undefined;
      throw missing();
    },
    readdirSync: (value: unknown) => {
      filesystem.lookups.push(String(value));
      const parent = directory(value);
      if (parent === undefined) throw missing();
      return [...filesystem.files.keys()].filter(name => path.dirname(name) === parent).map(name => path.basename(name));
    },
    openSync: (value: unknown) => {
      filesystem.opened.push(String(value));
      const stored = storedName(value);
      if (stored === undefined) throw missing();
      const handle = nextHandle++;
      const file = filesystem.files.get(stored);
      if (file === undefined) throw missing();
      handles.set(handle, file);
      return handle;
    },
    fstatSync: (handle: number) => stat(handles.get(handle)),
    readSync: (handle: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const file = handles.get(handle);
      if (file === undefined) throw new Error("Inspection handle is missing");
      return file.bytes.copy(buffer, offset, position, position + length);
    },
    closeSync: (handle: number) => { handles.delete(handle); },
  };
});

import { allowKeyMaterialInspection, canonicalizePathForMatch, caseFoldForMatch, createPermissionPathEvidence, createSensitivePathMatcher, isSensitivePath } from "../sensitive-paths.js";
import { ShellFloorContext } from "../rules/shell-floor-policy.js";
import { parseShellFloorCommand, sensitivePathInLiteralArgumentText } from "../rules/shell-exfiltration.js";
import { inspectShellCommand, inspectShellPermissionPaths } from "../rules/literal-shell-inspection.js";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";

const KEY_TEXT = ["-----BEGIN", "PRIVATE KEY-----\nfixture\n-----END", "PRIVATE KEY-----\n"].join(" ");
const nativePlatform = process.platform;
let withdraw: () => void;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  filesystem.files.clear();
  filesystem.aliases.clear();
  filesystem.opened.length = 0;
  filesystem.lookups.length = 0;
  filesystem.grants.length = 0;
  filesystem.caseSensitive = false;
  withdraw = allowKeyMaterialInspection(path => {
    filesystem.grants.push(path);
    return path.startsWith("c:/project/");
  });
});

afterEach(() => {
  withdraw();
  Object.defineProperty(process, "platform", { value: nativePlatform, configurable: true });
});

function store(name: string, content: string): string {
  const path = `C:\\Project\\${name}`;
  filesystem.files.set(path, { bytes: Buffer.from(content), identity: BigInt(filesystem.files.size + 1) });
  return path;
}

describe("native key inspection paths", () => {
  it.each(["Deck.key", "Cert.pem"])("opens the stored native spelling while grants see a folded key: %s", name => {
    const stored = store(name, "certificate\n");
    expect(isSensitivePath(stored, "read")).toBeNull();
    expect(filesystem.opened).toEqual([stored]);
    expect(filesystem.grants).toEqual([`c:/project/${name.toLowerCase()}`]);
  });

  it("opens the resolved native spelling for a case-insensitive operand", () => {
    const stored = store("Cert.pem", "certificate\n");
    expect(isSensitivePath("c:/pRoJeCt/cErT.PEM", "read")).toBeNull();
    expect(filesystem.opened).toEqual([stored]);
    expect(filesystem.grants).toEqual(["c:/project/cert.pem"]);
  });

  it.each([
    ["cafe\u0301.pem", "caf\u00e9.pem"],
    ["\u212a.pem", "K.pem"],
  ])("inspects the exact stored name when normalization also names a sibling: %s", (name, sibling) => {
    const stored = store(name, "certificate\n");
    const secret = store(sibling, KEY_TEXT);
    expect(isSensitivePath(stored, "read")).toBeNull();
    expect(isSensitivePath(secret, "read")).toBe("**/*.pem");
    expect(filesystem.opened).toEqual([stored, secret]);
  });

  it.each([
    ["caf\u00e9.pem", "cafe\u0301.pem"],
    ["\u212a.pem", "K.pem"],
  ])("does not read another normalization for a nonexistent operand: %s", (name, sibling) => {
    store(sibling, "certificate\n");
    expect(isSensitivePath(`C:\\Project\\${name}`, "read")).toBeNull();
    expect(filesystem.opened).toEqual([]);
  });

  it("does not choose a different-case file in a case-sensitive directory", () => {
    filesystem.caseSensitive = true;
    store("caf\u00e9.pem", "certificate\n");
    expect(isSensitivePath("C:\\Project\\Caf\u00e9.pem", "read")).toBeNull();
    expect(filesystem.opened).toEqual([]);
  });
});

describe("native content operands in permission path evidence", () => {
  const evidencePath = (lexical: string) => ({ lexical, canonical: caseFoldForMatch(canonicalizePathForMatch(lexical)), effect: "read" as const });

  it("inspects a native key operand before folding its evidence", () => {
    filesystem.caseSensitive = true;
    const stored = store("Secret.pem", KEY_TEXT);
    const input = evidencePath(stored);
    expect(createPermissionPathEvidence("C:\\Project")(input)).toMatchObject({ ...input, secret: "**/*.pem" });
    expect(filesystem.opened).toEqual([stored]);
  });

  it("keeps distinct normalization siblings out of each other's content observations", () => {
    const certificate = store("caf\u00e9.pem", "certificate\n");
    const secret = store("cafe\u0301.pem", KEY_TEXT);
    const harmless = evidencePath(certificate);
    const sensitive = evidencePath(secret);
    expect(harmless.canonical).toBe(sensitive.canonical);
    const collect = createPermissionPathEvidence("C:\\Project");
    expect(collect(harmless).secret).toBeNull();
    expect(collect(sensitive).secret).toBe("**/*.pem");
    expect(filesystem.opened).toEqual([certificate, secret]);
  });

  it("does not reuse a harmless observation for a different-case native key", () => {
    filesystem.caseSensitive = true;
    const certificate = store("cert.pem", "certificate\n");
    const secret = store("Cert.pem", KEY_TEXT);
    const harmless = evidencePath(certificate);
    const sensitive = evidencePath(secret);
    expect(harmless.canonical).toBe(sensitive.canonical);
    const collect = createPermissionPathEvidence("C:\\Project");
    expect(collect(harmless).secret).toBeNull();
    expect(collect(sensitive).secret).toBe("**/*.pem");
    expect(filesystem.opened).toEqual([certificate, secret]);
  });

  it("inspects the native key target of an operand without a key extension", () => {
    const stored = store("Cafe\u0301.pem", KEY_TEXT);
    const lexical = "C:\\Project\\notes.txt";
    filesystem.aliases.set(lexical, stored);
    const input = evidencePath(lexical);
    expect(createPermissionPathEvidence("C:\\Project")(input)).toMatchObject({ ...input, secret: "**/*.pem" });
    expect(filesystem.opened).toEqual([stored]);
  });

  it("refuses a changed native target before reading or reusing an observation", () => {
    const certificate = store("certificate.pem", "certificate\n");
    const secret = store("secret.pem", KEY_TEXT);
    const lexical = "C:\\Project\\notes.txt";
    filesystem.aliases.set(lexical, certificate);
    const frozen = evidencePath(lexical);
    const collect = createPermissionPathEvidence("C:\\Project");
    expect(collect(frozen).secret).toBeNull();
    filesystem.opened.length = 0;
    filesystem.aliases.set(lexical, secret);
    expect(() => collect(frozen)).toThrow("Permission path identity changed");
    expect(filesystem.opened).toEqual([]);
  });

  it("rechecks bytes and identity when the same native name changes from harmless to a key", () => {
    const stored = store("certificate.pem", "certificate\n");
    const input = evidencePath(stored);
    const collect = createPermissionPathEvidence("C:\\Project");
    expect(collect(input).secret).toBeNull();
    filesystem.files.set(stored, { bytes: Buffer.from(KEY_TEXT), identity: 2n });
    expect(collect(input).secret).toBe("**/*.pem");
    expect(filesystem.opened).toEqual([stored, stored]);
  });

  it("rechecks an alias that changes between normalization siblings sharing its frozen identity", () => {
    const certificate = store("caf\u00e9.pem", "certificate\n");
    const secret = store("cafe\u0301.pem", KEY_TEXT);
    const lexical = "C:\\Project\\notes.txt";
    filesystem.aliases.set(lexical, certificate);
    const input = evidencePath(lexical);
    const collect = createPermissionPathEvidence("C:\\Project");
    expect(collect(input).secret).toBeNull();
    filesystem.aliases.set(lexical, secret);
    expect(evidencePath(lexical).canonical).toBe(input.canonical);
    expect(collect(input).secret).toBe("**/*.pem");
    expect(filesystem.opened).toEqual([certificate, secret]);
  });

  it.each([
    ["caf\u00e9.pem", "cafe\u0301.pem", false, true],
    ["Secret.pem", "secret.pem", true, true],
    ["caf\u00e9.pem", "cafe\u0301.pem", false, false],
    ["Secret.pem", "secret.pem", true, false],
  ])("refuses a sealed native target changed to a same-key sibling: %s (%s, %s, %s)", (original, sibling, caseSensitive, keyInitially) => {
    filesystem.caseSensitive = caseSensitive;
    const sealed = store(original, keyInitially ? KEY_TEXT : "certificate\n");
    const replacement = store(sibling, keyInitially ? "certificate\n" : KEY_TEXT);
    const lexical = "C:\\Project\\notes.txt";
    filesystem.aliases.set(lexical, sealed);
    const input = { ...evidencePath(lexical), runtimePath: sealed };
    const collect = createPermissionPathEvidence("C:\\Project");
    expect(collect(input).secret).toBe(keyInitially ? "**/*.pem" : null);
    filesystem.opened.length = 0;
    filesystem.aliases.set(lexical, replacement);
    expect(evidencePath(lexical).canonical).toBe(input.canonical);
    expect(() => collect(input)).toThrow("Permission path identity changed");
    expect(filesystem.opened).toEqual([]);
  });

  it.each(["pem", "key"])("keeps an opaque %s name conservative without host filesystem lookup", extension => {
    const path = `/logs/result.${extension}`;
    const collect = createPermissionPathEvidence("/work", undefined, { inspectHostFiles: false });
    expect(collect({ lexical: path, canonical: path, effect: "write" })).toMatchObject({ lexical: path, canonical: path, secret: `**/*.${extension}` });
    expect(filesystem.lookups).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });

  it("does not inspect a native field while collecting pure name evidence", () => {
    const input = { lexical: "C:\\Project\\notes.txt", canonical: "c:/project/notes.txt", effect: "read" as const };
    Object.defineProperty(input, "runtimePath", { enumerable: true, get: () => { throw new Error("Native operand is not a matching key"); } });
    expect(createPermissionPathEvidence("C:\\Project")(input).secret).toBeNull();
  });
});

describe("native content operands in shell sensitivity", () => {
  it.each([
    ["cafe\u0301.pem", "caf\u00e9.pem", false],
    ["Secret.pem", "secret.pem", true],
  ])("reads the scanner's native key rather than its folded sibling: %s", (name, sibling, caseSensitive) => {
    filesystem.caseSensitive = caseSensitive;
    const secret = store(name, KEY_TEXT);
    store(sibling, "certificate\n");
    expect(sensitivePathInLiteralArgumentText(secret, "C:\\Project", new ShellFloorContext("bash"))).toBe("**/*.pem");
    expect(filesystem.opened).toEqual([secret]);
  });

  it("keeps a native harmless certificate clear through its extra lexical views", () => {
    const certificate = store("Cafe\u0301.pem", "certificate\n");
    expect(sensitivePathInLiteralArgumentText(certificate, "C:\\Project", new ShellFloorContext("bash"))).toBeNull();
    expect(filesystem.opened.length).toBeGreaterThan(0);
    expect(filesystem.opened.every(path => path === certificate)).toBe(true);
  });

  it("reads the native key behind an alias without a key extension", () => {
    const secret = store("Cafe\u0301.pem", KEY_TEXT);
    const alias = "C:\\Project\\notes.txt";
    filesystem.aliases.set(alias, secret);
    expect(sensitivePathInLiteralArgumentText(alias, "C:\\Project", new ShellFloorContext("bash"))).toBe("**/*.pem");
    expect(filesystem.opened).toEqual([secret]);
  });

  it("refreshes the scanner's content verdict at the same native path", () => {
    const stored = store("certificate.pem", "certificate\n");
    const context = new ShellFloorContext("bash");
    expect(sensitivePathInLiteralArgumentText(stored, "C:\\Project", context)).toBeNull();
    filesystem.opened.length = 0;
    filesystem.files.set(stored, { bytes: Buffer.from(KEY_TEXT), identity: 2n });
    expect(sensitivePathInLiteralArgumentText(stored, "C:\\Project", context)).toBe("**/*.pem");
    expect(filesystem.opened).toEqual([stored]);
  });

  it.each([false, true])("refreshes a repeated parsed command after content changes (nested: %s)", nested => {
    const stored = store("certificate.pem", "certificate\n");
    const operand = stored.replaceAll("\\", "/");
    const command = parseShellFloorCommand(nested ? `bash -c 'cat ${operand}'` : `cat '${operand}'`);
    const context = new ShellFloorContext("bash");
    expect(inspectShellCommand(command, "C:\\Project", context).sensitive).toBeNull();
    filesystem.opened.length = 0;
    filesystem.files.set(stored, { bytes: Buffer.from(KEY_TEXT), identity: 2n });
    expect(inspectShellCommand(command, "C:\\Project", context).sensitive).toBe("**/*.pem");
    expect(filesystem.opened).toEqual([stored]);
  });

  it("keeps name-only key inspection conservative without host lookup", () => {
    const stored = store("certificate.pem", "certificate\n");
    expect(createSensitivePathMatcher("read", undefined, undefined, { inspectKeyMaterial: false })(stored)).toBe("**/*.pem");
    expect(filesystem.lookups).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });

  it("keeps neutral opaque names free of host filesystem lookup", () => {
    const path = "/logs/ordinary.txt";
    expect(createSensitivePathMatcher("read", undefined, undefined, { inspectKeyMaterial: false })(path)).toBeNull();
    expect(inspectShellCommand(`cat ${path}`, "/work", new ShellFloorContext("bash", { inspectHostFiles: false })).sensitive).toBeNull();
    const collect = createPermissionPathEvidence("/work", undefined, { inspectHostFiles: false });
    expect(collect({ lexical: path, canonical: path, effect: "write" }).secret).toBeNull();
    expect(filesystem.lookups).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });

  it.each(["pem", "key"])("collects a guest %s write without resolving its host namesake", extension => {
    const guest = `/logs/result.${extension}`;
    const result = inspectShellPermissionPaths(`printf x > ${guest}`, "C:\\Project", { dialect: "bash", environment: {}, guestPosixPaths: true });
    expect(result.paths).toContainEqual(expect.objectContaining({ lexical: guest, canonical: guest, effect: "write", secret: `**/*.${extension}` }));
    expect(filesystem.lookups.filter(path => path.includes("logs"))).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });

  it.each(["pem", "key"])("resolves a relative guest %s operand against its issued cwd", extension => {
    const result = inspectShellPermissionPaths(`printf x > result.${extension}`, "C:\\Project", { dialect: "bash", environment: {}, guestPosixPaths: true, guestCwd: "/app" });
    expect(result.paths).toContainEqual(expect.objectContaining({ canonical: `/app/result.${extension}`, effect: "write" }));
    expect(filesystem.lookups).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });

  it("keeps a nested guest command-shell target out of the controller namespace", () => {
    const result = inspectShellPermissionPaths("pwsh -NoProfile -Command 'Set-Content result.pem x'", "C:\\Project", { dialect: "bash", environment: {}, guestPosixPaths: true, guestCwd: "/app" });
    expect(result.paths).toContainEqual(expect.objectContaining({ canonical: "/app/result.pem", effect: "write" }));
    expect(filesystem.lookups).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });
});

describe("opaque shell contexts", () => {
  it("keeps canonical, session, location and name helpers free of host lookup", () => {
    const context = new ShellFloorContext("bash", { inspectHostFiles: false });
    context.canonicalize("/c/Project/ordinary.txt");
    expect(context.isSessionReadPath("/c/Project/ordinary.txt")).toBe(false);
    context.locationUnder("/c/Project/ordinary.txt");
    expect(context.matchPath("/c/Project/ordinary.txt")).toBeNull();
    expect(filesystem.lookups).toEqual([]);
  });

  it.each(["pem", "key", "txt"])("keeps top-level shell %s evidence name-only", extension => {
    const result = inspectShellCommand(`cat /c/Project/certificate.${extension}`, "/c/Project", new ShellFloorContext("bash", { inspectHostFiles: false }));
    expect(result.sensitive).toBe(extension === "txt" ? null : `**/*.${extension}`);
    expect(filesystem.lookups).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });

  it.each(["pem", "key", "txt"])("keeps top-level command-shell %s evidence name-only", extension => {
    const result = inspectPowerShellCommand(`Get-Content /c/Project/certificate.${extension}`, "/c/Project", undefined, undefined, new ShellFloorContext("powershell", { inspectHostFiles: false }));
    expect(result.sensitive).toBe(extension === "txt" ? null : `**/*.${extension}`);
    expect(filesystem.lookups).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });

  it.each(["pem", "key", "txt"])("propagates opacity from a shell to a nested command-shell %s scan", extension => {
    const command = `pwsh -NoProfile -Command 'Get-Content /c/Project/certificate.${extension}'`;
    const result = inspectShellCommand(command, "/c/Project", new ShellFloorContext("bash", { inspectHostFiles: false }));
    expect(result.sensitive).toBe(extension === "txt" ? null : `**/*.${extension}`);
    expect(filesystem.lookups).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });

  it.each(["pem", "key", "txt"])("propagates opacity from a command shell to a nested shell %s scan", extension => {
    const command = `bash -c 'cat /c/Project/certificate.${extension}'`;
    const result = inspectPowerShellCommand(command, "/c/Project", undefined, undefined, new ShellFloorContext("powershell", { inspectHostFiles: false }));
    expect(result.sensitive).toBe(extension === "txt" ? null : `**/*.${extension}`);
    expect(filesystem.lookups).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });

  it.each(["pem", "key", "txt"])("propagates opacity through nested command-shell %s scans", extension => {
    const command = `pwsh -NoProfile -Command 'Get-Content /c/Project/certificate.${extension}'`;
    const result = inspectPowerShellCommand(command, "/c/Project", undefined, undefined, new ShellFloorContext("powershell", { inspectHostFiles: false }));
    expect(result.sensitive).toBe(extension === "txt" ? null : `**/*.${extension}`);
    expect(filesystem.lookups).toEqual([]);
    expect(filesystem.opened).toEqual([]);
  });
});
