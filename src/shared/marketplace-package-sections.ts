import {
  INSTALLABLE_MARKETPLACE_PACKAGE_TYPES,
  MARKETPLACE_PACKAGE_TYPES,
  type InstallableMarketplacePackageType,
  type MarketplacePackageType,
} from "./assistant-context.js";

export const MARKETPLACE_ASSET_PACKAGE_TYPES = [
  "provider",
  "theme",
  "language-pack",
  "messaging-connection",
] as const satisfies readonly MarketplacePackageType[];

export type MarketplaceAssetPackageType =
  (typeof MARKETPLACE_ASSET_PACKAGE_TYPES)[number];

type MarketplacePackageFilter = "all" | MarketplacePackageType;

export interface MarketplacePackageFilterOption {
  value: MarketplacePackageFilter;
  label: string;
}

export interface MarketplacePackageSectionDefinition {
  type: MarketplacePackageType;
  label: string;
  installable: boolean;
  uninstallable: boolean;
  assetBacked: boolean;
  trustLabelKeys: readonly string[];
}

const PACKAGE_VOCABULARY_KINDS = { plugin: "extension", "agent-plugin": "plugin" } as const;
const CODE_PACKAGE_SECTION_LABELS = { extension: "Extensions", plugin: "Plugins" } as const;

const MARKETPLACE_PACKAGE_TYPE_LABELS: Readonly<Record<MarketplacePackageType, string>> =
  Object.freeze({
    plugin: CODE_PACKAGE_SECTION_LABELS[packageVocabularyKind("plugin")],
    mcp: "MCP",
    agent: "Agents",
    skill: "Skills",
    provider: "Providers",
    theme: "Themes",
    "language-pack": "Languages",
    "messaging-connection": "Messaging",
  });

const INSTALLABLE_PACKAGE_TYPE_SET = new Set<string>(INSTALLABLE_MARKETPLACE_PACKAGE_TYPES);
const MARKETPLACE_ASSET_PACKAGE_TYPE_SET = new Set<string>(MARKETPLACE_ASSET_PACKAGE_TYPES);
const HOST_UNINSTALLABLE_PACKAGE_TYPE_SET = new Set<string>([
  "plugin",
  "mcp",
  "agent",
  "skill",
] satisfies readonly MarketplacePackageType[]);

const MARKETPLACE_ASSET_PACKAGE_TRUST_LABEL_KEYS: Readonly<
  Record<MarketplaceAssetPackageType, readonly string[]>
> = Object.freeze({
  provider: Object.freeze([
    "marketplaceTab.trustProviderCredentials",
    "marketplaceTab.trustProviderNetwork",
  ]),
  theme: Object.freeze([
    "marketplaceTab.trustNoCode",
    "marketplaceTab.trustThemeTokens",
  ]),
  "language-pack": Object.freeze([
    "marketplaceTab.trustNoCode",
    "marketplaceTab.trustLanguageCatalog",
  ]),
  "messaging-connection": Object.freeze([
    "marketplaceTab.trustMessagingCredentials",
    "marketplaceTab.trustMessagingNetwork",
  ]),
});

export function isInstallableMarketplacePackageType(
  value: unknown,
): value is InstallableMarketplacePackageType {
  return typeof value === "string" && INSTALLABLE_PACKAGE_TYPE_SET.has(value);
}

export function isMarketplaceAssetPackageType(
  value: unknown,
): value is MarketplaceAssetPackageType {
  return typeof value === "string" && MARKETPLACE_ASSET_PACKAGE_TYPE_SET.has(value);
}

export function packageVocabularyKind(kind: "plugin" | "agent-plugin"): "extension" | "plugin" {
  return PACKAGE_VOCABULARY_KINDS[kind];
}

export function marketplacePackageLabel(packageType: MarketplacePackageType | "agent-plugin"): string {
  if (packageType === "plugin" || packageType === "agent-plugin") {
    return CODE_PACKAGE_SECTION_LABELS[packageVocabularyKind(packageType)];
  }
  return MARKETPLACE_PACKAGE_TYPE_LABELS[packageType];
}

export interface MarketplacePackageKindFields {
  readonly pluginType?: MarketplacePackageType;
  readonly unsupportedPackageKind?: string;
}

/** Missing kind means legacy plugin; an explicit unknown kind is unrecognized, never coerced to plugin. */
export function marketplacePackageTypeOf(
  fields: MarketplacePackageKindFields,
): MarketplacePackageType | undefined {
  if (fields.unsupportedPackageKind !== undefined) return undefined;
  return fields.pluginType ?? "plugin";
}

export function marketplaceTrustLabelKeysForPackage(
  packageType: MarketplacePackageType,
  options: { hasSupportedAsset?: boolean } = {},
): readonly string[] {
  if (options.hasSupportedAsset === false) return [];
  return isMarketplaceAssetPackageType(packageType)
    ? MARKETPLACE_ASSET_PACKAGE_TRUST_LABEL_KEYS[packageType]
    : [];
}

export function canInstallMarketplacePackageType(
  packageType: MarketplacePackageType,
  options: { hasSupportedAsset?: boolean } = {},
): boolean {
  return (
    isInstallableMarketplacePackageType(packageType) ||
    (options.hasSupportedAsset === true && isMarketplaceAssetPackageType(packageType))
  );
}

export function canUninstallMarketplacePackageType(
  packageType: MarketplacePackageType,
  options: { hasSupportedAsset?: boolean } = {},
): boolean {
  return (
    HOST_UNINSTALLABLE_PACKAGE_TYPE_SET.has(packageType) ||
    (options.hasSupportedAsset === true && isMarketplaceAssetPackageType(packageType))
  );
}

export const MARKETPLACE_PACKAGE_SECTIONS: readonly MarketplacePackageSectionDefinition[] =
  Object.freeze(
    MARKETPLACE_PACKAGE_TYPES.map((type) => Object.freeze({
      type,
      label: marketplacePackageLabel(type),
      installable: isInstallableMarketplacePackageType(type),
      uninstallable: canUninstallMarketplacePackageType(type, { hasSupportedAsset: false }),
      assetBacked: isMarketplaceAssetPackageType(type),
      trustLabelKeys: marketplaceTrustLabelKeysForPackage(type),
    })),
  );

export const MARKETPLACE_PACKAGE_FILTER_OPTIONS: readonly MarketplacePackageFilterOption[] =
  Object.freeze([
    { value: "all", label: "All" },
    ...MARKETPLACE_PACKAGE_SECTIONS.map(({ type, label }) => ({
      value: type,
      label,
    })),
  ]);
