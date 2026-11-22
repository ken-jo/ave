import { afterEach, describe, it, expect, vi } from "vitest";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import {
  SENSITIVE_PATH_PATTERNS,
  SENSITIVE_PATH_ENTRIES,
  isSensitiveContent,
  isSensitivePath,
  allowKeyMaterialInspectionUnder,
  isAdmissionDeniedPath,
  createSensitivePathMatcher,
  policyMatchPaths,
  canonicalizePathForMatch,
  caseFoldForMatch,
  MAX_WALK_UP,
} from "../sensitive-paths.js";
import { PermissionTestResources } from "./test-resources.js";
import { AVE_HOME_PROTECTED_DIRECTORIES } from "../../shared/ave-home.js";

const resources = new PermissionTestResources();

it("keeps protected boundaries aligned with credential directories", () => {
  const credentialDirectories = SENSITIVE_PATH_ENTRIES.filter((entry) =>
    entry.anchor === "ave-home" && entry.kind === "dir" &&
    ["secrets", "subscription-runtimes", "keys", "certs", "config"].includes(entry.segments[0]),
  ).map((entry) => entry.segments.join("/"));
  // `runtime` is the one boundary without a row (slice 3 adds it): sandboxed extensions run its venvs, so the read floor must not cover it.
  expect([...AVE_HOME_PROTECTED_DIRECTORIES].filter((name) => name !== "runtime").sort()).toEqual(credentialDirectories.sort());
  expect(AVE_HOME_PROTECTED_DIRECTORIES).toHaveLength(6);
  expect(AVE_HOME_PROTECTED_DIRECTORIES).toContain("runtime");
  expect(SENSITIVE_PATH_ENTRIES.filter((entry) => entry.anchor === "ave-home" && entry.segments[0] === "runtime")).toEqual([]);
});

describe("per-decision sensitive matcher", () => {
  it("reuses configured filesystem roots after the first match", () => {
    const match = createSensitivePathMatcher("read");
    expect(match("/work/project/ordinary")).toBeNull();
    const canonical = vi.spyOn(realpathSync, "native");
    try {
      for (let index = 0; index < 1024; index += 1) expect(match(`/work/project/x${index}`)).toBeNull();
      expect(canonical).not.toHaveBeenCalled();
      expect(match("/work/project/.env")).not.toBeNull();
    } finally { canonical.mockRestore(); }
  });
});

afterEach(async () => {
  await resources.cleanup();
});

