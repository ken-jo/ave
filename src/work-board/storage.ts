/** Use the private feature namespace and atomic writer for both JSON and text; domain modules never hand-roll filesystem access. */
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import {
  openFeatureNamespace,
  writeFileAtomicAtPath,
} from "../main/storage/feature-namespace.js";

export const WORK_BOARD_FEATURE = "work-board";

/** Paths are feature-relative; absence returns null for JSON and empty text, with exists gating first reads. */
export interface WorkBoardStorage {
  readJson<T = unknown>(relPath: string): Promise<T | null>;
  writeJson<T>(relPath: string, value: T, indent?: number): Promise<void>;
  readText(relPath: string): Promise<string>;
  write(relPath: string, data: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  mkdir(relPath: string): Promise<void>;
}

function abs(relPath: string): string {
  return join(openFeatureNamespace(WORK_BOARD_FEATURE).dir, relPath);
}

/** All writes use private atomic publication; no remote or fallback path exists. */
export const featureNamespaceStorage: WorkBoardStorage = {
  async readJson<T = unknown>(relPath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(abs(relPath), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      // The domain treats present unusable JSON as absent, matching its storage contract.
      return null;
    }
  },
  async writeJson<T>(relPath: string, value: T, indent = 2): Promise<void> {
    await writeFileAtomicAtPath(abs(relPath), `${JSON.stringify(value, null, indent)}\n`);
  },
  async readText(relPath: string): Promise<string> {
    try {
      return await fs.readFile(abs(relPath), "utf-8");
    } catch {
      return "";
    }
  },
  async write(relPath: string, data: string): Promise<void> {
    await writeFileAtomicAtPath(abs(relPath), data);
  },
  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(abs(relPath));
      return true;
    } catch {
      return false;
    }
  },
  async mkdir(relPath: string): Promise<void> {
    await fs.mkdir(abs(relPath), { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(abs(relPath), 0o700);
    } catch {
      /* Existing directories may retain wider permissions. */
    }
  },
};

/** Injected test roots must still use the same private atomic writer. */
export function createDirStorage(rootDir: string): WorkBoardStorage {
  const at = (relPath: string): string => join(rootDir, relPath);
  return {
    async readJson<T = unknown>(relPath: string): Promise<T | null> {
      try {
        return JSON.parse(await fs.readFile(at(relPath), "utf-8")) as T;
      } catch {
        return null;
      }
    },
    async writeJson<T>(relPath: string, value: T, indent = 2): Promise<void> {
      await writeFileAtomicAtPath(at(relPath), `${JSON.stringify(value, null, indent)}\n`);
    },
    async readText(relPath: string): Promise<string> {
      try {
        return await fs.readFile(at(relPath), "utf-8");
      } catch {
        return "";
      }
    },
    async write(relPath: string, data: string): Promise<void> {
      await fs.mkdir(dirname(at(relPath)), { recursive: true, mode: 0o700 });
      await writeFileAtomicAtPath(at(relPath), data);
    },
    async exists(relPath: string): Promise<boolean> {
      try {
        await fs.access(at(relPath));
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(relPath: string): Promise<void> {
      await fs.mkdir(at(relPath), { recursive: true, mode: 0o700 });
    },
  };
}
