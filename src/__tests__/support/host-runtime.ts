import type { BootHost, DesktopHostCapabilities } from "../../boot/host-runtime.js";
import type { SecretEncryption } from "../../data/secret-document-store.js";
import { directHostFetchTransport } from "./host-fetch-transport.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const unavailableSecretEncryption: SecretEncryption = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => "unknown",
  encryptString: () => { throw new Error("test-encryption-unavailable"); },
  decryptString: () => { throw new Error("test-encryption-unavailable"); },
};

export const stationaryLeaseState = {
  getProviderConfigRevision: () => 0,
  getSecretGeneration: (_key: string) => 0,
  onLeaseStateChanged: (_listener: () => void) => () => {},
};

export function createBootHostFixture(overrides: Partial<BootHost> = {}): BootHost {
  const fetchUnavailable: typeof fetch = async () => { throw new Error("test-network-unavailable"); };
  return {
    userDataPath: join(tmpdir(), "ave-host-fixture"),
    resourcePath: join(tmpdir(), "ave-host-fixture-resources"),
    systemLocale: "en",
    isPackaged: false,
    encryption: unavailableSecretEncryption,
    networkFetch: fetchUnavailable,
    singleHopNetworkFetch: directHostFetchTransport(fetchUnavailable),
    llmFetch: fetchUnavailable,
    exit: () => { throw new Error("test-host-exit"); },
    relaunch: () => { throw new Error("relaunch-unsupported"); },
    close: async () => {},
    ...overrides,
  };
}

export function createDesktopHostFixture(overrides: Partial<DesktopHostCapabilities> = {}): DesktopHostCapabilities {
  const unavailable = (): never => { throw new Error("test-desktop-capability-unused"); };
  return {
    getAppWindows: () => [],
    openOAuthLogin: unavailable,
    getFocusedWindow: () => null,
    findSessionSurface: () => null,
    findTerminalSurface: () => null,
    getAuthPartition: unavailable,
    openAuthWindowService: unavailable,
    openLinkWindowService: unavailable,
    openAuthPartitionViewerService: unavailable,
    clearAuthPartitionService: unavailable,
    shellOpenExternal: unavailable,
    installPluginPartition: () => {},
    revokePluginWebviews: unavailable,
    onBootShutdown: () => {},
    initializeNotificationPresenter: () => false,
    notificationOptions: { isReady: () => false, isAnyWindowFocused: () => false, notificationActivationRegistration: null },
    powerMonitor: { getSystemIdleTime: () => 0, on: () => {}, removeAllListeners: () => {} },
    createAudioCaptureSurface: unavailable,
    createFloatingDockSurface: unavailable,
    pickFolders: unavailable,
    pickBrowserUploadFiles: unavailable,
    browserGuestContentOrigin: unavailable,
    prepareRelease: () => ({}),
    beforeShutdown: () => {},
    ...overrides,
  };
}
