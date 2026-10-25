// The partition gate allows exact runtime assets; the navigation gate allows dist/src containment. Assert that the exact set is narrower, both share the
// same shell identity, and the partition gate remains binding.
import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { isPluginShellFrameUrl } from "../../shared/plugin-shell-frame.js";
import { installPluginPartitionPolicy } from "../html-preview-partition.js";
import { distRoot, runtimeAssetPath } from "../main-paths.js";
import { shouldBlockGlobalWebviewNavigation } from "../webview-navigation-policy.js";

const onBeforeRequest = vi.fn();
installPluginPartitionPolicy(
  "persist:plugin:allowlist-composition",
  {},
  {
    fromPartition: () =>
      ({
        webRequest: { onBeforeRequest },
        registerPreloadScript: vi.fn(),
        // The asset scheme now registers with the rest of the partition policy, unconditionally — a frame binds its URL loaders once, so it has to be on the
        // session before the partition's first frame loads.
        protocol: { handle: vi.fn() },
      }) as unknown as Electron.Session,
  },
);
const requestFilter = onBeforeRequest.mock.calls[0]![0] as (
  details: { url: string },
  callback: (result: { cancel: boolean }) => void,
) => void;

// A's verdict, from the callback the production installer registered.
function partitionFilterAllows(url: string): boolean {
  let cancel = true;
  requestFilter({ url }, (result) => {
    cancel = result.cancel;
  });
  return !cancel;
}

const shellHtmlUrl = pathToFileURL(runtimeAssetPath("plugin-ui-shell.html")).toString();
const shellJsUrl = pathToFileURL(runtimeAssetPath("plugin-ui-shell.js")).toString();
const assetUrl = (...segments: string[]) =>
  pathToFileURL(runtimeAssetPath(...segments)).toString();

// B's verdict for a navigation issued by the real shell frame.
function navigationPolicyAllows(url: string): boolean {
  return !shouldBlockGlobalWebviewNavigation({
    url,
    currentUrl: shellHtmlUrl,
    distRoot,
    authOwned: false,
    linkOwned: false,
  });
}

// Members of `dist/src` that are not shell documents. Named individually rather than globbed: these are the files that make B's width consequential —
// the host preload, the main-process entry, and the renderer bundle.
const NON_SHELL_DIST_SRC_URLS = [
  assetUrl("preload.cjs"),
  assetUrl("main", "main.js"),
  assetUrl("renderer.js"),
];

describe("plugin shell file allow-lists compose (#1953)", () => {
  it("anchors both gates on the same shell document", () => {
    expect(isPluginShellFrameUrl(shellHtmlUrl)).toBe(true);
    expect(partitionFilterAllows(shellHtmlUrl)).toBe(true);
    expect(navigationPolicyAllows(shellHtmlUrl)).toBe(true);
  });

  it("permits every file the partition filter permits (A ⊆ B)", () => {
    for (const url of [shellHtmlUrl, shellJsUrl]) {
      expect(partitionFilterAllows(url)).toBe(true);
      expect(navigationPolicyAllows(url)).toBe(true);
    }
  });

  it("cancels the dist/src files the navigation policy still permits (B \\ A)", () => {
    expect(NON_SHELL_DIST_SRC_URLS.length).toBeGreaterThan(0);
    for (const url of NON_SHELL_DIST_SRC_URLS) {
      expect(navigationPolicyAllows(url)).toBe(true);
      expect(partitionFilterAllows(url)).toBe(false);
    }
  });

  it("rejects files outside dist/src in both gates", () => {
    const outside = pathToFileURL(runtimeAssetPath("..", "..", "etc", "passwd")).toString();
    expect(partitionFilterAllows(outside)).toBe(false);
    expect(navigationPolicyAllows(outside)).toBe(false);
  });
});
