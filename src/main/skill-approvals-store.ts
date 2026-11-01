// Approval binds an opaque record key to a hash of caller-selected material; bundled resources may be part of that material. Any mismatch or legacy
// unhashed record requires re-approval, including user-edited seeded skills.
import { resolve } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { adoptLegacyRootFileSync, readJsonFileOrEmpty, writeFileAtomicAtPath, writeFileAtomicAtPathIf } from "./storage/feature-namespace.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";

interface SkillApprovalRecord {
  // Record key from the caller — a skill name, or `<name>#bundled`.
  name: string;
  // Hash of the approval material bound to that key.
  sha256: string;
  approvedAt: string;
}

interface SkillApprovalsFile {
  version: 2;
  approvedSkills: SkillApprovalRecord[];
}

const FEATURE_ID = "skills";
const FILE_NAME = "approvals.json";
const LEGACY_ROOT_FILE = "skill-approvals.json";

const defaultPath = (): string => resolve(aveHome(), FEATURE_ID, FILE_NAME);

// Hash exact approval bytes, including whitespace; callers may supply bundled-resource material rather than a body.
export function hashSkillMaterial(material: string): string {
  return sha256Hex(material);
}

function emptyApprovalsFile(): SkillApprovalsFile {
  return { version: 2, approvedSkills: [] };
}

function readFileOrEmpty(filePath: string): Promise<SkillApprovalsFile> {
  return readJsonFileOrEmpty(filePath, emptyApprovalsFile, (parsed) => {
    const file = parsed as Partial<SkillApprovalsFile> & {
      version?: number;
      approvedSkills?: unknown;
    };
    // Only v2 records with a hash are honored. Older formats (v1 string array, or v2 without sha256) are dropped to force re-approval; do NOT silently upgrade.
    if (file.version !== 2 || !Array.isArray(file.approvedSkills)) {
      return emptyApprovalsFile();
    }
    const records: SkillApprovalRecord[] = [];
    for (const r of file.approvedSkills) {
      if (
        r &&
        typeof r === "object" &&
        typeof (r as SkillApprovalRecord).name === "string" &&
        typeof (r as SkillApprovalRecord).sha256 === "string" &&
        typeof (r as SkillApprovalRecord).approvedAt === "string"
      ) {
        records.push(r as SkillApprovalRecord);
      }
    }
    return { version: 2, approvedSkills: records };
  });
}

// Use random exclusive staging and fsync so planted predictable symlinks cannot redirect approval writes.
async function writeAtomic(filePath: string, data: SkillApprovalsFile): Promise<void> {
  await writeFileAtomicAtPath(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export class SkillApprovalsStore {
  private cache: Map<string, string> | null = null; // record key → material hash
  private readonly filePath: string;

  constructor(filePath: string = defaultPath()) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    // Only when this store is on its default path: a caller that passed an explicit path (tests, fixtures) is not talking about `~/.ave` at all, and
    // migrating the real user's file underneath such a call would be a side effect nobody asked for.
    if (this.filePath === defaultPath()) {
      adoptLegacyRootFileSync(FEATURE_ID, FILE_NAME, LEGACY_ROOT_FILE);
    }
    const file = await readFileOrEmpty(this.filePath);
    this.cache = new Map(file.approvedSkills.map((r) => [r.name, r.sha256]));
  }

  // Approved iff (record key, hash of current material) matches a stored pair. Any change to the material invalidates the approval — this returns false
  // and the caller (skill-load) re-prompts via ApprovalGate.
  async isApproved(recordKey: string, currentMaterial: string): Promise<boolean> {
    if (this.cache === null) await this.load();
    const recordedHash = this.cache!.get(recordKey);
    if (!recordedHash) return false;
    return recordedHash === hashSkillMaterial(currentMaterial);
  }

  // Bind current material to the same caller-derived key used by isApproved; mismatched derivation would re-prompt forever.
  async approve(recordKey: string, currentMaterial: string, canCommit?: () => boolean): Promise<void> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const newHash = hashSkillMaterial(currentMaterial);
      const existing = file.approvedSkills.find((r) => r.name === recordKey);
      if (existing) {
        existing.sha256 = newHash;
        existing.approvedAt = new Date().toISOString();
      } else {
        file.approvedSkills.push({
          name: recordKey,
          sha256: newHash,
          approvedAt: new Date().toISOString(),
        });
      }
      if (canCommit) {
        if (!await writeFileAtomicAtPathIf(this.filePath, `${JSON.stringify(file, null, 2)}\n`, canCommit)) {
          throw new Error("Skill approval authority is unavailable");
        }
      } else {
        await writeAtomic(this.filePath, file);
      }
      this.cache = new Map(file.approvedSkills.map((r) => [r.name, r.sha256]));
    });
  }
}
