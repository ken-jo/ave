import { describe, expect, it } from "vitest";
import { parseMcpRuntimeSpec } from "../mcp-runtime-spec.js";

const http = (oauth: unknown) => parseMcpRuntimeSpec({ transport: "http", url: "https://mcp.example.test/mcp", auth: "oauth", oauth });
const oauthOf = (oauth: unknown) => {
  const spec = http(oauth);
  return spec?.transport === "http" ? spec.oauth : undefined;
};

describe("parseMcpRuntimeSpec OAuth metadata", () => {
  it("keeps a pre-registered client ID, trimmed, with the registration mode", () => {
    expect(http({ clientId: "  ave-operator-client  ", clientRegistration: "preregistration" })).toEqual({
      transport: "http", url: "https://mcp.example.test/mcp", auth: "oauth",
      oauth: { clientId: "ave-operator-client", clientRegistration: "preregistration" },
    });
  });

  it("keeps an invalid client ID verbatim so the session can refuse it clearly", () => {
    expect(oauthOf({ clientId: "ave operator" })).toEqual({ clientId: "ave operator" });
  });

  it.each([
    ["blank", "   "],
    ["not a string", 42],
  ])("drops a %s client ID", (_label, clientId) => {
    expect(oauthOf({ clientId })).toBeUndefined();
  });

  it("leaves metadata without a client ID unchanged (backward compatible)", () => {
    expect(oauthOf({ scopes: ["tools"], clientRegistration: "dynamic" })).toEqual({ scopes: ["tools"], clientRegistration: "dynamic" });
  });
});
