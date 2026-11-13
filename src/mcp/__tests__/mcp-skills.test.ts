import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ok as assertPresent } from "node:assert/strict";
import { connectedSkillClient, skillBundle, SkillServerTransport } from "../../__tests__/support/mcp-skills-server.js";
import { MCP_SKILLS_EXTENSION, parseMcpSkill, verifyMcpSkillRead, verifiedMcpSkillBody, mcpSkillFingerprint } from "../mcp-skills.js";
import type { McpClient } from "../mcp-client.js";

const clients: McpClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.disconnect())); vi.useRealTimers(); });
async function connect(server: SkillServerTransport, capabilities?: Parameters<typeof connectedSkillClient>[2]) {
  const result = await connectedSkillClient(server, "docs-server", capabilities);
  clients.push(result.client);
  return result;
}

describe("skill transport discovery and integrity", () => {
  it("discovers metadata without reading files and stamps request metadata", async () => {
    const server = new SkillServerTransport();
    server.publish(skillBundle());
    const { client } = await connect(server);
    expect(client.getSkillEntries()).toEqual(server.catalog);
    expect(server.requests.some((request) => request.method === "resources/read")).toBe(false);
    const request = server.requests.find((request) => request.method === "skills/list");
    assertPresent(request);
    expect(request.params._meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" });
    const [skill] = client.getSkillEntries();
    assertPresent(skill);
    const bytes = await client.readSkillResource(skill, skill.uri);
    expect(verifiedMcpSkillBody(skill, bytes)).toBe("Read references/guide.md.");
    expect(server.requests.some((request) => request.method === "skills/get")).toBe(false);
  });

  it.each(["extension", "resources", "approval"])("does not discover or read without %s", async (missing) => {
    const server = new SkillServerTransport();
    const bundle = skillBundle(); server.publish(bundle);
    if (missing === "extension") server.capabilities = { resources: {} };
    if (missing === "resources") server.capabilities = { extensions: { [MCP_SKILLS_EXTENSION]: {} } };
    const { client } = await connect(server, missing === "approval" ? ["tools"] : undefined);
    expect(client.getSkillEntries()).toEqual([]);
    await expect(client.getSkill(bundle.skill.uri)).rejects.toThrow();
    expect(server.requests.filter((request) => request.method.startsWith("skills/"))).toEqual([]);
  });

  it("pages entries and can resolve a URI absent from a partial listing", async () => {
    const server = new SkillServerTransport();
    const a = skillBundle();
    const b = skillBundle({ uri: "skill://nested/other/SKILL.md" });
    server.publish(a);
    server.hidden = [b.skill];
    for (const [uri, text] of b.files) server.files.set(uri, text);
    server.response = (method, params) => method === "skills/list"
      ? { resultType: "complete", ttlMs: 1, cacheScope: "public", skills: params.cursor ? [] : [a.skill], ...(params.cursor ? {} : { nextCursor: "next" }) } : undefined;
    const { client } = await connect(server);
    expect(server.requests.filter((request) => request.method === "skills/list")).toHaveLength(2);
    expect(await client.getSkill(b.skill.uri)).toEqual(b.skill);
    expect(await client.readSkillResource(b.skill, b.skill.uri)).toBeInstanceOf(Buffer);
  });

  it("rejects a pagination cycle and a malformed response envelope", async () => {
    const server = new SkillServerTransport();
    server.response = (method) => method === "skills/list" ? { resultType: "complete", ttlMs: 1, cacheScope: "public", skills: [], nextCursor: "cycle" } : undefined;
    const { client } = await connect(server);
    expect(client.getSkillEntries()).toEqual([]);
    expect(server.requests.filter((request) => request.method === "skills/list")).toHaveLength(2);
    server.response = (method) => method === "skills/get" ? { skill: skillBundle().skill } : undefined;
    await expect(client.getSkill("skill://reports/SKILL.md")).rejects.toThrow("envelope");
  });

  it("fails closed after capability expiry when discovery is unavailable", async () => {
    const server = new SkillServerTransport(); const bundle = skillBundle(); server.publish(bundle);
    const { client } = await connect(server);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60001);
    server.send = async () => { throw new Error("offline"); };
    await expect(client.getSkill(bundle.skill.uri)).rejects.toThrow("advertise");
  });

  it.each(["digest", "size", "uri", "binary"])("rejects %s mismatch without returning unverified bytes", async (kind) => {
    const server = new SkillServerTransport(); const bundle = skillBundle(); server.publish(bundle);
    const { client } = await connect(server);
    const sourceText = bundle.files.get(bundle.skill.uri);
    assertPresent(sourceText);
    server.response = (method, params) => method === "resources/read" ? { contents: [{
      uri: kind === "uri" ? "skill://attacker/SKILL.md" : params.uri,
      ...(kind === "binary" ? { blob: "!!!!" } : { text: kind === "size" ? "short" : sourceText.replace("Read", "Evil") }),
    }] } : undefined;
    await expect(client.readSkillResource(bundle.skill, bundle.skill.uri)).rejects.toThrow();
    expect(client.getSkillEntries()).toEqual([]);
  });

  it("rejects unlisted files before transport and clears entries on disconnect", async () => {
    const server = new SkillServerTransport(); const bundle = skillBundle(); server.publish(bundle);
    const { client } = await connect(server);
    const count = server.requests.length;
    await expect(client.readSkillResource(bundle.skill, "skill://reports/unknown.sh")).rejects.toThrow("manifest");
    expect(server.requests).toHaveLength(count);
    await client.disconnect(); expect(client.getSkillEntries()).toEqual([]);
  });
});

