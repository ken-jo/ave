import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getBuiltinModule } from "node:process";
import { expect, it, vi } from "vitest";
import { selectSrtWinTestReceipts, upstreamSrtWinReceiptFixtures } from "./support/srt-win-build-receipts.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: () => true,
}));

const require = createRequire(import.meta.url);
const { readUpstreamSrtWinInput } = require("../../scripts/lib/srt-win-integrity.cjs") as {
  readUpstreamSrtWinInput: (vendor: string, arch: string) => Buffer;
};
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = getBuiltinModule("node:fs");

it("selects upstream fixture receipts without adjacent receipts under a suite filesystem mock", async () => {
  const vendor = mkdtempSync(join(tmpdir(), "ave-srt-receipt-selection-"));
  try {
    const installedVendor = join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "vendor");
    const fixtures = upstreamSrtWinReceiptFixtures();
    for (const arch of Object.keys(fixtures)) {
      const directory = join(vendor, "srt-win", arch);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "srt-win.exe"), readUpstreamSrtWinInput(installedVendor, arch));
      expect(existsSync(join(directory, "build-receipt.json"))).toBe(false);
    }
    expect((await import("node:fs")).existsSync(join(vendor, "missing"))).toBe(true);
    expect(selectSrtWinTestReceipts({}, vendor)).toEqual(fixtures);
  } finally {
    rmSync(vendor, { recursive: true, force: true });
  }
});
