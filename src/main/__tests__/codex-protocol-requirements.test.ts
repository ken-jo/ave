import { describe, expect, it } from "vitest";
import {
  CODEX_PROTOCOL_REQUIREMENTS,
  CODEX_SCHEMA_FILES,
  missingCodexProtocolRequirements,
} from "../codex-protocol-requirements.js";
import { completeCodexSchemas } from "../../__tests__/support/codex-protocol-schemas.js";

type Json = Record<string, any>;

function schemas(edit?: (documents: Record<string, Json>) => void) {
  const documents = completeCodexSchemas() as Record<string, Json>;
  edit?.(documents);
  return {
    clientRequest: documents[CODEX_SCHEMA_FILES.clientRequest],
    serverNotification: documents[CODEX_SCHEMA_FILES.serverNotification],
    serverRequest: documents[CODEX_SCHEMA_FILES.serverRequest],
  };
}

describe("app-server protocol requirements", () => {
  it("are all met by the schema 0.153.4 generates", () => {
    expect(missingCodexProtocolRequirements(schemas())).toEqual([]);
  });

  it("cover every request the client and the conversation runtime send", () => {
    expect(CODEX_PROTOCOL_REQUIREMENTS.clientRequests.map((entry) => entry.method)).toEqual([
      "initialize",
      "account/read",
      "account/login/start",
      "account/login/cancel",
      "account/logout",
      "model/list",
      "thread/start",
      "turn/start",
      "turn/interrupt",
      "windowsSandbox/readiness",
    ]);
  });

  it("names a missing request", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const client = documents[CODEX_SCHEMA_FILES.clientRequest]!;
      client.oneOf = client.oneOf.filter((variant: Json) => variant.properties.method.enum[0] !== "model/list");
    }));
    expect(result).toEqual(["request model/list"]);
  });

  it("names a missing field, following $ref and nullable unions", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const definitions = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions;
      delete definitions.ThreadStartParams.properties.environments;
      delete definitions.InitializeCapabilities.properties.experimentalApi;
    }));
    expect(result).toEqual([
      "request initialize.capabilities.experimentalApi",
      "request thread/start.environments",
    ]);
  });

  it("names a missing enum value and a missing tagged variant", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const definitions = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions;
      definitions.LoginAccountParams.oneOf = definitions.LoginAccountParams.oneOf
        .filter((variant: Json) => variant.properties.type.enum[0] !== "chatgptDeviceCode");
      definitions.UserInput.oneOf = definitions.UserInput.oneOf
        .filter((variant: Json) => variant.properties.type.enum[0] !== "localImage");
    }));
    expect(result).toEqual([
      "request account/login/start.type=chatgptDeviceCode",
      "request turn/start.input=localImage",
    ]);
  });

  it("names missing notifications and server requests", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const notifications = documents[CODEX_SCHEMA_FILES.serverNotification]!;
      notifications.oneOf = notifications.oneOf
        .filter((variant: Json) => variant.properties.method.enum[0] !== "turn/completed");
      const requests = documents[CODEX_SCHEMA_FILES.serverRequest]!;
      requests.oneOf = requests.oneOf
        .filter((variant: Json) => variant.properties.method.enum[0] !== "item/tool/call");
    }));
    expect(result).toEqual(["notification turn/completed", "server request item/tool/call"]);
  });

  it("refuses documents that are not schemas at all", () => {
    expect(missingCodexProtocolRequirements({
      clientRequest: null,
      serverNotification: {},
      serverRequest: {},
    })).toEqual(["schema documents"]);
  });
});
