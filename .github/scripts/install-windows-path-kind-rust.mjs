import { execFileSync } from "node:child_process";
import { windowsPathKindRustupRoot, windowsPathKindTarget, windowsPathKindToolchain } from "../../scripts/lib/windows-path-kind-build.mjs";

const target = windowsPathKindTarget(process.argv[2]);
const toolchain = windowsPathKindToolchain(process.cwd());
execFileSync("rustup", ["toolchain", "install", toolchain, "--profile", "minimal", "--no-self-update", "--target", target], {
  env: { ...process.env, RUSTUP_HOME: windowsPathKindRustupRoot() },
  stdio: "inherit",
  windowsHide: true,
});
