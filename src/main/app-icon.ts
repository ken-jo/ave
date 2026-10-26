import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./main-paths.js";

let cachedIconPath: string | null | undefined;

export interface AppIconPathOptions {
  resourcesPath?: string;
  projectRoot?: string;
  cwd?: string;
  exists?: (path: string) => boolean;
}

export function findIconPath(
  fileName: string,
  resourcesPath: string | undefined,
  devProjectRoot: string,
  cwd: string,
  exists: (path: string) => boolean,
): string | undefined {
  return [
    resourcesPath ? join(resourcesPath, fileName) : null,
    join(devProjectRoot, "build", fileName),
    join(cwd, "build", fileName),
  ].find((candidate) => candidate !== null && exists(candidate)) ?? undefined;
}

export function resolveAppIconPath(options: AppIconPathOptions = {}): string | undefined {
  const useCache = Object.keys(options).length === 0;
  if (useCache && cachedIconPath !== undefined) {
    return cachedIconPath ?? undefined;
  }

  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const devProjectRoot = options.projectRoot ?? projectRoot;
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const iconPath = findIconPath("icon.png", resourcesPath, devProjectRoot, cwd, exists) ?? null;
  if (useCache) cachedIconPath = iconPath;
  return iconPath ?? undefined;
}
