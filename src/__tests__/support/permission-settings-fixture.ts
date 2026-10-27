import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { permissionSettingsPath } from "../../permissions/permission-settings-store.js";
import { configureHostResources } from "../../main/host-resources.js";

export function writePermissionSettingsFixture(home: string, body: string, encoding: BufferEncoding = "utf8"): void {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const path = permissionSettingsPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { encoding, mode: 0o600 });
}
