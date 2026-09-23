/**
 * The app's service endpoint client (design §11): the managed policy's
 * `service.baseUrl`, else the build constant. An unpackaged build may point it
 * at a staging base with `AVE_SERVICE_BASE_URL`, which may then be plain http
 * on a loopback host; a packaged build never reads that variable.
 */
import { join } from "node:path";
import { AVE_SERVICE_BASE_URL, ServiceClient, readPolicyServiceBase } from "../../marketplace/service/client.js";
import { getAdminPolicyPath } from "../../permissions/policy-store.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { aveHome } from "../../shared/ave-home.js";
import { readDevelopmentEnvVar } from "../dev-flags.js";

export function createServiceClient(fetchImpl: typeof fetch): ServiceClient {
  const stagingBase = readDevelopmentEnvVar("AVE_SERVICE_BASE_URL");
  return new ServiceClient({
    fetchImpl,
    buildBase: stagingBase ?? AVE_SERVICE_BASE_URL,
    policyBase: () => readPolicyServiceBase(getAdminPolicyPath()),
    statePath: join(aveHome(), "marketplaces", "service.json"),
    appVersion: getAveAppVersion(),
    allowLoopbackHttp: stagingBase !== undefined,
  });
}
