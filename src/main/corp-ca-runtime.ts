// Cache acquisition and process-wide TLS injection share one pipeline; certificate selection belongs to corp-ca-extract.ts.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import * as https from "node:https";
import { join } from "node:path";
import * as tls from "node:tls";
import { Agent, setGlobalDispatcher } from "undici";
import { createLogger } from "../lib/logger.js";
import { aveHome } from "../shared/ave-home.js";
import { countCertificates, extractCorporateCa } from "./corp-ca-extract.js";
import { resolveCorpCaConfig, type CorpCaConfig } from "../shared/corp-ca-config.js";
import { errorMessage } from "../shared/error-message.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
const caLog = createLogger("corp-ca");

export interface CorporateCaResult {
  pem: string | null;

  path: string;

  source: "cache" | "extracted" | "none";

  certCount: number;
}

const cacheDir = (): string => join(aveHome(), "certs");

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Key the extraction cache by common name so a changed setting cannot reuse old certificates.
function cachePathFor(commonName: string): string {
  const digest = sha256Hex(commonName).slice(0, 16);
  return join(cacheDir(), `corp-ca-${digest}.pem`);
}

function readCacheIfFresh(cachePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(cachePath, "r");
    const st = fstatSync(fd);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < CACHE_TTL_MS) {
      const content = readFileSync(fd, "utf-8");
      // Counted, not string-matched: a cache truncated by a power cut has the opening marker and nothing that parses, and re-extracting beats injecting it.
      if (countCertificates(content) > 0) {
        return content;
      }
    }
  } catch {
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  return null;
}

async function writeCacheSecure(pem: string, cachePath: string): Promise<void> {
  mkdirSync(cacheDir(), { recursive: true });
  const fd = await open(cachePath, "w", 0o600);
  try {
    await fd.writeFile(pem, "utf-8");
  } finally {
    await fd.close();
  }
}

// Child trust-file variables replace their default roots, so write the union of platform and corporate roots, not a corporate-only bundle.
// Remove stale bundles when no corporate CA remains; child processes cannot use in-process TLS injection.
export async function writeSubprocessTrustBundle(
  corporatePem: string | null,
  bundlePath: string = join(cacheDir(), "corp-ca.pem"),
): Promise<void> {
  if (!corporatePem) {
    await rm(bundlePath, { force: true });
    return;
  }
  await writeCacheSecure([...tls.rootCertificates, corporatePem].join("\n"), bundlePath);
}

// Use a fresh name-scoped cache or extract and refresh it; missing certificates and extraction failure return no PEM for callers to handle.
export async function ensureCorporateCa(
  config: CorpCaConfig = resolveCorpCaConfig(),
): Promise<CorporateCaResult> {
  const cachePath = cachePathFor(config.commonName);

  // 0. turned off — no acquisition, and no cache read either. Reading the
  // cache here would have made the switch a no-op on every machine that had
  // ever extracted a certificate, which is the failure the setting exists to
  // remove rather than one to reproduce.
  if (!config.enabled) {
    if (config.debugLog) {
      caLog.info("corporate CA acquisition is turned off in settings");
    }
    return { pem: null, path: cachePath, source: "none", certCount: 0 };
  }

  // 1. cache hit
  const cached = readCacheIfFresh(cachePath);
  if (cached) {
    caLog.info(`cache hit: ${cachePath} (${countCertificates(cached)} cert(s))`);
    return { pem: cached, path: cachePath, source: "cache", certCount: countCertificates(cached) };
  }

  // 2. extraction
  const pem = await extractCorporateCa(config);
  if (!pem) {
    return { pem: null, path: cachePath, source: "none", certCount: 0 };
  }

  // 3. write cache (async, non-blocking for caller flow)
  try {
    await writeCacheSecure(pem, cachePath);
    caLog.info(`extracted + cached: ${cachePath} (${countCertificates(pem)} cert(s))`);
  } catch (writeErr) {
    caLog.warn("cache write failed (non-fatal): %s", (writeErr as Error).message);
  }

  return { pem, path: cachePath, source: "extracted", certCount: countCertificates(pem) };
}

const log = createLogger("ave");

async function injectCorporateCa(config: CorpCaConfig) {
  try {
    const result = await ensureCorporateCa(config);
    // Child processes are pointed at the bundle whether or not there is a corporate certificate today: the no-certificate case is what clears a stale bundle
    // from a machine that used to have one.
    try {
      await writeSubprocessTrustBundle(result.pem);
    } catch (bundleErr) {
      caLog.warn("subprocess trust bundle write failed (non-fatal): %s", (bundleErr as Error).message);
    }
    if (!result.pem) {
      // The one line for "nothing was injected", whatever the reason — the setting is off, the platform has no reader, or no certificate in the trust store
      // carries the configured name.
      log.warn(
        "corporate CA not found — keeping default TLS verification. "
        + "If model calls fail with a certificate error on this network, set the "
        + "certificate name in Settings to the CN of your organization's root CA.",
      );
      return;
    }
    const ca = [...tls.rootCertificates, result.pem];
    // 1) undici (Node fetch / global dispatcher)
    setGlobalDispatcher(new Agent({ connect: { ca } }));
    // 2) https.globalAgent (legacy https.get / https.request)
    (https.globalAgent.options as Record<string, unknown>).ca = ca;

    log.info(`corporate CA injected: source=${result.source} certs=${result.certCount} path=${result.path}`);
  } catch (e) {
    // 주입 실패해도 앱은 계속 실행 (해외망에서는 기본 CA로 충분)
    log.error("corporate CA injection failed (non-fatal): %s", errorMessage(e));
  }
}

let corporateCaReady: Promise<void> | null = null;
// Inject once per process. The config is resolved by the caller, which is the only place that knows where this profile's settings file lives; the
// default covers callers with no profile to read (tests, and any future host that wants the environment-only behaviour).
export function ensureCorporateCaInjected(
  config: CorpCaConfig = resolveCorpCaConfig(),
): Promise<void> {
  corporateCaReady ??= injectCorporateCa(config);
  return corporateCaReady;
}