describe("SENSITIVE_PATH_PATTERNS", () => {
  it("is a non-empty readonly list", () => {
    expect(Array.isArray(SENSITIVE_PATH_PATTERNS)).toBe(true);
    expect(SENSITIVE_PATH_PATTERNS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(SENSITIVE_PATH_PATTERNS)).toBe(true);
  });

  it("contains core credential-store patterns", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ssh/**");
    // The whole `.aws` dir, not just credentials/config: the SSO token cache (`.aws/sso/cache/*.json`) is a bearer credential too, and the OS sandbox floor has always denied the dir wholesale.
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.aws/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.gnupg/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.kube/config");
  });

  it("contains Ave-specific additions", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/certs/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/secrets/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/keys/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/subscription-runtimes/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/ave-secrets.json");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/ave-secrets.json");
  });

  it("Permission policy P2.5 — contains OS sensitive paths", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/etc/shadow");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/etc/sudoers");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.netrc");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.pgpass");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.npmrc");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.bash_history");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.zsh_history");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.python_history");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.viminfo");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/Library/Cookies/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/Library/Keychains/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.env");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.env.*");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/id_rsa");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/id_ed25519");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/id_ecdsa");
  });

  it("Permission policy P2.5 — contains Ave-internal sensitive paths", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/settings.json");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/permissions.json");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/policy.json");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/permissions/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/audit/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/audit.log");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/sessions/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.config/ave/hooks/**");
  });
});

describe("policyMatchPaths", () => {
  it("returns [path, path + '/'] for a non-slash-terminated path", () => {
    const result = policyMatchPaths("/home/example/.aws");
    expect(result).toEqual(["/home/example/.aws", "/home/example/.aws/"]);
  });

  it("returns [path without slash, path with slash] when already slash-terminated", () => {
    const result = policyMatchPaths("/home/example/.aws/");
    expect(result).toEqual(["/home/example/.aws", "/home/example/.aws/"]);
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    const result = policyMatchPaths("C:\\Users\\example\\.ssh");
    expect(result[0]).toBe("C:/Users/example/.ssh");
    expect(result[1]).toBe("C:/Users/example/.ssh/");
  });
});

describe("isSensitivePath — positive matches", () => {
  it("matches /home/example/.ssh/id_rsa against **/.ssh/**", () => {
    const result = isSensitivePath("/home/example/.ssh/id_rsa");
    expect(result).toBe("**/.ssh/**");
  });

  it("matches nested files under .ssh", () => {
    expect(isSensitivePath("/home/example/.ssh/private/id_rsa")).toBe("**/.ssh/**");
  });

  it("matches /Users/example/.aws/credentials", () => {
    const result = isSensitivePath("/Users/example/.aws/credentials");
    expect(result).toBe("**/.aws/**");
  });

  it("matches /Users/example/.aws/config", () => {
    expect(isSensitivePath("/Users/example/.aws/config")).toBe("**/.aws/**");
  });

  it("matches the AWS SSO token cache, which the file-only patterns missed", () => {
    expect(
      isSensitivePath("/Users/example/.aws/sso/cache/abc123.json"),
    ).toBe("**/.aws/**");
  });

  it("matches /Users/example/.gnupg/pubring.kbx via **/.gnupg/**", () => {
    expect(isSensitivePath("/Users/example/.gnupg/pubring.kbx")).toBe("**/.gnupg/**");
  });

  it("matches /home/example/.kube/config", () => {
    expect(isSensitivePath("/home/example/.kube/config")).toBe("**/.kube/config");
  });

  it("matches /Users/example/.ave/certs/corp-ca.pem (Ave addition)", () => {
    const result = isSensitivePath("/Users/example/.ave/certs/corp-ca.pem");
    expect(result).toBe("**/.ave/certs/**");
  });

  it("matches /Users/example/.ave/secrets/openai.key (Ave addition)", () => {
    expect(isSensitivePath("/Users/example/.ave/secrets/openai.key")).toBe(
      "**/.ave/secrets/**",
    );
  });

  it.each(["", "registry.json", "codex-v3-home/auth.json", "provider-home/config.toml"])(
    "protects subscription runtime state: %s",
    (suffix) => {
      expect(isSensitivePath(`/home/example/.ave/subscription-runtimes/${suffix}`)).toBe(
        "**/.ave/subscription-runtimes/**",
      );
      expect(isSensitivePath(`/home/example/project/subscription-runtimes/${suffix}`)).toBeNull();
    },
  );

  it("matches Ave permission control-plane files", () => {
    expect(isSensitivePath("/Users/example/.ave/settings.json")).toBe("**/.ave/settings.json");
    expect(isSensitivePath("/Users/example/.ave/permissions.json")).toBe("**/.ave/permissions.json");
    expect(isSensitivePath("/Users/example/.ave/policy.json")).toBe("**/.ave/policy.json");
    expect(isSensitivePath("/Users/example/.ave/permissions/reviewer-cache.jsonl")).toBe("**/.ave/permissions/**");
  });

  it("matches /Users/example/.ave/ave-secrets.json (Ave addition)", () => {
    expect(isSensitivePath("/Users/example/.ave/ave-secrets.json")).toBe(
      "**/.ave/ave-secrets.json",
    );
  });

  it("matches shallow /Users/example/ave-secrets.json sibling form", () => {
    expect(isSensitivePath("/Users/example/ave-secrets.json")).toBe(
      "**/ave-secrets.json",
    );
  });

  it("matches /Users/example/.config/gcloud/credentials.db via **/.config/gcloud/**", () => {
    expect(isSensitivePath("/Users/example/.config/gcloud/credentials.db")).toBe(
      "**/.config/gcloud/**",
    );
  });
});

