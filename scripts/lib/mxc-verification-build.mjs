import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function mxcVerificationBuild(environment = process.env) {
  const value = environment.AVE_MXC_VERIFICATION_BUILD;
  if (value !== undefined && value !== "0" && value !== "1") throw new Error("Invalid native verification build flag");
  return value === "1";
}

export function assertMxcVerificationPublish(publish, environment = process.env) {
  if (mxcVerificationBuild(environment) && publish !== "never") {
    throw new Error("Native verification builds require --publish=never");
  }
}

export function mxcVerificationEntries(root, environment = process.env) {
  return mxcVerificationBuild(environment)
    ? { "mxc-packaged-probe": path.join(root, "tools", "mxc-probes", "packaged-main.ts") } : {};
}

// Check both the build record and disk so reusing an earlier verification build
// cannot accidentally include diagnostics in an ordinary release package.
export function assertMxcVerificationPayload(directory, environment = process.env) {
  const enabled = mxcVerificationBuild(environment);
  const manifest = JSON.parse(readFileSync(path.join(directory, "bundle-manifest.json"), "utf8"));
  if (manifest.mxcVerificationBuild !== enabled || !Array.isArray(manifest.files)) throw new Error("Native verification build record mismatch");
  const listed = manifest.files.some((entry) => entry.path === "mxc-packaged-probe.js");
  if (listed !== enabled || existsSync(path.join(directory, "mxc-packaged-probe.js")) !== enabled) {
    throw new Error("Native verification entry does not match the build flag");
  }
}
