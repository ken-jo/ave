import type { HostFetchTransport } from "../../main/host-fetch-guard.js";

/** Direct-call test transports hand headers off at invocation. */
export function directHostFetchTransport(fetchImpl: typeof fetch): HostFetchTransport {
  const transport = ((input, init) => fetchImpl(input, init)) as HostFetchTransport;
  transport.sendWithHandoff = (input, init, beforeSend) => {
    beforeSend();
    return fetchImpl(input, init);
  };
  return transport;
}
