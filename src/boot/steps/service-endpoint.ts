/**
 * The app's service endpoint client (design §11): the managed policy's
 * `service.baseUrl`, else the build constant. An unpackaged build may point it
 * at a staging base with `AVE_SERVICE_BASE_URL`, which may then be plain http
 * on a loopback host; a packaged build never reads that variable. A staging
 * run keeps its move record in its own file, so it never drops the move a
 * production build accepted.
 */
import { join } from "node:path";
import type { TelemetrySettings } from "../../data/settings-store.js";
import { AVE_SERVICE_BASE_URL, ServiceClient, readPolicyServiceBase } from "../../marketplace/service/client.js";
import { getAdminPolicyPath } from "../../permissions/policy-store.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { aveHome } from "../../shared/ave-home.js";
import { readDevelopmentEnvVar } from "../dev-flags.js";

/**
 * The telemetry client's endpoint source (design §11): the service document is
 * read for telemetry only for a user who opted in — now, when they already
 * have, and otherwise at the first event or flush after they do. Without
 * consent it answers null and never touches the service.
 */
export function consentedTelemetryEndpoint(
  settings: () => TelemetrySettings,
  service: Pick<ServiceClient, "ensureResolved" | "telemetryEndpoint">,
): () => string | null | undefined {
  const allowed = () => {
    const current = settings();
    return current.telemetryPromptAnswered === true && current.enabled === true;
  };
  if (allowed()) service.ensureResolved();
  return () => {
    if (!allowed()) return null;
    service.ensureResolved();
    return service.telemetryEndpoint();
  };
}

export function createServiceClient(fetchImpl: typeof fetch, stagingBase = readDevelopmentEnvVar("AVE_SERVICE_BASE_URL")): ServiceClient {
  return new ServiceClient({
    fetchImpl,
    buildBase: stagingBase ?? AVE_SERVICE_BASE_URL,
    policyBase: () => readPolicyServiceBase(getAdminPolicyPath()),
    statePath: join(aveHome(), "marketplaces", stagingBase === undefined ? "service.json" : "service.staging.json"),
    appVersion: getAveAppVersion(),
    allowLoopbackHttp: stagingBase !== undefined,
  });
}
