import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { McpClient, type JsonRpcMessage, type JsonRpcResponse, type McpTransport } from "../../mcp/mcp-client.js";
import { MCP_SKILLS_EXTENSION, parseMcpSkill, type McpSkill } from "../../mcp/mcp-skills.js";
import { McpGovernance } from "../../mcp/mcp-governance.js";
import type { McpCapability } from "../../mcp/types.js";
import { ToolRegistry } from "../../tools/registry.js";

export function skillBundle(options: { uri?: string; body?: string; frontmatter?: Record<string, unknown>; files?: Record<string, string> } = {}) {
  const uri = options.uri ?? "skill://reports/SKILL.md";
  const root = uri.slice(0, -"SKILL.md".length);
  const frontmatter = { name: uri.split("/").at(-2) ?? "", description: "Prepare reports", ...options.frontmatter };
  const files = new Map([[uri, `---\n${stringify(frontmatter)}---\n${options.body ?? "Read references/guide.md."}\n`],
    ...Object.entries(options.files ?? { "references/guide.md": "Guide\n" }).map(([path, text]) => [root + path, text] as const)]);
  const skill = parseMcpSkill({ uri, frontmatter, resources: [...files].map(([uri, text]) => ({
    uri, digest: `sha256:${createHash("sha256").update(text).digest("hex")}`, size: Buffer.byteLength(text),
  })) });
  return { skill, files };
}

export class SkillServerTransport implements McpTransport {
  readonly kind = "stdio" as const;
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly files = new Map<string, string>();
  catalog: McpSkill[] = [];
  hidden: McpSkill[] = [];
  capabilities: Record<string, unknown> = { resources: {}, extensions: { [MCP_SKILLS_EXTENSION]: {} } };
  response: ((method: string, params: Record<string, unknown>) => unknown) | undefined;
  private alive = true;
  private receive: ((message: JsonRpcResponse) => void) | undefined;

  async open(): Promise<void> { this.alive = true; }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!("method" in message) || !("id" in message) || typeof message.method !== "string") return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.requests.push({ method: message.method, params });
    let result = this.response?.(message.method, params);
    if (result === undefined) {
      const complete = { resultType: "complete", ttlMs: 60_000, cacheScope: "private" };
      switch (message.method) {
        case "server/discover": result = { ...complete, supportedVersions: ["2026-07-28"], capabilities: this.capabilities, serverInfo: { name: "self-reported", version: "1" } }; break;
        case "tools/list": result = { ...complete, tools: [] }; break;
        case "resources/list": result = { ...complete, resources: [] }; break;
        case "resources/templates/list": result = { ...complete, resourceTemplates: [] }; break;
        case "skills/list": result = { ...complete, skills: this.catalog }; break;
        case "skills/get": result = { ...complete, skill: [...this.catalog, ...this.hidden].find((skill) => skill.uri === params.uri) }; break;
        case "resources/read": result = { ...complete, contents: [{ uri: params.uri, text: this.files.get(String(params.uri)) }] }; break;
        default: throw new Error(`Unexpected request: ${message.method}`);
      }
    }
    const reply = { jsonrpc: "2.0" as const, id: message.id, result };
    queueMicrotask(() => this.receive?.(reply));
  }

  publish(bundle: ReturnType<typeof skillBundle>): void {
    this.catalog = [bundle.skill];
    for (const [uri, text] of bundle.files) this.files.set(uri, text);
  }
  async close(): Promise<void> { this.alive = false; }
  isAlive(): boolean { return this.alive; }
  onMessage(handler: (message: JsonRpcResponse) => void): void { this.receive = handler; }
  onClose(_handler: (reason: string) => void): void {}
}

export async function connectedSkillClient(server: SkillServerTransport, id = "docs-server", allowedCapabilities: McpCapability[] = ["tools", "resources"]) {
  const governance = new McpGovernance("/nonexistent/skill-policy.json", { runtimeApprovals: new Map(), policy: {
    version: "1.0", defaultPolicy: "deny", servers: [{
      id, name: id, transport: "stdio", status: "approved", allowedCommands: ["node"], requiredAuth: "none", tlsRequired: false,
      allowedCapabilities, maxTools: 16, toolNamePrefix: id, connectionTimeoutMs: 5000, maxConcurrentRequests: 8,
    }], globalRules: { maxServersTotal: 10, blockedUrlPatterns: [], allowedUrlPatterns: [], policyRefreshIntervalMs: 60000 },
  } });
  const registry = new ToolRegistry();
  const client = new McpClient({ id, transport: "stdio", command: "node" }, governance, registry, globalThis.fetch, server);
  await client.connect();
  return { client, governance, registry };
}
