/** Adopt legacy content through normal install plans while preserving live settings.
 * Skip existing installs and retry failed adoptions at the next boot. */
import { errorMessage } from "../../shared/error-message.js";
import { MarketplaceError } from "../errors.js";
import { OFFICIAL_MARKETPLACE } from "../sources/official.js";
import type { PackageKey } from "../sources/policy.js";

export interface LegacyActivations {
  providers: readonly string[];
}

export type LegacyContentKind = "provider";

export interface LegacyContentInput {
  activations: LegacyActivations;
  listed(kind: LegacyContentKind, name: string): boolean;
  installed(kind: LegacyContentKind, name: string): Promise<boolean>;
  adopt(kind: LegacyContentKind, name: string): Promise<void>;
  log: { warn(message: string): void };
}

export interface LegacyContentReport {
  adopted: PackageKey[];
  failed: Array<{ key: PackageKey; message: string }>;
}

export async function migrateLegacyContent(input: LegacyContentInput): Promise<LegacyContentReport> {
  const report: LegacyContentReport = { adopted: [], failed: [] };
  const items: Array<{ kind: LegacyContentKind; name: string }> = [];
  for (const id of new Set(input.activations.providers)) items.push({ kind: "provider", name: id });

  for (const item of items) {
    const key: PackageKey = { source: OFFICIAL_MARKETPLACE.id, kind: item.kind, name: item.name };
    try {
      if (!(await input.installed(item.kind, item.name))) {
        if (!input.listed(item.kind, item.name)) {
          input.log.warn(`legacy ${item.kind} ${item.name} is not listed by the official source; left in settings`);
          continue;
        }
        await input.adopt(item.kind, item.name);
        report.adopted.push(key);
      }
    } catch (error) {
      if (error instanceof MarketplaceError && error.code === "PACKAGE_ID_CONFLICT") {
        input.log.warn(`legacy ${item.kind} ${item.name} is provided by another installed package: ${error.message}`);
        continue;
      }
      input.log.warn(`legacy ${item.kind} ${item.name} not migrated this time: ${errorMessage(error)}`);
      report.failed.push({ key, message: errorMessage(error) });
    }
  }
  return report;
}
