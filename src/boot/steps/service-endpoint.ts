/** Only unpackaged staging may use loopback HTTP overrides; keep staging move records separate from production. */
import { join } from "node:path";
import type { TelemetrySettings } from "../../data/settings-store.js";
import { AVE_SERVICE_BASE_URL, ServiceClient, readPolicyServiceBase } from "../../marketplace/service/client.js";
import { getAdminPolicyPath } from "../../permissions/policy-store.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { aveHome } from "../../shared/ave-home.js";
import { readDevelopmentEnvVar } from "../dev-flags.js";

/** Without telemetry consent, return null without reading the service document. */
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

export function createServiceClient(
  fetchImpl: typeof fetch,
  stagingBase = readDevelopmentEnvVar("AVE_SERVICE_BASE_URL"),
): ServiceClient {
  return new ServiceClient({
    fetchImpl,
    buildBase: stagingBase ?? AVE_SERVICE_BASE_URL,
    policyBase: () => readPolicyServiceBase(getAdminPolicyPath()),
    statePath: join(aveHome(), "marketplaces", stagingBase === undefined ? "service.json" : "service.staging.json"),
    appVersion: getAveAppVersion(),
    allowLoopbackHttp: stagingBase !== undefined,
  });
}
