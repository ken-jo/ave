/** Managed archives use pinned hashes and lengths; every platform shares the tar extractor. */
interface ManagedGitAsset {
  url: string;
  sha256: string;
  /** Exact byte length; a longer body is cut off, a shorter one fails the hash. */
  size: number;
}

export interface ManagedGitPins {
  version: string;
  assets: Readonly<Record<string, ManagedGitAsset>>;
}

const RELEASE = "https://github.com/desktop/dugite-native/releases/download/v2.53.0-4/dugite-native-v2.53.0-4098283";

export const MANAGED_GIT: ManagedGitPins = Object.freeze({
  version: "2.53.0",
  assets: Object.freeze({
    "darwin-arm64": {
      url: `${RELEASE}-macOS-arm64.tar.gz`,
      sha256: "f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe",
      size: 62348987,
    },
    "darwin-x64": {
      url: `${RELEASE}-macOS-x64.tar.gz`,
      sha256: "ae6686718aa34f4140424db16b92a47dcffd6d1f312eb8b5f3b267f7404e2680",
      size: 66136060,
    },
    "linux-x64": {
      url: `${RELEASE}-ubuntu-x64.tar.gz`,
      sha256: "cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901",
      size: 65269219,
    },
    "linux-arm64": {
      url: `${RELEASE}-ubuntu-arm64.tar.gz`,
      sha256: "a161f45af4626bb7e0c688854bd4a9aee47cc514bca404cff0a5e3536ef1c0af",
      size: 23223345,
    },
    "win32-x64": {
      url: `${RELEASE}-windows-x64.tar.gz`,
      sha256: "7b76bc5c32c0d7c5984efdc2a8a32697cf1e8a43bc55176fbf9869c0ee995130",
      size: 47119821,
    },
    "win32-arm64": {
      url: `${RELEASE}-windows-arm64.tar.gz`,
      sha256: "1abbeb3a2ce06e9b80e75bb888dce959b6c73bdb11ccc670a01a71d64f4422a5",
      size: 45084825,
    },
  }),
});
