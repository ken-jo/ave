import { resolve } from "node:path";

// Windows hosts resolve a fixture POSIX path onto the process drive; Git Bash's `/` is its own root, not a drive.
export const hostFilesystemPath = (path: string): string => process.platform === "win32" ? resolve(path).replaceAll("\\", "/") : path;
