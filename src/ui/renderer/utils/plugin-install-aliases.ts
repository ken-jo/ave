const MARKETPLACE_SLUG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "vega-helper": ["ave-plugin-vega-early"],
};

export function getPluginInstallAliases(pluginId: string): string[] {
  const normalized = pluginId.trim();
  if (!normalized) return [];
  const aliases = new Set<string>([
    normalized,
    `ave-plugin-${normalized}`,
    ...(MARKETPLACE_SLUG_ALIASES[normalized] ?? []),
  ]);
  return Array.from(aliases);
}

export function isPluginInstallKey(pluginId: string, slug: string): boolean {
  return getPluginInstallAliases(pluginId).includes(slug);
}
