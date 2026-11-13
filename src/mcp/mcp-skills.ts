// Wire contract pinned in docs/architecture/mcp-skills-resources.md.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { isRecord } from "../shared/is-record.js";
import { hasUnsafeUriChars } from "../shared/mcp-resource-bounds.js";

export const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
export const MCP_SKILLS_SPEC_COMMIT = "649f7aee87d631ac4d1fdd3b12eef0c6264fdb3a";
const MCP_SKILL_MAX_BYTES = 16 * 1024 * 1024;
const MCP_SKILL_MAX_RESOURCES = 512;

export interface McpSkillResource {
  readonly uri: string;
  readonly digest: string;
  readonly size: number;
}

export interface McpSkill {
  readonly uri: string;
  readonly frontmatter: Readonly<Record<string, unknown>> & { name: string; description: string };
  readonly resources: readonly McpSkillResource[] | "dynamic";
}

function isSkillResourceUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || hasUnsafeUriChars(value)) return false;
  try {
    const uri = new URL(value);
    if (uri.username || uri.password || uri.search || uri.hash || !uri.host) return false;
    const segments = value.slice(value.indexOf("://") + 3).split("/");
    return value.includes("://") && segments.every((segment) => {
      const decoded = decodeURIComponent(segment);
      if (decoded === "." || decoded === ".." || !decoded || decoded.includes("/") || decoded.includes("\\")) return false;
      for (const character of decoded) {
        const code = character.codePointAt(0) ?? 0;
        if (code <= 0x1f || code === 0x7f) return false;
      }
      return true;
    });
  } catch {
    return false;
  }
}

export function skillResourcePath(skillUri: string, uri: string): string {
  const prefix = skillUri.slice(0, -"SKILL.md".length);
  if (!isSkillResourceUri(uri) || !uri.startsWith(prefix)) throw new Error("Skill resource is outside its origin directory");
  return uri.slice(prefix.length);
}

export function parseMcpSkill(value: unknown): McpSkill {
  if (!isRecord(value) || !isSkillResourceUri(value.uri) || !value.uri.endsWith("/SKILL.md") || !isRecord(value.frontmatter)) {
    throw new Error("Invalid skill entry");
  }
  const { name, description } = value.frontmatter;
  if (typeof name !== "string" || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name) || name !== name.toLowerCase() || [...name].length > 64
    || typeof description !== "string" || !description.trim() || description.length > 1024
    || decodeURIComponent(value.uri.split("/").at(-2) ?? "") !== name) throw new Error("Invalid skill frontmatter");
  const frontmatter = Object.freeze(structuredClone(value.frontmatter)) as McpSkill["frontmatter"];
  if (value.resources === "dynamic") return Object.freeze({ uri: value.uri, frontmatter, resources: "dynamic" });
  if (!Array.isArray(value.resources) || value.resources.length === 0 || value.resources.length > MCP_SKILL_MAX_RESOURCES) {
    throw new Error("Invalid skill resource manifest");
  }
  const seen = new Set<string>();
  let total = 0;
  const resources = value.resources.map((file: unknown) => {
    if (!isRecord(file) || typeof file.uri !== "string" || typeof file.digest !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(file.digest) || typeof file.size !== "number"
      || !Number.isSafeInteger(file.size) || file.size < 0 || seen.has(file.uri)) throw new Error("Invalid skill resource manifest");
    skillResourcePath(value.uri as string, file.uri);
    seen.add(file.uri);
    total += file.size;
    if (total > MCP_SKILL_MAX_BYTES) throw new Error("Skill exceeds 16 MiB");
    return Object.freeze({ uri: file.uri, digest: file.digest, size: file.size });
  });
  if (!seen.has(value.uri)) throw new Error("Skill manifest is missing SKILL.md");
  return Object.freeze({ uri: value.uri, frontmatter, resources: Object.freeze(resources) });
}

// Order is immaterial; file additions, removals, size changes and rotations all change consent.
export function mcpSkillFingerprint(skill: McpSkill): string {
  if (skill.resources === "dynamic") throw new Error("Dynamic skills cannot be verified or approved");
  const files = [...skill.resources].sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

export function verifyMcpSkillRead(skill: McpSkill, uri: string, result: unknown): Buffer {
  if (skill.resources === "dynamic") throw new Error("Dynamic skills cannot be verified or approved");
  const file = skill.resources.find((entry) => entry.uri === uri);
  if (!file) throw new Error("Skill resource is not in the approved manifest");
  if (!isRecord(result) || !Array.isArray(result.contents) || result.contents.length !== 1) throw new Error("Invalid skill resource response");
  const content = result.contents[0];
  if (!isRecord(content) || content.uri !== uri || (typeof content.text === "string") === (typeof content.blob === "string")) {
    throw new Error("Invalid skill resource response");
  }
  if (typeof content.blob === "string" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content.blob)) {
    throw new Error("Invalid skill resource encoding");
  }
  const bytes = typeof content.text === "string" ? Buffer.from(content.text, "utf8") : Buffer.from(content.blob as string, "base64");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.length !== file.size || digest !== file.digest) throw new Error("Skill resource digest or size mismatch; reload the skill");
  return bytes;
}

export function mcpSkillText(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("Skill resource is not UTF-8 text");
  return text;
}

export function verifiedMcpSkillBody(skill: McpSkill, bytes: Buffer): string {
  const text = mcpSkillText(bytes);
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!match || match[1] === undefined || !isDeepStrictEqual(parseYaml(match[1]), skill.frontmatter)) throw new Error("Skill frontmatter mismatch");
  return text.slice(match[0].length).trim();
}