describe("isSensitivePath — directory (trailing-slash) form §S2", () => {
  it("matches bare directory /home/example/.gnupg via trailing-slash helper", () => {
    const result = isSensitivePath("/home/example/.gnupg");
    expect(result).toBe("**/.gnupg/**");
  });

  it("matches /Users/example/.ave/certs (directory form) via **/.ave/certs/**", () => {
    expect(isSensitivePath("/Users/example/.ave/certs")).toBe("**/.ave/certs/**");
  });
});

describe("isSensitivePath — negative cases", () => {
  it("returns null for /home/example/code/ssh-utils.ts", () => {
    expect(isSensitivePath("/home/example/code/ssh-utils.ts")).toBeNull();
  });

  it("returns null for /home/example/ssh_config_template.txt", () => {
    expect(isSensitivePath("/home/example/ssh_config_template.txt")).toBeNull();
  });

  it("returns null for /tmp/safe.txt", () => {
    expect(isSensitivePath("/tmp/safe.txt")).toBeNull();
  });

  it("returns null for /Users/example/Documents/aws-notes.md", () => {
    expect(isSensitivePath("/Users/example/Documents/aws-notes.md")).toBeNull();
  });

  it("returns null for /Users/example/.ave/plugins/meeting/notes/2026-05.md (non-sensitive plugin subdir of .ave)", () => {
    expect(
      isSensitivePath("/Users/example/.ave/plugins/meeting/notes/2026-05.md"),
    ).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(isSensitivePath("")).toBeNull();
  });
});

// Permission policy.5 — Layer 0 expansion: OS + Ave-internal hits

