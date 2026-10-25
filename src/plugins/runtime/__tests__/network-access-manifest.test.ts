/** Real host-schema validation must accept declared network access without relaxing unknown-field rejection. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";
import { pluginManifestWriter } from "../../__tests__/test-helpers.js";

describe("manifest networkAccess (Tier A) — host-owned schema validator path", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "network-access-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const writeManifest = pluginManifestWriter(
    { id: "network-access-test", name: "Network Access Test" },
    () => workDir,
  );

  it("accepts a well-formed networkAccess manifest (meeting/samplemail shape)", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      networkAccess: {
        allowedDomains: ["openai.azure.com", "api.openai.com"],
        reasoning: "STT transcription egress via host-mediated fetch.",
      },
    });
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.networkAccess?.allowedDomains).toEqual([
      "openai.azure.com",
      "api.openai.com",
    ]);
  });

  it("normalizes networkAccess.allowedDomains at manifest load", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      networkAccess: {
        allowedDomains: [".API.EXAMPLE.COM", "api.example.com"],
        reasoning: "Host-mediated API access.",
      },
    });
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.networkAccess?.allowedDomains).toEqual(["api.example.com"]);
  });

  it("carries the loopback literals through load-time normalization", async () => {
    // Loopback literals must survive normalization; the fetch guard still decides reachability.
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      networkAccess: {
        allowedDomains: ["localhost", "127.0.0.1", "[::1]", "api.example.com"],
        reasoning: "A local inference server the user configures.",
      },
    });
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.networkAccess?.allowedDomains).toEqual([
      "localhost",
      "127.0.0.1",
      "::1",
      "api.example.com",
    ]);
  });

  it("rejects a bare public-suffix domain ('com')", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({ networkAccess: { allowedDomains: ["com"] } });
    await expect(parsePluginJson(path, validator)).rejects.toThrow();
  });

  it("rejects networkAccess missing allowedDomains", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({ networkAccess: { reasoning: "no domains" } });
    await expect(parsePluginJson(path, validator)).rejects.toThrow();
  });

  it("still rejects an unknown top-level property (additionalProperties intact)", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({ bogusUnknownField: 123 });
    await expect(parsePluginJson(path, validator)).rejects.toThrow();
  });

  it("accepts networkAccess.authCookiePartition and carries it through load", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      networkAccess: {
        allowedDomains: ["portal.example.com"],
        reasoning: "Portal REST via host-mediated fetch.",
        authCookiePartition: "portal",
      },
    });
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.networkAccess?.authCookiePartition).toBe("portal");
  });

  it("rejects an authCookiePartition carrying a colon (partition-namespace escape)", async () => {
    // Declare only the partition suffix; colons could append segments to the host-composed auth partition.
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      networkAccess: {
        allowedDomains: ["portal.example.com"],
        authCookiePartition: "portal:extra",
      },
    });
    await expect(parsePluginJson(path, validator)).rejects.toThrow();
  });

  it("rejects an empty authCookiePartition", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      networkAccess: {
        allowedDomains: ["portal.example.com"],
        authCookiePartition: "",
      },
    });
    await expect(parsePluginJson(path, validator)).rejects.toThrow();
  });
});
