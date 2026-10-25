import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { permissionSettingsPath } from "../../permissions/permission-settings-store.js";

export function writePermissionSettingsFixture(home: string, body: string, encoding: BufferEncoding = "utf8"): void {
  const path = permissionSettingsPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { encoding, mode: 0o600 });
}
