import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeSettingsFile(userDataPath: string, settings: unknown): void {
  writeFileSync(join(userDataPath, "ave-settings.json"), JSON.stringify(settings), "utf-8");
}
