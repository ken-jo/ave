vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { mkdir, open } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { tmpdir } from "node:os";
import { loadPolicy, savePolicy, getAdminPolicyPath } from "../policy-store.js";
import { isPolicyUserEditable } from "../../shared/policy-editability.js";
import { makeTestPolicy } from "./test-helpers.js";

// Mock fs/promises Intercept readFile / mkdir / open so tests stay in-memory.

type MockFileStore = Record<string, string>;

let USER_PATH: string;
const fixtureDirectories = useTempDirs("user-policy-");
const files: MockFileStore = new Proxy({} as MockFileStore, {
  get(target, key) {
    if (key === USER_PATH) return existsSync(USER_PATH) ? readFileSync(USER_PATH, "utf8") : undefined;
    return target[key as string];
  },
  set(target, key, value: string) {
    if (key === USER_PATH) { mkdirSync(dirname(USER_PATH), { recursive: true }); writeFileSync(USER_PATH, value); }
    target[key as string] = value;
    return true;
  },
  deleteProperty(target, key) {
    if (key === USER_PATH && existsSync(USER_PATH)) unlinkSync(USER_PATH);
    delete target[key as string];
    return true;
  },
});
const readErrors: Record<string, NodeJS.ErrnoException> = {};
const symbolicLinks = new Set<string>();
const directories = new Set<string>();
const { policyErrors } = vi.hoisted(() => ({ policyErrors: vi.fn() }));

vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ error: policyErrors }),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: vi.fn(async () => undefined),
  lstat: vi.fn(async (path: string) => {
    if (files[path] !== undefined || symbolicLinks.has(path) || directories.has(path)) {
      return {
        isSymbolicLink: () => symbolicLinks.has(path),
        isDirectory: () => directories.has(path),
      };
    }
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  }),
  stat: vi.fn(async (path: string) => {
    if (directories.has(path)) return { isDirectory: () => true };
    if (files[path] !== undefined) return { isDirectory: () => false };
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  }),
  readFile: vi.fn(async (path: string) => {
    if (readErrors[path]) throw readErrors[path];
    const content = files[path as string];
    if (content === undefined) {
      const err = Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, data: string) => {
    files[path as string] = data;
  }),
  open: vi.fn(async (path: string, _flags: string, _mode: number) => ({
    writeFile: vi.fn(async (data: string) => {
      files[path] = data;
    }),
    close: vi.fn(async () => undefined),
  })),
}));

const ADMIN_PATH = resolve("/tmp/ave-admin/policy.json");

function writeFile(path: string, obj: object): void {
  files[path] = JSON.stringify(obj, null, 2) + "\n";
}

