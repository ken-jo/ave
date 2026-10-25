/** Seed revocations from disk before plugin and renderer load gates; marketplace sync refreshes them later. */
import { join } from "node:path";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { createLogger } from "../../lib/logger.js";
import { mcpInstallOrigins } from "../../marketplace/app/mcp-installer.js";
import { revocationFeed } from "../../marketplace/app/revocations.js";
import { contentLedgerOrigins } from "../../marketplace/content/ledger.js";
import { pluginRegistryOrigins, type InstalledOrigin, type OriginReader } from "../../marketplace/sources/retained.js";
import { readPinnedRevocations } from "../../marketplace/sources/sync.js";
import { revocationRegistry } from "../../plugins/revocation/revocation-registry.js";
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("revocation-bootstrap");

export interface RevocationBootstrapInput {
  home: string;
  appVersion: string;
  pluginRegistryPath: string;
  bootAuditLogger: AuditLogger;
}

function audit(logger: AuditLogger, line: string): void {
  try {
    logger.log({ timestamp: new Date().toISOString(), sessionId: "boot", type: "info", input: line });
  } catch {
    /* audit must not break boot */
  }
}

/** Unreadable snapshots leave covered packages without revocations until sync; log errors and continue boot. */
export async function feedRevocationsFromSnapshots(input: RevocationBootstrapInput): Promise<void> {
  const packagesRoot = join(input.home, "packages");
  const readers: Array<[string, OriginReader]> = [
    ["plugins", pluginRegistryOrigins(input.pluginRegistryPath)],
    ["content", contentLedgerOrigins(join(packagesRoot, "ledger.json"))],
    ["mcp", mcpInstallOrigins(join(packagesRoot, "mcp-installs.json"))],
  ];
  const installed: InstalledOrigin[] = [];
  for (const [what, read] of readers) {
    try {
      installed.push(...(await read()));
    } catch (error) {
      log.error({ err: errorMessage(error) }, `revocations: the installed ${what} could not be read; their revocations wait for the next marketplace sync`);
    }
  }
  const root = join(input.home, "marketplaces");
  const feed = await revocationFeed(installed, (sourceId) => readPinnedRevocations(root, sourceId, input.appVersion));
  for (const item of feed.unreadable) {
    log.error({ sourceId: item.sourceId, err: item.message }, "revocations: a source snapshot could not be read; its revocations wait for the next sync");
  }
  revocationRegistry.replace(feed.rules);
  audit(input.bootAuditLogger, `revocations_loaded rules=${feed.rules.length} unreadable=${feed.unreadable.length}`);
}
