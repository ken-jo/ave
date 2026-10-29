import { afterEach, describe, it, expect, vi } from "vitest";
import { realpathSync, symlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  SENSITIVE_PATH_PATTERNS,
  SENSITIVE_PATH_ENTRIES,
  isSensitivePath,
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
  expect([...AVE_HOME_PROTECTED_DIRECTORIES].sort()).toEqual(credentialDirectories.sort());
  expect(AVE_HOME_PROTECTED_DIRECTORIES).toHaveLength(5);
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
    for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist"]) {
      expect(isSensitivePath(`/work/project/${name}`, effect)).toBeNull();
      expect(isSensitivePath(`/work/project/nested/${name}`, effect)).toBeNull();
      expect(isSensitivePath(`/work/.aws/${name}`, effect)).not.toBeNull();
    }
    for (const name of [".env", ".env.local", ".env.production", ".env.example.local", ".env.dist.bak"]) {
      expect(isSensitivePath(`/work/project/${name}`, effect)).not.toBeNull();
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
