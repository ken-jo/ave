



import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { aveHome } from "../shared/ave-home.js";
const log = createLogger("policy-store");



const DEFAULT_USER_POLICY_PATH = resolve(aveHome(), "policy.json");




export function getAdminPolicyPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/Ave/policy.json";
    case "win32":
      return join(process.env.ProgramData ?? "C:\\ProgramData", "Ave", "policy.json");
    case "linux":
      return "/etc/ave/policy.json";
    default:

      return "/nonexistent/ave/policy.json";
  }
}



export interface PolicyFile {
  version: 1;

  requireExplicitApproval: boolean;

  managed: boolean;
  updatedAt: string;
}




export interface LoadedPolicy extends PolicyFile {

  source: "defaults" | "user" | "admin" | "merged";

  adminOverrides?: string[];

  adminPath?: string;
}



function defaultPolicy(): PolicyFile {
  return {
    version: 1,
    requireExplicitApproval: true,
    managed: false,
    updatedAt: new Date().toISOString(),
  };
}



const policyLocks = new Map<string, Promise<void>>();

async function withPolicyLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(filePath);
  const prev = policyLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  policyLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

// ─── Read (single file) ───────────────────────────────

async function readPolicyFile(filePath: string): Promise<PolicyFile | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PolicyFile;
    if (parsed.version !== 1) {

      log.error(`version mismatch in ${filePath}: expected 1, got ${parsed.version} — ignoring`);
      return null;
    }
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // JSON parse error 등 — 에러 로그 + fallback
    log.error(`failed to read ${filePath}: %s`, (err as Error).message);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────

/**
 * policy를 로드한다. admin-dir 파일이 있으면 user 파일보다 우선 merge.
 *
 * 반환값의 `source` 필드:
 *  - "defaults": 파일 없음 → 기본값
 *  - "user":     user 파일만 존재
 *  - "admin":    admin 파일만 존재 (또는 user 파일 없이 admin만)
 *  - "merged":   둘 다 존재, admin이 user를 override
 *
 * @param userPath  사용자 policy 파일 경로 (기본: ~/.ave/policy.json)
 * @param adminPath admin policy 파일 경로 (기본: getAdminPolicyPath())
 */
export async function loadPolicy(
  userPath = DEFAULT_USER_POLICY_PATH,
  adminPath = getAdminPolicyPath(),
): Promise<LoadedPolicy> {
  const [userFile, adminFile] = await Promise.all([
    readPolicyFile(userPath),
    readPolicyFile(adminPath),
  ]);

  // case 1: 둘 다 없음 → defaults
  if (!userFile && !adminFile) {
    return { ...defaultPolicy(), source: "defaults" };
  }

  // case 2: user만 존재
  if (userFile && !adminFile) {
    return { ...userFile, source: "user" };
  }

  // case 3: admin만 존재 (user 없음)
  if (!userFile && adminFile) {
    return { ...adminFile, source: "admin", adminPath };
  }

  // case 4: 둘 다 존재 → merge (admin wins)
  const base = { ...defaultPolicy(), ...userFile! };
  const overrides: string[] = [];
  const merged = { ...base };

  const adminFields = adminFile!;
  // requireExplicitApproval
  if (adminFields.requireExplicitApproval !== undefined &&
      adminFields.requireExplicitApproval !== base.requireExplicitApproval) {
    merged.requireExplicitApproval = adminFields.requireExplicitApproval;
    overrides.push("requireExplicitApproval");
  }
  // managed: admin true → always true
  if (adminFields.managed === true) {
    merged.managed = true;
    if (!base.managed) overrides.push("managed");
  }
  // updatedAt: use admin's timestamp when merged
  merged.updatedAt = adminFields.updatedAt;

  return {
    ...merged,
    version: 1,
    source: "merged",
    adminPath,
    adminOverrides: overrides,
  };
}

/**
 * policy를 디스크에 저장한다.
 *
 * 차단 조건 (우선순위):
 *  1. admin-dir 파일이 존재하면 항상 throw ("Policy is managed by IT (admin-dir file exists)")
 *  2. user 파일의 managed: true → throw ("IT 관리 정책은 사용자가 변경할 수 없습니다.")
 *
 * managed 플래그 자체는 patch로 변경 불가 — IT Admin API 전용.
 */
export async function savePolicy(
  patch: Partial<Omit<PolicyFile, "version" | "managed" | "updatedAt">>,
  userPath = DEFAULT_USER_POLICY_PATH,
  adminPath = getAdminPolicyPath(),
): Promise<PolicyFile> {
  return withPolicyLock(userPath, async () => {
    // admin-dir 우선 체크
    const adminFile = await readPolicyFile(adminPath);
    if (adminFile !== null) {
      throw new Error("Policy is managed by IT (admin-dir file exists)");
    }

    const existing = await readPolicyFile(userPath);

    // user managed: true 체크 (기존 B1 동작 유지)
    if (existing?.managed === true) {
      throw new Error(t("be_policyStore.managedPolicyUserCannotChange"));
    }

    const current = existing ?? defaultPolicy();
    const updated: PolicyFile = {
      ...current,
      ...patch,
      version: 1,
      managed: current.managed, // 사용자가 managed를 바꿀 수 없음
      updatedAt: new Date().toISOString(),
    };

    await mkdir(dirname(userPath), { recursive: true });
    // §S4: 0o600 — owner read/write only
    const fd = await open(userPath, "w", 0o600);
    try {
      await fd.writeFile(`${JSON.stringify(updated, null, 2)}\n`, "utf-8");
    } finally {
      await fd.close();
    }

    return updated;
  });
}