describe("policy-store", () => {
  const nativePlatform = process.platform;
  afterEach(() => setProcessPlatform(nativePlatform));
  beforeEach(() => {
    // In-memory fixtures cover parsing and precedence; native trust has its own suite.
    setProcessPlatform("linux");
    for (const path of Object.keys(files)) delete files[path];
    USER_PATH = join(fixtureDirectories(), "policy.json");
    for (const path of Object.keys(readErrors)) delete readErrors[path];
    symbolicLinks.clear();
    directories.clear();
    // Missing directories still have an existing filesystem root.
    directories.add(parse(ADMIN_PATH).root);
    vi.clearAllMocks();
  });

  // Original B1 cases (regression — admin-dir absent)

  it("파일 없을 때 lenient default 반환", async () => {
    const policy = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(policy.version).toBe(1);
    expect(policy.requireExplicitApproval).toBe(true);
    expect(policy.managed).toBe(false);
    expect(policy.source).toBe("defaults");
    expect(policy.updatedAt).toBeTruthy();
  });

  it("저장 후 load하면 같은 값", async () => {
    const saved = await savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH);
    expect(saved.requireExplicitApproval).toBe(false);

    const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(loaded.requireExplicitApproval).toBe(false);
    expect(loaded.version).toBe(1);
    expect(loaded.managed).toBe(false);
    expect(loaded.source).toBe("user");
  });

  it("managed: true 박혀있을 때 savePolicy가 throw", async () => {
    writeFile(USER_PATH, makeTestPolicy({ managed: true }));

    await expect(
      savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH),
    ).rejects.toThrow("IT 관리 정책은 사용자가 변경할 수 없습니다.");
  });

  it("managed 플래그는 사용자가 patch로 변경 불가", async () => {
    const saved = await savePolicy(
      // @ts-expect-error — 의도적 타입 위반 테스트
      { requireExplicitApproval: false, managed: true },
      USER_PATH, ADMIN_PATH,
    );
    expect(saved.managed).toBe(false);
  });

  it("동시 2개 save가 serialize — 둘 다 반영됨", async () => {
    const [r1, r2] = await Promise.all([
      savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH),
      savePolicy({ requireExplicitApproval: true },  USER_PATH, ADMIN_PATH),
    ]);

    expect(r1.version).toBe(1);
    expect(r2.version).toBe(1);

    const final = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(final.requireExplicitApproval).toBe(true);
  });

  it("admin-dir 없음 → user만 사용, source: 'user'", async () => {
    writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: false }));

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("user");
    expect(result.requireExplicitApproval).toBe(false);
    expect(result.adminPath).toBeUndefined();
  });

  it("admin-dir 존재 + user 존재 → merged, admin 값 우선", async () => {
    writeFile(USER_PATH,  makeTestPolicy({ requireExplicitApproval: false, managed: false }));
    writeFile(ADMIN_PATH, makeTestPolicy({ requireExplicitApproval: true,  managed: true  }));

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("merged");
    expect(result.requireExplicitApproval).toBe(true);   // admin wins
    expect(result.managed).toBe(true);                   // admin wins
    expect(result.adminPath).toBe(ADMIN_PATH);
    expect(result.adminOverrides).toContain("requireExplicitApproval");
    expect(result.adminOverrides).toContain("managed");
  });

  it("admin managed:true + user managed:false → 최종 managed:true", async () => {
    writeFile(USER_PATH,  makeTestPolicy({ managed: false }));
    writeFile(ADMIN_PATH, makeTestPolicy({ managed: true  }));

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.managed).toBe(true);
    expect(result.source).toBe("merged");
  });

  it("admin-dir만 존재(user 없음) → source: 'admin'", async () => {
    writeFile(ADMIN_PATH, makeTestPolicy({ requireExplicitApproval: false, managed: true }));

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("admin");
    expect(result.managed).toBe(true);
    expect(result.requireExplicitApproval).toBe(false);
    expect(result.adminPath).toBe(ADMIN_PATH);
  });

  it("admin-dir 존재 시 savePolicy throw (admin-dir file exists)", async () => {
    writeFile(ADMIN_PATH, makeTestPolicy({ managed: true }));

    await expect(
      savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH),
    ).rejects.toThrow("Policy is managed by IT (admin-dir file exists)");
  });

  it("invalid admin JSON keeps explicit approval on and locks edits", async () => {
    writeFile(USER_PATH,  makeTestPolicy({ requireExplicitApproval: false }));
    // 잘못된 JSON
    files[ADMIN_PATH] = "not-valid-json";

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("merged");
    expect(result.requireExplicitApproval).toBe(true);
    expect(result.managed).toBe(true);
    expect(isPolicyUserEditable(result)).toBe(false);
  });

  it("an unsupported admin version keeps explicit approval on and locks edits", async () => {
    writeFile(USER_PATH,  makeTestPolicy({ requireExplicitApproval: false }));
    writeFile(ADMIN_PATH, { version: 2, requireExplicitApproval: true, managed: true, updatedAt: new Date().toISOString() });

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("merged");
    expect(result.requireExplicitApproval).toBe(true);
    expect(result.managed).toBe(true);
    expect(isPolicyUserEditable(result)).toBe(false);
  });

  // Fail closed: a file that leaves out or mistypes a safety field

  // A managed policy.json written for another section (the marketplace policy example carries version 1 and `marketplaces` only).
  const MARKETPLACE_ONLY = {
    version: 1,
    marketplaces: { additional: [{ id: "corp", url: "https://git.corp.example/ave/marketplace.git" }] },
  };

  it("admin file without requireExplicitApproval → explicit approval stays on", async () => {
    writeFile(ADMIN_PATH, MARKETPLACE_ONLY);

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("admin");
    expect(result.requireExplicitApproval).toBe(true);
    expect(result.managed).toBe(false);
    expect(typeof result.updatedAt).toBe("string");
    expect(isPolicyUserEditable(result)).toBe(false);
  });

  it("user file without requireExplicitApproval → explicit approval stays on", async () => {
    writeFile(USER_PATH, { version: 1, managed: false, updatedAt: "2026-10-12T00:00:00.000Z" });

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("user");
    expect(result.requireExplicitApproval).toBe(true);
    // A save from that file keeps it on too.
    const saved = await savePolicy({}, USER_PATH, ADMIN_PATH);
    expect(saved.requireExplicitApproval).toBe(true);
  });

  it("a safety field of the wrong type reads as its safe value", async () => {
    writeFile(ADMIN_PATH, { version: 1, requireExplicitApproval: "false", managed: "no" });
    const admin = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(admin.requireExplicitApproval).toBe(true);
    expect(admin.managed).toBe(true);

    delete files[ADMIN_PATH];
    writeFile(USER_PATH, { version: 1, requireExplicitApproval: 0, managed: "false", updatedAt: "2026-10-12T00:00:00.000Z" });
    const user = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(user.requireExplicitApproval).toBe(true);
    expect(user.managed).toBe(true);
    expect(isPolicyUserEditable(user)).toBe(false);
    await expect(savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH)).rejects.toThrow();
  });

  it("merged: an admin file that does not state the field keeps the user's choice; a mistyped one forces it on", async () => {
    writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: false }));
    writeFile(ADMIN_PATH, MARKETPLACE_ONLY);
    const silent = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(silent.source).toBe("merged");
    expect(silent.requireExplicitApproval).toBe(false);
    expect(silent.adminOverrides).toEqual([]);
    expect(typeof silent.updatedAt).toBe("string");

    writeFile(ADMIN_PATH, { ...MARKETPLACE_ONLY, requireExplicitApproval: "yes" });
    const mistyped = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(mistyped.requireExplicitApproval).toBe(true);
    expect(mistyped.adminOverrides).toContain("requireExplicitApproval");
  });

  it("only the permission fields leave the file: other sections are not returned", async () => {
    writeFile(ADMIN_PATH, { ...MARKETPLACE_ONLY, requireExplicitApproval: true, managed: true, updatedAt: "2026-10-12T00:00:00.000Z" });

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(Object.keys(result).sort()).toEqual(["adminPath", "managed", "requireExplicitApproval", "source", "updatedAt", "version"]);
  });

  it("a non-object admin policy keeps explicit approval on and locks edits", async () => {
    writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: false }));
    files[ADMIN_PATH] = "[1]\n";

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("merged");
    expect(result.requireExplicitApproval).toBe(true);
    expect(result.managed).toBe(true);
    expect(isPolicyUserEditable(result)).toBe(false);
  });

  it.each([false, true])("a missing admin policy permits user edits (directory exists: %s)", async (directoryExists) => {
    if (directoryExists) directories.add(dirname(ADMIN_PATH));
    writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: false }));

    const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);

    expect(loaded.source).toBe("user");
    expect(loaded.managed).toBe(false);
    expect(loaded.requireExplicitApproval).toBe(false);
    expect(isPolicyUserEditable(loaded)).toBe(true);
    await expect(savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH))
      .resolves.toMatchObject({ managed: false, requireExplicitApproval: false });
    expect(policyErrors).not.toHaveBeenCalled();
  });

  it.each(["file", "dangling link"])("an admin policy below a %s ancestor stays managed after ENOENT", async (kind) => {
    const parent = dirname(ADMIN_PATH);
    if (kind === "file") files[parent] = "not a directory";
    else symbolicLinks.add(parent);
    writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: false }));

    const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);

    expect(loaded.source).toBe("merged");
    expect(loaded.managed).toBe(true);
    expect(loaded.requireExplicitApproval).toBe(true);
    expect(isPolicyUserEditable(loaded)).toBe(false);
    await expect(savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH))
      .rejects.toThrow("Policy is managed by IT (admin-dir file exists)");
    expect(mkdir).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("a dangling admin symlink requires explicit approval and locks edits", async () => {
    writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: false }));
    symbolicLinks.add(ADMIN_PATH);

    const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);

    expect(loaded.requireExplicitApproval).toBe(true);
    expect(loaded.managed).toBe(true);
    expect(loaded.source).toBe("merged");
    expect(isPolicyUserEditable(loaded)).toBe(false);
  });

  it("a dangling admin symlink rejects saves before opening user state", async () => {
    symbolicLinks.add(ADMIN_PATH);

    await expect(savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH)).rejects.toThrow();
    expect(mkdir).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(files[USER_PATH]).toBeUndefined();
  });

  describe("invalid administrative policy", () => {
    it("surfaces an empty policy reason without exposing policy contents", async () => {
      files[ADMIN_PATH] = "";
      const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);
      expect(loaded).toMatchObject({ adminStatus: "invalid", managed: true, requireExplicitApproval: true });
      expect(loaded.adminReason).toBe(`invalid policy file at ${ADMIN_PATH}: empty file; not valid JSON`);
    });

    it("surfaces a sanitized parse failure for malformed policy", async () => {
      files[ADMIN_PATH] = "PRIVATE_POLICY_CONTENT";
      const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);
      expect(loaded.adminStatus).toBe("invalid");
      expect(loaded.adminReason).toBe(`invalid policy file at ${ADMIN_PATH}: not valid JSON`);
    });
    const invalidCases: Array<{ label: string; contents: string; readCode?: string }> = [
      { label: "unreadable file", contents: '{"version":1}', readCode: "EACCES" },
      { label: "denied read", contents: '{"version":1}', readCode: "EPERM" },
      { label: "non-directory path", contents: '{"version":1}', readCode: "ENOTDIR" },
      { label: "invalid JSON", contents: "RAW_POLICY_SECRET" },
      { label: "array", contents: "[]" },
      { label: "null", contents: "null" },
      { label: "string", contents: '"RAW_POLICY_SECRET"' },
      { label: "boolean", contents: "false" },
      { label: "unsupported version", contents: '{"version":2}' },
      { label: "mistyped version", contents: '{"version":"RAW_POLICY_SECRET"}' },
      { label: "missing version", contents: "{}" },
    ];

    function seedAdminPolicy(policyCase: (typeof invalidCases)[number]): void {
      files[ADMIN_PATH] = policyCase.contents;
      if (policyCase.readCode) {
        readErrors[ADMIN_PATH] = Object.assign(new Error("RAW_POLICY_SECRET"), { code: policyCase.readCode });
      }
    }

    for (const userFilePresent of [false, true]) {
      describe(userFilePresent ? "with a permissive user policy" : "without a user policy", () => {
        it.each(invalidCases)("$label requires explicit approval and locks edits", async (policyCase) => {
          if (userFilePresent) writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: false }));
          seedAdminPolicy(policyCase);

          const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);

          expect(loaded.requireExplicitApproval).toBe(true);
          expect(loaded.managed).toBe(true);
          expect(loaded.source).toBe(userFilePresent ? "merged" : "admin");
          expect(loaded.adminPath).toBe(ADMIN_PATH);
          expect(isPolicyUserEditable(loaded)).toBe(false);
        });

        it.each(invalidCases)("$label rejects saves before creating or opening user state", async (policyCase) => {
          if (userFilePresent) writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: false }));
          seedAdminPolicy(policyCase);
          const originalUserFile = files[USER_PATH];

          await expect(savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH))
            .rejects.toThrow("Policy is managed by IT (admin-dir file exists)");

          expect(mkdir).not.toHaveBeenCalled();
          expect(open).not.toHaveBeenCalled();
          expect(files[USER_PATH]).toBe(originalUserFile);
        });
      });
    }

    it.each([
      { label: "parser failure", contents: "RAW_POLICY_SECRET", reason: "not valid JSON" },
      { label: "version mismatch", contents: '{"version":"RAW_POLICY_SECRET"}', reason: "version mismatch" },
      { label: "read failure", contents: '{"version":1}', readCode: "EACCES", reason: "EACCES" },
    ])("logs the $label reason without policy contents or exception text", async (policyCase) => {
      seedAdminPolicy(policyCase);

      await loadPolicy(USER_PATH, ADMIN_PATH);
      await expect(savePolicy({}, USER_PATH, ADMIN_PATH)).rejects.toThrow();

      expect(policyErrors).toHaveBeenCalledTimes(2);
      const messages = policyErrors.mock.calls.flat().join(" ");
      expect(messages).toContain(ADMIN_PATH);
      expect(messages).toContain(policyCase.reason);
      expect(messages).not.toContain("RAW_POLICY_SECRET");
    });
  });

  it("an invalid user policy keeps its existing fallback when the admin policy is absent", async () => {
    files[USER_PATH] = "not-valid-json";

    const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(loaded.source).toBe("defaults");
    expect(loaded.managed).toBe(false);
    expect(isPolicyUserEditable(loaded)).toBe(true);

    const saved = await savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH);
    expect(saved.requireExplicitApproval).toBe(false);
  });

  it("a managed admin policy that leaves approval unstated preserves an explicit user false", async () => {
    writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: false }));
    writeFile(ADMIN_PATH, { ...MARKETPLACE_ONLY, managed: true });

    const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(loaded.requireExplicitApproval).toBe(false);
    expect(loaded.managed).toBe(true);
    expect(isPolicyUserEditable(loaded)).toBe(false);
    await expect(savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH)).rejects.toThrow();
  });

  it("an explicit admin false takes precedence over an explicit user true", async () => {
    writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: true }));
    writeFile(ADMIN_PATH, makeTestPolicy({ requireExplicitApproval: false, managed: true }));

    const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(loaded.requireExplicitApproval).toBe(false);
    expect(loaded.adminOverrides).toContain("requireExplicitApproval");
  });

  // Read/write agreement — "is this policy user-editable?" The read side (Permissions tab) and the write side (savePolicy) must never disagree. Rather than asserting a hand-written expectation table, each row below runs BOTH real functions against the same on-disk state and requires `savePolicy rejects <=> !isPolicyUserEditable(loadPolicy(...))`. A new blocking condition added to savePolicy alone turns this red.

  describe("isPolicyUserEditable agrees with savePolicy", () => {
    const cases: Array<[string, () => void]> = [
      ["no files at all", () => {}],
      ["user only, managed:false", () => {
        writeFile(USER_PATH, makeTestPolicy({ managed: false }));
      }],
      ["user only, managed:true", () => {
        writeFile(USER_PATH, makeTestPolicy({ managed: true }));
      }],
      ["admin only, managed:true", () => {
        writeFile(ADMIN_PATH, makeTestPolicy({ managed: true }));
      }],
      // The case the `managed`-flag-only read side got wrong: an admin-dir policy that pins requireExplicitApproval without claiming `managed`.
      ["admin only, managed omitted", () => {
        const { managed: _managed, ...rest } = makeTestPolicy({ requireExplicitApproval: true });
        writeFile(ADMIN_PATH, rest);
      }],
      ["admin + user, neither managed", () => {
        writeFile(USER_PATH,  makeTestPolicy({ managed: false, requireExplicitApproval: false }));
        writeFile(ADMIN_PATH, makeTestPolicy({ managed: false, requireExplicitApproval: true }));
      }],
      ["admin + user, admin managed:true", () => {
        writeFile(USER_PATH,  makeTestPolicy({ managed: false }));
        writeFile(ADMIN_PATH, makeTestPolicy({ managed: true }));
      }],
      // Invalid admin files retain the edit lock.
      ["invalid admin JSON + user managed:false", () => {
        writeFile(USER_PATH, makeTestPolicy({ managed: false }));
        files[ADMIN_PATH] = "not-valid-json";
      }],
      ["invalid admin JSON + user managed:true", () => {
        writeFile(USER_PATH, makeTestPolicy({ managed: true }));
        files[ADMIN_PATH] = "not-valid-json";
      }],
    ];

    for (const [label, seed] of cases) {
      it(`${label}`, async () => {
        seed();
        const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);
        const editable = isPolicyUserEditable(loaded);

        let saveRejected = false;
        try {
          await savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH);
        } catch {
          saveRejected = true;
        }

        expect(saveRejected).toBe(!editable);
      });
    }

    it("at least one case is editable and one is not (the matrix can fail)", async () => {
      writeFile(ADMIN_PATH, makeTestPolicy({ managed: true }));
      expect(isPolicyUserEditable(await loadPolicy(USER_PATH, ADMIN_PATH))).toBe(false);
      delete files[ADMIN_PATH];
      writeFile(USER_PATH, makeTestPolicy({ managed: false }));
      expect(isPolicyUserEditable(await loadPolicy(USER_PATH, ADMIN_PATH))).toBe(true);
    });
  });

  describe("getAdminPolicyPath — 플랫폼별 경로", () => {
    const platforms: Array<[string, string]> = [
      ["darwin",  "/Library/Application Support/Ave/policy.json"],
      ["linux",   "/etc/ave/policy.json"],
    ];

    for (const [platform, expected] of platforms) {
      it(`${platform} → ${expected}`, () => {
        const original = process.platform;
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        try {
          expect(getAdminPolicyPath()).toBe(expected);
        } finally {
          Object.defineProperty(process, "platform", { value: original, configurable: true });
        }
      });
    }

    it("win32 → ProgramData/Ave/policy.json", () => {
      const original = process.platform;
      const origPD = process.env.ProgramData;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      process.env.ProgramData = join(tmpdir(), "ProgramData");
      try {
        const p = getAdminPolicyPath();
        expect(p).toContain("Ave");
        expect(p).toContain("policy.json");
        expect(p).toContain("ProgramData");
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
        if (origPD === undefined) delete process.env.ProgramData;
        else process.env.ProgramData = origPD;
      }
    });
  });
});
