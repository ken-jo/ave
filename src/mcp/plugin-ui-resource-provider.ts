/** Serve only own-namespace declared card resources, attaching reviewed manifest policy to plugin bytes. */
import type { McpUiResourceRead, PluginUiResourceDecl } from "./types.js";

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export interface PluginUiResourceListing {
  uri: string;
  mimeType: string;
}

export interface PluginUiResourceProvider {
  list(): PluginUiResourceListing[];
  /** Refuse namespace, declaration and hook failures without returning content. */
  read(uri: string): Promise<McpUiResourceRead>;
}

export interface CreatePluginUiResourceProviderInput {
  pluginId: string;
  declarations: readonly PluginUiResourceDecl[];
  /** Invoke the bounded runtime hook only after namespace and declaration checks pass. */
  readHtml: (uri: string) => Promise<string>;
}

/** Invalid or non-ui URIs return null and fail namespace admission. */
function uiAuthority(uri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ui:") return null;
  return parsed.hostname.length > 0 ? parsed.hostname : null;
}

export function createPluginUiResourceProvider(
  input: CreatePluginUiResourceProviderInput,
): PluginUiResourceProvider {
  const { pluginId, readHtml } = input;

  // Duplicate declarations resolve last-write-wins within the indexed reviewed set.
  const byUri = new Map<string, PluginUiResourceDecl>();
  for (const decl of input.declarations) byUri.set(decl.uri, decl);

  return {
    list() {
      return [...byUri.keys()].map((uri) => ({ uri, mimeType: MCP_APP_MIME_TYPE }));
    },
    async read(uri: string): Promise<McpUiResourceRead> {
      if (uiAuthority(uri) !== pluginId) {
        throw new Error(
          `[plugin-ui-resource:${pluginId}] refuses to serve a ui:// resource outside its own namespace: '${uri}'`,
        );
      }
      const decl = byUri.get(uri);
      if (!decl) {
        throw new Error(`[plugin-ui-resource:${pluginId}] no declared ui:// resource '${uri}'`);
      }
      const html = await readHtml(uri);
      // Hook output cannot widen the reviewed manifest policy.
      return {
        html,
        ...(decl.csp !== undefined ? { csp: decl.csp } : {}),
        ...(decl.permissions !== undefined ? { permissions: decl.permissions } : {}),
      };
    },
  };
}
