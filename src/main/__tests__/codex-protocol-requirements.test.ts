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

  it("requires the read-only branch to declare its own network flag", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const policies = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.SandboxPolicy.oneOf;
      const readOnly = policies.find((variant: Json) => variant.properties.type.enum[0] === "readOnly");
      delete readOnly.properties.networkAccess;
    }));
    expect(result).toEqual(["request turn/start.sandboxPolicy.networkAccess"]);
  });

  it("requires the network flag to be boolean in the selected branch", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const policies = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.SandboxPolicy.oneOf;
      const readOnly = policies.find((variant: Json) => variant.properties.type.enum[0] === "readOnly");
      readOnly.properties.networkAccess.type = "string";
    }));
    expect(result).toEqual(["request turn/start.sandboxPolicy.networkAccess (type boolean)"]);
  });

  it("does not combine fields from duplicate branches with the same discriminator", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const policies = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.SandboxPolicy.oneOf;
      const readOnly = policies.find((variant: Json) => variant.properties.type.enum[0] === "readOnly");
      readOnly.properties.networkAccess = {
        oneOf: [{ type: "string" }, { type: "null" }],
      };
      policies.push({ type: "object", properties: { type: { type: "string", enum: ["readOnly"] } } });
    }));
    expect(result).toEqual(["request turn/start.sandboxPolicy.networkAccess (type boolean)"]);
  });

  it.each(["string", "integer", "array", "object", "null"])(
    "requires the ephemeral flag to admit boolean instead of %s",
    (type) => {
      const result = missingCodexProtocolRequirements(schemas((documents) => {
        documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.ThreadStartParams.properties.ephemeral = { type };
      }));
      expect(result).toEqual(["request thread/start.ephemeral (type boolean)"]);
    },
  );

  it("requires the exact boolean literals the client sends", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.ThreadStartParams.properties.ephemeral.enum = [false];
    }));
    expect(result).toEqual(["request thread/start.ephemeral=true"]);
  });

  it.each([
    { definition: "ThreadStartParams", field: "ephemeral", schema: { enum: ["yes"] }, type: "boolean", method: "thread/start" },
    { definition: "TurnStartParams", field: "threadId", schema: { const: 42 }, type: "string", method: "turn/start" },
    { definition: "TurnStartParams", field: "input", schema: { enum: ["text"] }, type: "array", method: "turn/start" },
  ])("checks $method.$field types expressed only through literals", ({ definition, field, schema, type, method }) => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions[definition].properties[field] = schema;
    }));
    expect(result).toEqual([`request ${method}.${field} (type ${type})`]);
  });

  it.each([
    { method: "initialize", definition: "ClientInfo", field: "version", type: "string", wrong: "boolean", path: "clientInfo.version" },
    { method: "initialize", definition: "InitializeCapabilities", field: "experimentalApi", type: "boolean", wrong: "string", path: "capabilities.experimentalApi" },
    { method: "account/read", definition: "GetAccountParams", field: "refreshToken", type: "boolean", wrong: "integer", path: "refreshToken" },
    { method: "account/login/cancel", definition: "CancelLoginAccountParams", field: "loginId", type: "string", wrong: "object", path: "loginId" },
    { method: "model/list", definition: "ModelListParams", field: "limit", type: "integer", wrong: "string", path: "limit" },
    { method: "model/list", definition: "ModelListParams", field: "includeHidden", type: "boolean", wrong: "array", path: "includeHidden" },
    { method: "thread/start", definition: "ThreadStartParams", field: "model", type: "string", wrong: "number", path: "model" },
    { method: "thread/start", definition: "ThreadStartParams", field: "cwd", type: "string", wrong: "boolean", path: "cwd" },
    { method: "turn/start", definition: "TurnStartParams", field: "threadId", type: "string", wrong: "integer", path: "threadId" },
    { method: "turn/interrupt", definition: "TurnInterruptParams", field: "turnId", type: "string", wrong: "boolean", path: "turnId" },
  ])("checks the emitted $type type of $method.$path", ({ method, definition, field, type, wrong, path }) => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions[definition].properties[field].type = wrong;
    }));
    expect(result).toEqual([`request ${method}.${path} (type ${type})`]);
  });

  it.each([
    { definition: "ThreadStartParams", method: "thread/start", field: "dynamicTools", type: "array" },
    { definition: "ThreadStartParams", method: "thread/start", field: "environments", type: "array" },
    { definition: "ThreadStartParams", method: "thread/start", field: "config", type: "object" },
    { definition: "TurnStartParams", method: "turn/start", field: "input", type: "array" },
    { definition: "TurnStartParams", method: "turn/start", field: "environments", type: "array" },
  ])("preserves the $type container around $method.$field", ({ definition, method, field, type }) => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions[definition].properties[field].type = "string";
    }));
    expect(result).toEqual([`request ${method}.${field} (type ${type})`]);
  });

  it.each([
    { tag: "text", field: "text", wrong: "boolean" },
    { tag: "localImage", field: "path", wrong: "array" },
  ])("checks the string content of the $tag input branch", ({ tag, field, wrong }) => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.UserInput.oneOf;
      variants.find((variant: Json) => variant.properties.type.enum[0] === tag).properties[field].type = wrong;
    }));
    expect(result).toEqual([`request turn/start.input.${field} (type string)`]);
  });

  it("does not obtain text content from another input branch", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.UserInput.oneOf;
      const text = variants.find((variant: Json) => variant.properties.type.enum[0] === "text");
      const image = variants.find((variant: Json) => variant.properties.type.enum[0] === "image");
      image.properties.text = text.properties.text;
      delete text.properties.text;
    }));
    expect(result).toEqual(["request turn/start.input.text"]);
  });

  it("checks map values in the configuration object", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.ThreadStartParams.properties.config.additionalProperties = { type: "string" };
    }));
    expect(result).toEqual(["request thread/start.config.include_permissions_instructions (type boolean)"]);
  });

  it.each([
    { definition: "DynamicToolSpec", tag: "function", field: "description", type: "string", wrong: "boolean", path: "dynamicTools.description" },
    { definition: "DynamicToolSpec", tag: "namespace", field: "name", type: "string", wrong: "number", path: "dynamicTools.name" },
    { definition: "DynamicToolSpec", tag: "namespace", field: "tools", type: "array", wrong: "object", path: "dynamicTools.tools" },
    { definition: "DynamicToolNamespaceTool", tag: "function", field: "description", type: "string", wrong: "array", path: "dynamicTools.tools.description" },
    { definition: "DynamicToolNamespaceTool", tag: "function", field: "deferLoading", type: "boolean", wrong: "string", path: "dynamicTools.tools.deferLoading" },
  ])("checks $path inside the $tag tool branch", ({ definition, tag, field, type, wrong, path }) => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions[definition].oneOf;
      variants.find((variant: Json) => variant.properties.type.enum[0] === tag).properties[field].type = wrong;
    }));
    expect(result).toEqual([`request thread/start.${path} (type ${type})`]);
  });

  it("requires arbitrary JSON content for a tool input schema", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.DynamicToolSpec.oneOf;
      variants.find((variant: Json) => variant.properties.type.enum[0] === "function").properties.inputSchema = { type: "object" };
    }));
    expect(result).toEqual(["request thread/start.dynamicTools.inputSchema (arbitrary JSON)"]);
  });

  it("keeps browser login fields on the browser login branch", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.LoginAccountParams.oneOf;
      const browser = variants.find((variant: Json) => variant.properties.type.enum[0] === "chatgpt");
      const device = variants.find((variant: Json) => variant.properties.type.enum[0] === "chatgptDeviceCode");
      for (const field of ["useHostedLoginSuccessPage", "appBrand"]) {
        device.properties[field] = browser.properties[field];
        delete browser.properties[field];
      }
    }));
    expect(result).toEqual([
      "request account/login/start.useHostedLoginSuccessPage",
      "request account/login/start.appBrand",
    ]);
  });

  it.each([
    { field: "useHostedLoginSuccessPage", type: "boolean", wrong: "string" },
    { field: "appBrand", type: "string", wrong: "boolean" },
  ])("checks the browser login $field type", ({ field, type, wrong }) => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.LoginAccountParams.oneOf;
      const browser = variants.find((variant: Json) => variant.properties.type.enum[0] === "chatgpt");
      browser.properties[field] = { type: wrong, ...(field === "appBrand" ? { enum: ["codex"] } : {}) };
    }));
    expect(result).toEqual([`request account/login/start.${field} (type ${type})`]);
  });

  it.each(["chatgpt", "chatgptDeviceCode"])("requires a string discriminator for %s login", (tag) => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.LoginAccountParams.oneOf;
      variants.find((variant: Json) => variant.properties.type.enum[0] === tag).properties.type.type = "number";
    }));
    expect(result).toEqual([`request account/login/start.type=${tag}`]);
  });

  it("rejects a newly required field that device login does not send", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.LoginAccountParams.oneOf;
      const device = variants.find((variant: Json) => variant.properties.type.enum[0] === "chatgptDeviceCode");
      device.properties.deviceId = { type: "string" };
      device.required.push("deviceId");
    }));
    expect(result).toEqual(["request account/login/start.deviceId (required)"]);
  });

  it("does not combine partial parameter branches", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const definitions = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions;
      const thread = definitions.ThreadStartParams;
      const ephemeral = thread.properties.ephemeral;
      delete thread.properties.ephemeral;
      definitions.ThreadStartParams = {
        oneOf: [thread, { type: "object", properties: { ephemeral } }],
      };
    }));
    expect(result).toEqual(["request thread/start.ephemeral"]);
  });

  it("preserves intersections instead of treating their constraints as alternatives", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.ThreadStartParams.properties.ephemeral = {
        allOf: [{ type: "boolean" }, { type: "string" }],
      };
    }));
    expect(result).toEqual(["request thread/start.ephemeral (type boolean)"]);
  });

  it("accepts fields jointly declared by intersecting object schemas", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const policies = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.SandboxPolicy.oneOf;
      const readOnly = policies.find((variant: Json) => variant.properties.type.enum[0] === "readOnly");
      const { type, networkAccess } = readOnly.properties;
      readOnly.properties = {};
      readOnly.allOf = [
        { type: "object", properties: { type } },
        { type: "object", properties: { networkAccess } },
      ];
    }));
    expect(result).toEqual([]);
  });

  it("retains constraints beside a schema reference", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const definitions = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions;
      definitions.EphemeralFlag = { type: "boolean" };
      definitions.ThreadStartParams.properties.ephemeral = { $ref: "#/definitions/EphemeralFlag", type: "string" };
    }));
    expect(result).toEqual(["request thread/start.ephemeral (type boolean)"]);
  });

  it("rejects overlapping exclusive alternatives", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.ThreadStartParams.properties.cwd = {
        oneOf: [{ type: "string" }, { type: "string" }],
      };
    }));
    expect(result).toEqual(["request thread/start.cwd (exclusive union)"]);
  });

  it("retains exclusive alternatives across request envelopes", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const client = documents[CODEX_SCHEMA_FILES.clientRequest]!;
      client.oneOf.push(structuredClone(client.oneOf.find((variant: Json) => variant.properties.method.enum[0] === "thread/start")));
    }));
    expect(result).toEqual(["request thread/start (exclusive union)"]);
  });

  it("accepts overlapping inclusive alternatives", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.ThreadStartParams.properties.cwd = {
        anyOf: [{ type: "string" }, { type: "string" }],
      };
    }));
    expect(result).toEqual([]);
  });

  it("accepts a valid inclusive branch beside an unusable exclusive branch", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.ThreadStartParams.properties.cwd = {
        anyOf: [
          { oneOf: [{ type: "string" }, { type: "string" }] },
          { type: "string" },
        ],
      };
    }));
    expect(result).toEqual([]);
  });

  it("checks both values of an unrestricted boolean field across exclusive branches", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.definitions.DynamicToolNamespaceTool.oneOf;
      variants[0].properties.deferLoading = { oneOf: [{ const: true }, { const: false }] };
    }));
    expect(result).toEqual([]);
  });

  it.each(["account/logout", "windowsSandbox/readiness"])("rejects new required parameters for %s", (method) => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.oneOf;
      variants.find((variant: Json) => variant.properties.method.enum[0] === method).required.push("params");
    }));
    expect(result).toEqual([`request ${method}.params (required)`]);
  });

  it.each(["thread/start", "account/logout"])("checks the emitted numeric id for the %s envelope", (method) => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const variants = documents[CODEX_SCHEMA_FILES.clientRequest]!.oneOf;
      variants.find((variant: Json) => variant.properties.method.enum[0] === method).properties.id = { type: "boolean" };
    }));
    expect(result).toEqual([`request ${method}.id (type integer)`]);
  });

  it.each([false, true])("checks required envelope fields through a reference: %s", (referenced) => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const client = documents[CODEX_SCHEMA_FILES.clientRequest]!;
      const index = client.oneOf.findIndex((variant: Json) => variant.properties.method.enum[0] === "thread/start");
      const thread = client.oneOf[index];
      thread.properties.context = { type: "string" };
      thread.required.push("context");
      if (referenced) {
        client.definitions.ThreadStartEnvelope = thread;
        client.oneOf[index] = { $ref: "#/definitions/ThreadStartEnvelope" };
      }
    }));
    expect(result).toEqual(["request thread/start.context (required)"]);
  });

  it("checks an id type behind an envelope field reference", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const client = documents[CODEX_SCHEMA_FILES.clientRequest]!;
      const thread = client.oneOf.find((variant: Json) => variant.properties.method.enum[0] === "thread/start");
      client.definitions.EnvelopeId = { type: "boolean" };
      thread.properties.id = { $ref: "#/definitions/EnvelopeId" };
    }));
    expect(result).toEqual(["request thread/start.id (type integer)"]);
  });

  it("rejects a non-string method even when its literal matches", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const client = documents[CODEX_SCHEMA_FILES.clientRequest]!;
      const thread = client.oneOf.find((variant: Json) => variant.properties.method.enum[0] === "thread/start");
      client.definitions.ThreadStartMethod = { type: "boolean", enum: ["thread/start"] };
      thread.properties.method = { $ref: "#/definitions/ThreadStartMethod" };
    }));
    expect(result).toEqual(["request thread/start"]);
  });

  it("does not combine an id from one envelope branch with missing required fields in another", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const client = documents[CODEX_SCHEMA_FILES.clientRequest]!;
      const index = client.oneOf.findIndex((variant: Json) => variant.properties.method.enum[0] === "thread/start");
      const invalidId = client.oneOf[index];
      const missingContext = structuredClone(invalidId);
      invalidId.properties.id = { type: "boolean" };
      missingContext.properties.context = { type: "string" };
      missingContext.required.push("context");
      client.oneOf[index] = { oneOf: [invalidId, missingContext] };
    }));
    expect(result).toEqual(["request thread/start.id (type integer)"]);
  });

  it("selects a complete envelope before checking exclusive overlap", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const client = documents[CODEX_SCHEMA_FILES.clientRequest]!;
      const index = client.oneOf.findIndex((variant: Json) => variant.properties.method.enum[0] === "thread/start");
      const valid = client.oneOf[index];
      const invalid = structuredClone(valid);
      invalid.properties.id = { type: "boolean" };
      client.oneOf[index] = { oneOf: [invalid, valid] };
    }));
    expect(result).toEqual([]);
  });

  it("accepts a referenced complete envelope with a number id schema", () => {
    const result = missingCodexProtocolRequirements(schemas((documents) => {
      const client = documents[CODEX_SCHEMA_FILES.clientRequest]!;
      const index = client.oneOf.findIndex((variant: Json) => variant.properties.method.enum[0] === "thread/start");
      const thread = client.oneOf[index];
      thread.properties.id = { type: "number" };
      client.definitions.ThreadStartEnvelope = thread;
      client.oneOf[index] = { $ref: "#/definitions/ThreadStartEnvelope" };
    }));
    expect(result).toEqual([]);
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
