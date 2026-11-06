import { HOST_PROTOCOL_VERSION } from "../../plugins/isolation/host-api-wire.js";

/** Only code plugins require a served host protocol. */
export function supportsHostProtocol(kind: string, hostProtocol: unknown): boolean {
  return kind !== "plugin" || hostProtocol === HOST_PROTOCOL_VERSION;
}
