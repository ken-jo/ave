/**
 * Azure AI Foundry endpoint validation (HTTPS + approved Azure suffix + DNS
 * label shape) for the chat `azure-foundry` vendor's endpoint setting.
 */
import { describe, it, expect } from "vitest";
import { validateFoundryEndpoint } from "../reviewer/foundry-endpoint.js";

// ─── validateFoundryEndpoint ─────────────────────────────────────────

describe("validateFoundryEndpoint", () => {
  it("accepts https://<subdomain>.services.ai.azure.com", () => {
    expect(() => validateFoundryEndpoint("https://proj.services.ai.azure.com")).not.toThrow();
  });

  it("accepts https://<resource>.openai.azure.com", () => {
    expect(() => validateFoundryEndpoint("https://myresource.openai.azure.com")).not.toThrow();
  });

  it("rejects HTTP endpoints", () => {
    expect(() => validateFoundryEndpoint("http://proj.services.ai.azure.com")).toThrow(/HTTPS/);
  });

  it("rejects non-azure.com hostnames", () => {
    expect(() => validateFoundryEndpoint("https://attacker.example.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });

  it("rejects invalid URL strings", () => {
    expect(() => validateFoundryEndpoint("not-a-url")).toThrow(/valid URL/);
  });

  it("rejects bare azure.com (m2: no longer accepted as endpoint)", () => {
    // Previously accepted by the broad .azure.com suffix; now rejected since
    // bare azure.com is not a valid Foundry project endpoint.
    expect(() => validateFoundryEndpoint("https://azure.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });

  it("rejects subdomain of azure.com that is not .services.ai or .openai (m2: narrowed)", () => {
    // e.g. management.azure.com — was accepted before, now rejected
    expect(() => validateFoundryEndpoint("https://management.azure.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });
});

// ─── LOW-1: validateFoundryEndpoint subdomain regex ───────────────────

describe("validateFoundryEndpoint (LOW-1 — subdomain regex tightening)", () => {
  it("accepts multi-label subdomain (e.g. a.b.services.ai.azure.com)", () => {
    expect(() => validateFoundryEndpoint("https://a.b.services.ai.azure.com")).not.toThrow();
  });

  it("rejects bare services.ai.azure.com without subdomain prefix (fails suffix check)", () => {
    // hostname = "services.ai.azure.com" does NOT end with ".services.ai.azure.com"
    // (the suffix starts with a dot), so this is rejected by the suffix check, not
    // the subdomain regex. The error is still a validation failure.
    expect(() => validateFoundryEndpoint("https://services.ai.azure.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });

  it("rejects bare openai.azure.com without subdomain prefix (fails suffix check)", () => {
    // hostname = "openai.azure.com" does NOT end with ".openai.azure.com"
    expect(() => validateFoundryEndpoint("https://openai.azure.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });

  it("rejects subdomain with leading hyphen (LOW-1 DNS label validation)", () => {
    expect(() => validateFoundryEndpoint("https://-bad.services.ai.azure.com")).toThrow(/invalid subdomain/);
  });

  it("rejects subdomain with trailing hyphen (LOW-1 DNS label validation)", () => {
    expect(() => validateFoundryEndpoint("https://bad-.services.ai.azure.com")).toThrow(/invalid subdomain/);
  });

  it("accepts valid subdomain with hyphens", () => {
    expect(() => validateFoundryEndpoint("https://my-project-123.services.ai.azure.com")).not.toThrow();
  });
});
