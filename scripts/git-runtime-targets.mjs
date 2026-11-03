// The marketplace git ships inside the installer. Packaging and the app read the same pins and layout.
// macOS has no entry: a copy there would need every nested binary signed for notarization, so it uses the system git.
import path from "node:path";

export const GIT_RUNTIME_VERSION = "2.53.0";

const RELEASE = "https://github.com/desktop/dugite-native/releases/download/v2.53.0-4/dugite-native-v2.53.0-4098283";

/** Each archive is pinned by exact byte length and sha256. */
export const GIT_RUNTIME_TARGETS = Object.freeze({
  "win32-x64": Object.freeze({
    url: `${RELEASE}-windows-x64.tar.gz`,
    sha256: "7b76bc5c32c0d7c5984efdc2a8a32697cf1e8a43bc55176fbf9869c0ee995130",
    size: 47119821,
  }),
  "win32-arm64": Object.freeze({
    url: `${RELEASE}-windows-arm64.tar.gz`,
    sha256: "1abbeb3a2ce06e9b80e75bb888dce959b6c73bdb11ccc670a01a71d64f4422a5",
    size: 45084825,
  }),
  "linux-x64": Object.freeze({
    url: `${RELEASE}-ubuntu-x64.tar.gz`,
    sha256: "cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901",
    size: 65269219,
  }),
  "linux-arm64": Object.freeze({
    url: `${RELEASE}-ubuntu-arm64.tar.gz`,
    sha256: "a161f45af4626bb7e0c688854bd4a9aee47cc514bca404cff0a5e3536ef1c0af",
    size: 23223345,
  }),
});

/** Written by scripts/fetch-git.mjs once the copy is verified; the app trusts a copy only with it. */
export const GIT_RUNTIME_MARKER = "git-runtime.meta.json";

/** Resources-relative directory of the copy. */
export const GIT_RUNTIME_RESOURCE_DIR = "git-runtime";

export function gitRuntimeTargetKey(platform, arch) {
  const key = `${platform}-${arch}`;
  return Object.hasOwn(GIT_RUNTIME_TARGETS, key) ? key : null;
}

export function gitRuntimeLayout(root, platform) {
  if (platform === "win32") {
    return Object.freeze({
      executable: path.join(root, "cmd", "git.exe"),
      execPath: path.join(root, "mingw64", "libexec", "git-core"),
      // Its https helper lives on the PATH prefix, not in GIT_EXEC_PATH.
      httpsHelper: path.join(root, "mingw64", "bin", "git-remote-https.exe"),
      pathPrefix: Object.freeze([path.join(root, "mingw64", "bin"), path.join(root, "usr", "bin")]),
      shippedCaBundle: null,
      config: Object.freeze({ "http.sslBackend": "schannel" }),
    });
  }
  return Object.freeze({
    executable: path.join(root, "bin", "git"),
    execPath: path.join(root, "libexec", "git-core"),
    httpsHelper: path.join(root, "libexec", "git-core", "git-remote-https"),
    pathPrefix: Object.freeze([]),
    shippedCaBundle: platform === "linux" ? path.join(root, "ssl", "cacert.pem") : null,
    config: Object.freeze({}),
  });
}
