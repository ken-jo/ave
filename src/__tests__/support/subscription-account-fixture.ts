import type { SubscriptionEvidenceSink } from "../../main/subscription-connection-evidence.js";

interface AccountFixtureStatus {
  connection: string;
  version: string | null;
  planType?: string | null;
}

function isAccountStatus(value: unknown): value is AccountFixtureStatus {
  return typeof value === "object" && value !== null && "connection" in value && "version" in value;
}

/** Simulates receipt delivery for service tests that supply account status instead of spawning a client. */
export function subscriptionAccountFixture<T extends object>(client: T): T {
  const adapter: T & { connectionEvidence?: SubscriptionEvidenceSink } = Object.create(client);
  for (const method of ["getStatus", "cancelLogin", "logout", "verify", "listModels"] as const) {
    const operation = Reflect.get(client, method);
    if (typeof operation !== "function") continue;
    Reflect.set(adapter, method, async (...args: unknown[]) => {
      const sink = adapter.connectionEvidence;
      const evidence = { kind: "read" as const, source: adapter, artifact: null, version: null as string | null };
      const receipt = method !== "logout" && sink?.(evidence);
      let result: unknown;
      try {
        result = await Reflect.apply(operation, adapter, args);
      } catch (error) {
        if (method === "getStatus" && receipt) receipt({ kind: "unavailable" });
        throw error;
      }
      if (method === "logout") sink?.({ kind: "logout", source: adapter });
      const status = method === "listModels" && result && typeof result === "object" && "status" in result ? result.status : result;
      if (receipt && isAccountStatus(status)) {
        evidence.version = status.version;
        if (status.connection === "connected") receipt({ kind: "connected", ...(status.planType !== undefined ? { planType: status.planType } : {}) });
        else if (status.connection === "signed-out") receipt({ kind: "signed-out" });
        else if (status.connection === "unknown") receipt({ kind: "unavailable" });
      }
      return result;
    });
  }
  return adapter;
}
