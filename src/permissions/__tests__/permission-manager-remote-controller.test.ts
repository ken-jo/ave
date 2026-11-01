import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let directory: string;
let manager: PermissionManager;
const rawAuthority = { kind: "tailnet-controller", actorId: "tailnet:owner" } as const;
const authority = bindRemoteControllerToSession(rawAuthority, "session");
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "remote-controller-"));
  manager = new PermissionManager(join(directory, "permissions.json"));
});
afterEach(() => cleanupTmpDir(directory));

it.each(["strict", "default", "auto", "allow"] as const)("uses identical rules, remembered grants and mode in %s", mode => {
  manager.setMode(mode);
  const local = manager.checkDetailed("network_probe", "builtin", "network", null, { sessionId: "session" });
  const remote = manager.checkDetailed("network_probe", "builtin", "network", null, { sessionId: "session", remoteControllerAuthority: authority });
  expect(remote).toEqual(local);
  expect(manager.resolveRememberedPermission(remote, "Remembered approval")).toMatchObject({ decision: "allow", reasonCode: "remembered-approval" });
  manager.setRules([{ pattern: "network_probe", action: "allow" }]);
  expect(manager.checkDetailed("network_probe", "builtin", "network", null, { sessionId: "session", remoteControllerAuthority: authority }).decision).toBe("allow");
});

it.each([
  { sessionId: "another-session", remoteControllerAuthority: authority },
  { sessionId: "session", remoteControllerAuthority: rawAuthority },
  { sessionId: "session", remoteControllerAuthority: { ...authority } },
  { sessionId: "session", trustOrigin: "tailnet-surface" as const },
])("denies missing or mismatched authenticated binding: %j", context => {
  manager.setMode("allow");
  expect(manager.checkDetailed("read_file", "builtin", "read", null, context)).toMatchObject({ decision: "deny", reasonCode: "remote-controller-unbound" });
});

it("preserves external-content floors before remembered allows for the session owner", () => {
  manager.setMode("allow");
  const result = manager.checkDetailed("read_file", "builtin", "read", null, { sessionId: "session", remoteControllerAuthority: authority,
    floor: { code: "other-principal", reason: "External content guidance" } });
  expect(manager.resolveRememberedPermission(result, "Remembered approval")).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "other-principal" });
});

it("rechecks revocation after the initial decision", () => {
  let current = true;
  const remoteControllerAuthority = bindRemoteControllerToSession({ ...rawAuthority,
    pairedShare: { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
    pairedShareGuard: { isCurrent: () => current } }, "session");
  const initial = manager.checkDetailed("read_file", "builtin", "read", null, { sessionId: "session", remoteControllerAuthority });
  expect(initial.decision).toBe("allow");
  current = false;
  expect(manager.recheckPermission(initial)).toMatchObject({ decision: "deny", reasonCode: "remote-controller-unbound" });
});
