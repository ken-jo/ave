/** Main and renderer must use the same partition hash or the webview can enter an unregistered partition without its policy and bridge. */

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

export function pluginPartitionHash(pluginId: string): string {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < pluginId.length; i++) {
    h ^= pluginId.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function pluginPartitionName(pluginId: string): string {
  return `persist:plugin:${pluginPartitionHash(pluginId)}`;
}

/** Keep recognition beside construction so policy guards cannot drift from generated partition names. */
export function isPluginPartitionName(partition: string): boolean {
  return /^persist:plugin:[0-9a-f]{8}$/.test(partition);
}
