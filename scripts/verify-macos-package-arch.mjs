import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const MACH_O_MAGICS = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe,
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

function isMachO(file, header) {
  const fd = openSync(file, "r");
  try {
    return readSync(fd, header, 0, header.length, 0) === header.length && MACH_O_MAGICS.has(header.readUInt32BE());
  } finally {
    closeSync(fd);
  }
}

function requireArm64(file, label = file) {
  const architectures = execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim();
  if (architectures !== "arm64") throw new Error(`Expected arm64 Mach-O, found ${architectures}: ${label}`);
}

function verifyMacosPackageArch(app, executable) {
  const contents = path.join(app, "Contents");
  const main = path.join(contents, "MacOS", executable);
  // Validate the main executable even when the rest of the app contains no Mach-O files.
  requireArm64(main);
  const header = Buffer.alloc(4);
  let binaries = 1;
  for (const entry of readdirSync(contents, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (file === main || !isMachO(file, header)) continue;
    requireArm64(file);
    binaries++;
  }
  // The runtime expands this helper on first use, so audit the shipped compressed bytes too.
  const archive = path.join(contents, "Resources", "uv", "darwin-arm64", "uv.gz");
  const scratch = mkdtempSync(path.join(tmpdir(), "ave-macos-arch-"));
  try {
    const uv = path.join(scratch, "uv");
    writeFileSync(uv, gunzipSync(readFileSync(archive)));
    requireArm64(uv, archive);
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
  return binaries + 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { build: { productName } } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const app = process.argv[2] ?? path.join("release", "mac-arm64", `${productName}.app`);
  console.log(`Verified ${verifyMacosPackageArch(app, productName)} arm64 Mach-O files in ${app}`);
}
