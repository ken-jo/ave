import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

vi.mock("electron", () => ({ shell: { openPath: vi.fn() } }));
vi.mock("../../permissions/sensitive-paths.js", async original => {
  const actual = await original<typeof import("../../permissions/sensitive-paths.js")>();
  return { ...actual, isSensitivePath: vi.fn(actual.isSensitivePath) };
});

import { isSensitivePath } from "../../permissions/sensitive-paths.js";
import { resolveExternalOpenTarget } from "../../main/external-open-target.js";
import { assertReadableFilePath } from "../file-read-core.js";

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(isSensitivePath).mockClear();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-native-inspection-")));
  roots.push(root);
  const parent = join(root, "Cafe\u0301");
  mkdirSync(parent);
  const path = join(parent, "Mixed-Case.png");
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { root, path: realpathSync.native(path) };
}

// Windows path admission pins through the shipped path-kind helper; boot configures its resources first.
beforeAll(() => configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false }));

it("retains the resolved native spelling for external-open inspection", async () => {
  const { path } = fixture();
  expect(await resolveExternalOpenTarget(path, "person")).toEqual({ ok: true, real: path });
  expect(isSensitivePath).toHaveBeenCalledWith(path, "read", "person");
});

it("retains native lexical and resolved operands for direct-read inspection", () => {
  const { root, path } = fixture();
  expect(assertReadableFilePath(path, root, [], "person")).toEqual({ ok: true, resolved: path });
  expect(vi.mocked(isSensitivePath).mock.calls).toEqual([[path, "read", "person"], [path, "read", "person"]]);
});
