import type { StudioLintFinding } from "../shared/plugin-studio.js";

const TEXT_RULES: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  { pattern: /\b(?:ignore|override|disregard)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions\b/giu, message: "Overrides earlier instructions" },
  { pattern: /(?:~\/|\$HOME\/)(?:\.ave|\.ssh|\.aws)(?:\/|\b)|\bsecret\s+store\b/giu, message: "Requests private files or secrets" },
  { pattern: /\b(?:disable|bypass|turn\s+off)\s+(?:the\s+)?(?:approvals?|sandboxes?|hooks?)\b/giu, message: "Requests disabled safeguards" },
  { pattern: /\b(?:send|upload|post|email)\b[^\n]{0,100}(?:https?:\/\/[^\s)]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/giu, message: "Requests sending content to an address" },
];

export function studioConnectorWarning(value: string): string | undefined {
  return value.length >= 24 && /^[A-Za-z0-9+/=_-]+$/u.test(value) && new Set(value).size >= 12
    ? "Possible embedded credential" : undefined;
}

/** Findings are advisory and always include the exact matching text. */
export function lintStudioFiles(files: readonly { path: string; data: Buffer }[]): StudioLintFinding[] {
  const findings: StudioLintFinding[] = [];
  for (const file of files) {
    const textFile = /^skills\/.+\/SKILL\.md$/u.test(file.path)
      || /^ai\.agent-connector\.ave\/prompts\/.+\.md$/u.test(file.path)
      || file.path === "ai.agent-connector.ave/routines.json";
    if (textFile) {
      const text = file.data.toString("utf8");
      for (const rule of TEXT_RULES) {
        for (const match of text.matchAll(rule.pattern)) {
          findings.push({ path: file.path, matched: match[0], message: rule.message });
        }
      }
      if (/^ai\.agent-connector\.ave\/prompts\/.+\.md$/u.test(file.path) && /^\/\S/u.test(text.replace(/^---[\s\S]*?---\s*/u, ""))) {
        findings.push({ path: file.path, matched: text.replace(/^---[\s\S]*?---\s*/u, "").split("\n")[0]!, message: "Template begins with a slash command" });
      }
    }
    if (file.path === "mcp.json") {
      let value: unknown;
      try { value = JSON.parse(file.data.toString("utf8")); }
      catch { continue; }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const servers = (value as { mcpServers?: Record<string, { args?: string[]; env?: Record<string, string> }> }).mcpServers ?? {};
      for (const [name, server] of Object.entries(servers)) {
        for (const token of [...(server.args ?? []), ...Object.values(server.env ?? {})]) {
          const warning = studioConnectorWarning(token);
          if (warning) findings.push({ path: `mcp.json:${name}`, matched: token, message: warning });
        }
      }
    }
  }
  return findings;
}
