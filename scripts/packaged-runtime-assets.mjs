// Host-owned runtime assets ship with the installer; plugin payloads belong to plugin artifacts.
import { installerUvTargetFor, SUPPORTED_UV_TARGET_DIRS } from "./uv-targets.mjs";
import { GIT_RUNTIME_TARGETS } from "./git-runtime-targets.mjs";

export const HOST_PACKAGED_RUNTIME_ASSETS = Object.freeze([
  Object.freeze({
    id: "uv",
    owner: "host",
    reason: "Python and MCP uvx execution must not download uv on first app launch.",
    targets: SUPPORTED_UV_TARGET_DIRS,
    packageResource: Object.freeze({
      from: "resources/uv-runtime",
      to: "uv",
    }),
    licenseResource: Object.freeze({
      from: "resources/licenses/uv",
      to: "licenses/uv",
      requiredFiles: Object.freeze(["LICENSE-MIT"]),
    }),
    stagedBy: "scripts/build-installers.mjs",
    materializedBy: "src/main/uv-runtime.ts",
  }),
  Object.freeze({
    id: "git",
    owner: "host",
    reason: "Marketplace sources are git repositories; reading one must not depend on a git the user installs or the app downloads.",
    targets: Object.freeze(Object.keys(GIT_RUNTIME_TARGETS)),
    // electron-builder platform keys; macOS uses the system git.
    platformPackageResources: Object.freeze({
      win: Object.freeze({ from: "resources/git-runtime/win32-${arch}", to: "git-runtime/win32-${arch}" }),
      linux: Object.freeze({ from: "resources/git-runtime/linux-${arch}", to: "git-runtime/linux-${arch}" }),
    }),
    licenseResource: Object.freeze({
      from: "resources/licenses/git",
      to: "licenses/git",
      requiredFiles: Object.freeze(["COPYING"]),
    }),
    stagedBy: "scripts/fetch-git.mjs",
    materializedBy: "src/marketplace/git/bundled-git.ts",
  }),
  Object.freeze({
    id: "better-sqlite3-native-binding",
    owner: "host",
    reason: "The Electron main process imports better-sqlite3 at runtime.",
    targets: SUPPORTED_UV_TARGET_DIRS,
    packageResource: Object.freeze({
      from: "node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node",
      to: "app.asar.unpacked/node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node",
    }),
    stagedBy: "npm-shipped N-API prebuild",
    materializedBy: "Electron app resources",
  }),
]);

export const PLUGIN_MANAGED_RUNTIME_ASSETS = Object.freeze([
  Object.freeze({
    id: "python-venv",
    owner: "plugin",
    packageInAppInstaller: false,
    reason: "Python dependencies are declared by plugin lockfiles and must not make base app install heavy.",
  }),
  Object.freeze({
    id: "python-wheelhouse",
    owner: "plugin",
    packageInAppInstaller: false,
    reason: "Offline wheels are plugin artifact responsibility, with plugin-specific license and SHA gates.",
  }),
  Object.freeze({
    id: "python-model-cache",
    owner: "plugin",
    packageInAppInstaller: false,
    reason: "Model payloads are plugin feature assets, not host app boot/runtime assets.",
  }),
]);

export function hostRuntimeAssetsForInstallerTarget(installerTarget, arch = process.arch) {
  const uvTarget = installerUvTargetFor(installerTarget, process.platform, arch);
  return HOST_PACKAGED_RUNTIME_ASSETS.map((asset) => {
    if (asset.id !== "uv") return asset;
    return Object.freeze({
      ...asset,
      selectedTarget: uvTarget.dir,
      packagedBinary: uvTarget.bin,
    });
  });
}

export function hostRuntimeAssetSummary(installerTarget, arch = process.arch) {
  return hostRuntimeAssetsForInstallerTarget(installerTarget, arch)
    .map((asset) => {
      const targetSuffix = asset.selectedTarget ? `:${asset.selectedTarget}` : "";
      return `${asset.id}${targetSuffix}`;
    })
    .join(", ");
}

function printJson() {
  process.stdout.write(
    `${JSON.stringify({
      hostPackagedRuntimeAssets: HOST_PACKAGED_RUNTIME_ASSETS,
      pluginManagedRuntimeAssets: PLUGIN_MANAGED_RUNTIME_ASSETS,
    }, null, 2)}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printJson();
}