describe("skill entry validation", () => {
  it.each(["écriture", "日本語", "보고서"])("accepts the format's lowercase Unicode skill name %s", (name) => {
    const { skill } = skillBundle({ uri: `skill://${name}/SKILL.md` });
    expect(skill.frontmatter.name).toBe(name);
  });
  it("matches the released specification's independent UTF-8 digest example", () => {
    const text = "# Invoice\n\nCustomer:\nAmount:\n";
    const { skill } = skillBundle();
    const entry = { ...skill, resources: [{ uri: skill.uri, size: 29, digest: "sha256:61f4ea6d2c75fde1b4977219e7e3107d491c3c26aefb6686e84d6281c088d9ee" }] };
    expect(verifyMcpSkillRead(entry, skill.uri, { contents: [{ uri: skill.uri, text }] })).toEqual(Buffer.from(text));
  });
  it("compares every frontmatter field after byte verification", () => {
    const bundle = skillBundle({ frontmatter: { metadata: { nested: { value: 1 } }, "allowed-tools": "bash" } });
    const content = bundle.files.get(bundle.skill.uri);
    assertPresent(content);
    const bytes = verifyMcpSkillRead(bundle.skill, bundle.skill.uri, { contents: [{ uri: bundle.skill.uri, text: content }] });
    expect(() => verifiedMcpSkillBody({ ...bundle.skill, frontmatter: { ...bundle.skill.frontmatter, metadata: { nested: { value: 2 } } } }, bytes)).toThrow("frontmatter");
  });

  it.each(["../escape", "%2e%2e/escape", "a/%2fetc", "a\\escape", "a/%00secret"])("rejects malicious manifest path %s", (path) => {
    const { skill } = skillBundle();
    expect(() => parseMcpSkill({ ...skill, resources: [...skill.resources as unknown[], { uri: `skill://reports/${path}`, digest: `sha256:${"0".repeat(64)}`, size: 0 }] })).toThrow();
  });

  it("accepts the full resource count and byte budget", () => {
    const { skill } = skillBundle();
    const resources = Array.from({ length: 512 }, (_, index) => ({ uri: index ? `skill://reports/deep/${index}.bin` : skill.uri,
      size: index ? 0 : 16777216, digest: `sha256:${"0".repeat(64)}` }));
    expect(parseMcpSkill({ ...skill, resources }).resources).toHaveLength(512);
    expect(() => parseMcpSkill({ ...skill, resources: [...resources, resources[0]] })).toThrow();
    expect(() => parseMcpSkill({ ...skill, resources: [{ ...resources[0], size: 16777217 }] })).toThrow();
  });

  it("binds consent to all files independent of ordering and rejects dynamic skills", () => {
    const { skill } = skillBundle();
    const resources = skill.resources as Exclude<typeof skill.resources, string>;
    expect(mcpSkillFingerprint(skill)).toBe(mcpSkillFingerprint({ ...skill, resources: [...resources].reverse() }));
    expect(mcpSkillFingerprint(skill)).not.toBe(mcpSkillFingerprint({ ...skill, resources: resources.slice(0, 1) }));
    expect(() => mcpSkillFingerprint(parseMcpSkill({ ...skill, resources: "dynamic" }))).toThrow("Dynamic");
    expect(() => parseMcpSkill({ ...skill, resources: [resources[0], resources[0]] })).toThrow();
    expect(() => parseMcpSkill({ ...skill, resources: undefined })).toThrow();
  });

  it("verifies binary resource bytes before decoding text", () => {
    const bytes = Buffer.from("한글\n");
    const { skill } = skillBundle();
    const entry = { ...skill, resources: [{ uri: skill.uri, size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }] };
    expect(verifyMcpSkillRead(entry, skill.uri, { contents: [{ uri: skill.uri, blob: bytes.toString("base64") }] })).toEqual(bytes);
  });
});