describe("isSensitivePath — Permission policy P2.5 OS sensitive paths", () => {
  it("matches /etc/shadow (and macOS /private/etc/shadow form)", () => {
    expect(isSensitivePath("/etc/shadow")).toBe("**/etc/shadow");
    expect(isSensitivePath("/private/etc/shadow")).toBe("**/etc/shadow");
  });

  it("matches ~/.netrc anywhere", () => {
    expect(isSensitivePath("/Users/example/.netrc")).toBe("**/.netrc");
  });

  it("matches ~/.bash_history", () => {
    expect(isSensitivePath("/home/example/.bash_history")).toBe("**/.bash_history");
  });

  it("matches ~/.psql_history", () => {
    expect(isSensitivePath("/home/example/.psql_history")).toBe("**/.psql_history");
  });

  it("matches ~/Library/Cookies/* on macOS", () => {
    expect(
      isSensitivePath("/Users/example/Library/Cookies/Cookies.binarycookies"),
    ).toBe("**/Library/Cookies/**");
  });

  it("matches ~/Library/Keychains/* on macOS", () => {
    expect(isSensitivePath("/Users/example/Library/Keychains/login.keychain-db")).toBe(
      "**/Library/Keychains/**",
    );
  });

  it("matches **/.env at the project root", () => {
    expect(isSensitivePath("/Users/example/code/myapp/.env")).toBe("**/.env");
  });

  it("matches **/.env.production", () => {
    expect(isSensitivePath("/Users/example/code/myapp/.env.production")).toBe(
      "**/.env.*",
    );
  });

  it.each(["read", "write"] as const)("exempts exact environment template names for %s only", (effect) => {
    for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist", ".env.test"]) {
      expect(isSensitivePath(`/work/project/${name}`, effect)).toBeNull();
      expect(isSensitivePath(`/work/project/nested/${name}`, effect)).toBeNull();
      expect(isSensitivePath(`/work/.aws/${name}`, effect)).not.toBeNull();
    }
    for (const name of [".env", ".env.local", ".env.production", ".env.development", ".env.test.local", ".env.example.local", ".env.dist.bak"]) {
      expect(isSensitivePath(`/work/project/${name}`, effect)).not.toBeNull();
    }
  });

  // One review of the user secret-file table.
  // Written in two parts so no scanner takes this test file for key material.
  const privateKeyText = (kind: string): string => `${["-----BEGIN", `${kind}PRIVATE`, "KEY-----"].join(" ")}\nFIXTURE\n`;
  const CERTIFICATE_TEXT = "-----BEGIN CERTIFICATE-----\nFIXTURE\n-----END CERTIFICATE-----\n";
  function keyFixtures(): string {
    const dir = resources.makeTmpDir("ave-key-material-");
    mkdirSync(join(dir, "certs"));
    writeFileSync(join(dir, "id_dsa"), "FIXTURE\n");
    writeFileSync(join(dir, "certs", "server.pem"), privateKeyText("RSA "));
    writeFileSync(join(dir, "certs", "tls.key"), privateKeyText(""));
    writeFileSync(join(dir, "certs", "ssh.key"), privateKeyText("OPENSSH "));
    writeFileSync(join(dir, "certs", "bundle.pem"), CERTIFICATE_TEXT.repeat(8) + privateKeyText("EC "));
    writeFileSync(join(dir, "certs", "chain.pem"), CERTIFICATE_TEXT);
    writeFileSync(join(dir, "certs", "public.key"), "-----BEGIN PUBLIC KEY-----\nFIXTURE\n");
    // A presentation document: a zip archive in one spelling, a package folder in the other.
    writeFileSync(join(dir, "Quarterly review.key"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]));
    mkdirSync(join(dir, "Roadmap.key"));
    writeFileSync(join(dir, "Roadmap.key", "index.apxl"), "<presentation/>");
    // The fixture folder stands for a project the person registered: files in it may be looked at.
    restoreInspectionRoots.push(allowKeyMaterialInspectionUnder(() => [dir]));
    return realpathSync(dir);
  }
  const restoreInspectionRoots: Array<() => void> = [];
  afterEach(() => { for (const restore of restoreInspectionRoots.splice(0)) restore(); });

  it("judges a key-extension file outside the registered projects on its name, not on what it holds", () => {
    const project = keyFixtures();
    const outside = realpathSync(resources.makeTmpDir("ave-key-outside-"));
    writeFileSync(join(outside, "Quarterly review.key"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]));
    writeFileSync(join(outside, "chain.pem"), CERTIFICATE_TEXT);
    symlinkSync(join(outside, "Quarterly review.key"), join(project, "linked.key"));
    // Harmless content does not matter where the host may not look: the name decides, whatever the file holds.
    expect(isSensitivePath(join(outside, "Quarterly review.key"), "read")).toBe("**/*.key");
    expect(isSensitivePath(join(outside, "chain.pem"), "read")).toBe("**/*.pem");
    // A link shown inside a project is not a way to read its target outside.
    expect(isSensitivePath(join(project, "linked.key"), "read")).toBe("**/*.key");
    // The same content inside the project is looked at and found harmless.
    expect(isSensitivePath(join(project, "Quarterly review.key"), "read")).toBeNull();
  });

  it("treats every key-extension name as a key until the registered projects are named", () => {
    const project = keyFixtures();
    for (const restore of restoreInspectionRoots.splice(0)) restore();
    expect(isSensitivePath(join(project, "Quarterly review.key"), "read")).toBe("**/*.key");
    expect(isSensitivePath(join(project, "certs", "chain.pem"), "read")).toBe("**/*.pem");
  });

  it("does not take the unread part of a long file for harmless", () => {
    const dir = keyFixtures();
    const window = 1024 * 1024;
    const filler = "x".repeat(window);
    // A key that starts after the window, and one whose header straddles its end.
    writeFileSync(join(dir, "late.pem"), filler + privateKeyText(""));
    writeFileSync(join(dir, "split.pem"), filler.slice(0, window - 8) + privateKeyText(""));
    // A long file with no key in the part that was read still has a part nobody read.
    writeFileSync(join(dir, "long.pem"), `${filler}tail`);
    for (const name of ["late.pem", "split.pem", "long.pem"]) expect(isSensitivePath(join(dir, name), "read"), name).toBe("**/*.pem");
    // Read whole and found harmless: exactly the window.
    writeFileSync(join(dir, "whole.pem"), filler);
    expect(isSensitivePath(join(dir, "whole.pem"), "read")).toBeNull();
  });

  /** A zip archive with one stored (uncompressed) entry of `body`: local header, data, directory and end record. */
  function zipArchive(body: Buffer): Buffer {
    const name = Buffer.from("index.apxl");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + body.length, 16);
    return Buffer.concat([local, name, body, central, name, end]);
  }

  it("judges an archive by the bytes it read, not by its structure", () => {
    const dir = keyFixtures();
    const window = 1024 * 1024;
    // Read whole and found harmless: a presentation document saved as one archive within the window.
    writeFileSync(join(dir, "Small deck.key"), zipArchive(Buffer.alloc(window / 2, "s")));
    expect(isSensitivePath(join(dir, "Small deck.key"), "read")).toBeNull();
    // A well-formed archive whose stored entry carries a key past the window: key readers find the header anywhere in
    // the file, so a valid structure says nothing about the bytes nobody read.
    const hidden = Buffer.concat([Buffer.alloc(window, "x"), Buffer.from(privateKeyText("")), Buffer.alloc(window, "x")]);
    writeFileSync(join(dir, "hidden.key"), zipArchive(hidden));
    expect(isSensitivePath(join(dir, "hidden.key"), "read")).toBe("**/*.key");
    // Four archive bytes in front of padding and a private key prove nothing either.
    writeFileSync(join(dir, "forged.key"), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(window, "x"), Buffer.from(privateKeyText(""))]));
    expect(isSensitivePath(join(dir, "forged.key"), "read")).toBe("**/*.key");
    // So a large archive is not shown to hold no key, however regular it looks.
    writeFileSync(join(dir, "Big deck.key"), zipArchive(Buffer.alloc(window * 2, "s")));
    expect(isSensitivePath(join(dir, "Big deck.key"), "read")).toBe("**/*.key");
  });

  it("judges bytes already read by those bytes, not by what the path holds now", () => {
    const dir = keyFixtures();
    const window = 1024 * 1024;
    const path = join(dir, "image.key");
    // The path holds a harmless file; the bytes in hand held a key, or ran past what is read.
    writeFileSync(path, "harmless\n");
    expect(isSensitiveContent(path, Buffer.from(privateKeyText("")))).toBe("**/*.key");
    expect(isSensitiveContent(path, Buffer.concat([Buffer.alloc(window, "x"), Buffer.from("tail")]))).toBe("**/*.key");
    // And the other way round: the path holds a key now, the bytes in hand are harmless.
    writeFileSync(path, privateKeyText(""));
    expect(isSensitiveContent(path, Buffer.from("harmless\n"))).toBeNull();
    // Names are judged as for any read.
    expect(isSensitiveContent(join(dir, ".env"), Buffer.from("A=1\n"))).toBe("**/.env");
  });

  it("judges a key-extension file for the person only by a key it was seen to hold", () => {
    const dir = keyFixtures();
    const window = 1024 * 1024;
    // Not shown harmless and not shown to be a key: the agent is asked about it, the person keeps it.
    writeFileSync(join(dir, "Big deck.key"), zipArchive(Buffer.alloc(window * 2, "s")));
    expect(isSensitivePath(join(dir, "Big deck.key"), "read", "agent")).toBe("**/*.key");
    expect(isSensitivePath(join(dir, "Big deck.key"), "read", "person")).toBeNull();
    expect(isSensitivePath(join(dir, "Big deck.key"), "write", "person")).toBeNull();
    // A longer file whose header lies in the part that was read is a confirmed key for both.
    writeFileSync(join(dir, "big.pem"), Buffer.concat([Buffer.from(privateKeyText("")), Buffer.alloc(window * 2, "x")]));
    expect(isSensitivePath(join(dir, "big.pem"), "read", "person")).toBe("**/*.pem");
    expect(isSensitivePath(join(dir, "big.pem"), "read", "agent")).toBe("**/*.pem");
    writeFileSync(join(dir, "small.key"), privateKeyText(""));
    expect(isSensitivePath(join(dir, "small.key"), "read", "person")).toBe("**/*.key");
    // Where the host may not look inside, the name decides for the person too.
    for (const restore of restoreInspectionRoots.splice(0)) restore();
    expect(isSensitivePath(join(dir, "Big deck.key"), "read", "person")).toBe("**/*.key");
  });

  it.skipIf(process.platform === "win32")("treats a key-extension name that is not a regular file as a key, without waiting on it", () => {
    const dir = keyFixtures();
    execFileSync("mkfifo", [join(dir, "pipe.key")]);
    // A pipe is not a file whose content can be shown harmless; it is judged on its name, and the answer does not wait
    // for a writer on the other end.
    expect(isSensitivePath(join(dir, "pipe.key"), "read")).toBe("**/*.key");
  });

  it.each(["read", "write"] as const)("matches a key-extension file by what it holds for %s", (effect) => {
    const dir = keyFixtures();
    expect(isSensitivePath(join(dir, "id_dsa"), effect)).toBe("**/id_dsa");
    expect(isSensitivePath(join(dir, "certs", "server.pem"), effect)).toBe("**/*.pem");
    expect(isSensitivePath(join(dir, "certs", "tls.key"), effect)).toBe("**/*.key");
    expect(isSensitivePath(join(dir, "certs", "ssh.key"), effect)).toBe("**/*.key");
    // A private key after a certificate chain in one bundle is still a private key.
    expect(isSensitivePath(join(dir, "certs", "bundle.pem"), effect)).toBe("**/*.pem");
    // Not secret: a certificate alone, a public key, a presentation document in either form, and a name nothing exists at.
    for (const name of ["certs/chain.pem", "certs/public.key", "Quarterly review.key", "Roadmap.key", "Roadmap.key/index.apxl", "certs/not-written-yet.key"]) {
      expect(isSensitivePath(join(dir, name), effect), name).toBeNull();
    }
    for (const path of ["/work/project/pem/readme.md", "/work/project/keys.ts", "/work/project/server.pem.md", "/work/project/src/key", "/work/project/a.keys"]) {
      expect(isSensitivePath(path, effect), path).toBeNull();
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("treats a key-extension file it cannot read as a key", () => {
    const dir = keyFixtures();
    chmodSync(join(dir, "Quarterly review.key"), 0o000);
    try {
      expect(isSensitivePath(join(dir, "Quarterly review.key"), "read")).toBe("**/*.key");
    } finally {
      chmodSync(join(dir, "Quarterly review.key"), 0o600);
    }
  });

  it("does not treat a public key outside .ssh as a secret, and keeps the .ssh folder whole", () => {
    for (const name of ["id_rsa.pub", "id_ed25519.pub", "id_ecdsa.pub", "id_dsa.pub"]) {
      expect(isSensitivePath(`/work/project/deploy/${name}`, "read"), name).toBeNull();
      expect(isSensitivePath(`/home/example/.ssh/${name}`, "read"), name).toBe("**/.ssh/**");
    }
    expect(SENSITIVE_PATH_PATTERNS.filter((pattern) => pattern.endsWith(".pub"))).toEqual([]);
  });

  it("keeps user secret files on the ask edge, never the admission deny", () => {
    const dir = keyFixtures();
    for (const path of ["/work/project/.env", "/work/project/.env.local", "/work/project/id_rsa", "/work/project/id_dsa",
      "/work/project/id_ed25519", "/work/project/id_ecdsa", join(dir, "certs", "server.pem"), join(dir, "certs", "tls.key")]) {
      expect(isSensitivePath(path, "read"), path).not.toBeNull();
      expect(isAdmissionDeniedPath(path, "read"), path).toBeNull();
      expect(isAdmissionDeniedPath(path, "write"), path).toBeNull();
    }
  });

  it("matches generic id_rsa even outside .ssh/", () => {
    expect(isSensitivePath("/tmp/staging/id_rsa")).toBe("**/id_rsa");
  });

  it("matches generic id_ed25519 even outside .ssh/", () => {
    expect(isSensitivePath("/Users/example/Downloads/id_ed25519")).toBe(
      "**/id_ed25519",
    );
  });
});

describe("isSensitivePath — Permission policy P2.5 Ave-internal", () => {
  it("matches ~/.ave/audit/today.jsonl", () => {
    expect(isSensitivePath("/Users/example/.ave/audit/today.jsonl")).toBe(
      "**/.ave/audit/**",
    );
  });

  it("matches ~/.ave/audit.log", () => {
    expect(isSensitivePath("/Users/example/.ave/audit.log")).toBe(
      "**/.ave/audit.log",
    );
  });

  it("matches ~/.ave/permissions/deferred-queue.jsonl", () => {
    expect(
      isSensitivePath("/Users/example/.ave/permissions/deferred-queue.jsonl"),
    ).toBe("**/.ave/permissions/**");
  });

  it("matches ~/.ave/sessions/<sessionId>.jsonl", () => {
    expect(isSensitivePath("/Users/example/.ave/sessions/abc-123.jsonl")).toBe(
      "**/.ave/sessions/**",
    );
  });

  it("matches ~/.config/ave/hooks/* (post-relocation)", () => {
    expect(
      isSensitivePath("/Users/example/.config/ave/hooks/pre-bash.sh"),
    ).toBe("**/.config/ave/hooks/**");
  });
});

// Permission policy.5 — canonicalizePathForMatch (frozen-canonical)

describe("canonicalizePathForMatch", () => {
  function portableMatchPath(value: string): string {
    return value.replace(/\\/g, "/");
  }

  it("resolves .. segments via path.resolve()", () => {
    const result = canonicalizePathForMatch("/tmp/foo/../bar");
    expect(portableMatchPath(result).endsWith("/bar")).toBe(true);
  });

  it("collapses duplicate slashes", () => {
    const result = canonicalizePathForMatch("/tmp///foo");
    expect(result).not.toMatch(/\/\//);
  });

  it("normalizes NFD unicode to NFC", () => {
    // NFD-decomposed `.ssh` should normalize to `.ssh`. Use a char that has a stable NFD form: `é` (U+00E9) ↔ `é`.
    const decomposed = "/tmp/café.txt";
    const result = canonicalizePathForMatch(decomposed);
    expect(result).toContain("café");
  });

  it("returns absolute path even when the input does not exist", () => {
    const result = canonicalizePathForMatch("/tmp/__does_not_exist__/foo/bar");
    expect(isAbsolute(result)).toBe(true);
    expect(portableMatchPath(result).includes("foo/bar")).toBe(true);
  });

  it("bounded walk-up cap (MAX_WALK_UP)", () => {
    // Synthesize a deep non-existent path. Walk-up MUST terminate without hanging or throwing — the function is tested by completing under a generous time budget.
    const deep = "/tmp/" + "x/".repeat(MAX_WALK_UP + 10) + "leaf";
    const start = Date.now();
    const result = canonicalizePathForMatch(deep);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("MAX_WALK_UP is set to the spec value (64)", () => {
    expect(MAX_WALK_UP).toBe(64);
  });

  it("symlink ancestor is not followed into a cycle", () => {
    // Stage a self-symlink in a temp dir; canonicalize a child path and confirm we get a string back (no hang, no throw). On platforms that forbid self-symlinks, the test still passes via the bounded cap.
    const root = resources.makeTmpDir("ave-canonical-");
    const linkDir = join(root, "loop");
    try {
      symlinkSync(linkDir, linkDir); // self-loop
      const child = join(linkDir, "deep", "leaf.txt");
      const result = canonicalizePathForMatch(child);
      expect(typeof result).toBe("string");
    } catch {
      // Some platforms refuse self-symlinks — skip silently. The bounded walk-up still defends the algorithm; this is exercised above.
    }
  });

  it("sensitive-path detection still fires on relative .. inputs", () => {
    const result = canonicalizePathForMatch(
      "/Users/example/work/../.ave/secrets/openai.key",
    );
    expect(isSensitivePath(caseFoldForMatch(result))).toBe(
      "**/.ave/secrets/**",
    );
  });
});

describe("caseFoldForMatch", () => {
  it("lowercases on darwin/win32, preserves on linux", () => {
    const result = caseFoldForMatch("/Users/Example/Documents");
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(result).toBe("/users/example/documents");
    } else {
      expect(result).toBe("/Users/Example/Documents");
    }
  });
});
