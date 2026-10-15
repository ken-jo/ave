/** Static component authority for a tree-delivered agent plugin. */
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { parseAgentFrontmatter } from "../../main/agent-profile-store.js";
import { parseFrontmatter, parseFrontmatterBlock } from "../../main/skill-store.js";
import { parsePortableMcp, projectPortableMcp, type BundledMcpAuth } from "../../mcp/portable-mcp.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import type { AgentPluginComponents } from "../catalog/types.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MarketplaceError } from "../errors.js";
import { parseAgentPluginManifest, type AgentPluginManifestIdentity } from "../../plugins/agent-plugin-manifest.js";
import type { AgentPluginRoutineTemplate } from "../../shared/agent-plugin-routine-template.js";
import type { RoutineSchedule, RoutineRepeat } from "../../shared/routines-types.js";
import { isValidCronExpression } from "../../routines/cron-evaluator.js";
import { parseHookConfig } from "../../hooks/hook-config.js";
import { validateSymbolicHookArgv } from "../../plugins/resolve-bundled-argv.js";
import { MAX_CRON_EXPR_LENGTH, MAX_FUTURE_OFFSET_MS, MIN_INTERVAL_MS } from "../../main/routines-store.js";

export interface AgentPluginFile {
  path: string;
  data: Buffer;
  executable?: boolean;
}

const COMPONENT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const PROMPT_PATH = /^ai\.agent-connector\.ave\/prompts\/([a-z][a-z0-9-]{0,62})\.md$/u;
const AGENT_PATH = /^ai\.agent-connector\.ave\/agents\/([a-z][a-z0-9-]{0,62})\/AGENTS\.md$/u;
const SKILL_PATH = /^skills\/([a-z][a-z0-9-]{0,62})\//u;

function fail(path: string, reason: string): never {
  throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${path}: ${reason}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function json(bytes: Buffer, path: string): Record<string, unknown> {
  try {
    return record(parseStrictJson(bytes.toString("utf8")), path);
  } catch (error) {
    fail(path, `does not parse: ${(error as Error).message}`);
  }
}

function requiredString(value: unknown, path: string, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(path, `${field} must be a nonempty single-line string`);
  }
  return value as string;
}

function fileDigest(files: readonly AgentPluginFile[]): string {
  return sha256Hex(files.map(({ path, data }) => `${path}\0${sha256Hex(data)}`).sort().join("\n"));
}

function packageFileReferences(value: unknown, files: ReadonlyMap<string, Buffer>, referenced: Set<string>): void {
  if (typeof value === "string") {
    const path = value.startsWith("${PLUGIN_ROOT}/") ? value.slice("${PLUGIN_ROOT}/".length)
      : value.startsWith("./") ? value.slice(2) : null;
    if (path !== null && files.has(path)) referenced.add(path);
  } else if (Array.isArray(value)) {
    for (const part of value) packageFileReferences(part, files, referenced);
  } else if (typeof value === "object" && value !== null) {
    for (const part of Object.values(value)) packageFileReferences(part, files, referenced);
  }
}

function mcpDigest(server: unknown, files: ReadonlyMap<string, Buffer>, executable: ReadonlySet<string> = new Set()): string {
  const referenced = new Set<string>();
  packageFileReferences(server, files, referenced);
  const fileTokens = [...referenced].sort().map((path) => `${path}\0${executable.has(path) ? "x" : "-"}\0${sha256Hex(files.get(path)!)}`);
  return sha256Hex(`${canonicalStringify(server)}\n${fileTokens.join("\n")}`);
}

export function parsePackagePrompt(bytes: Buffer, path: string, basename: string): { kind: "template" | "persona"; name: string } {
  const { fields, block, body } = parseFrontmatterBlock(bytes.toString("utf8"));
  const values = new Map(fields);
  const names = block.split(/\r?\n/u).flatMap((line) => {
    const match = /^([A-Za-z0-9_-]+)\s*:/u.exec(line);
    return match ? [match[1]!] : [];
  });
  if (new Set(names).size !== names.length) fail(path, "duplicate frontmatter field");
  for (const key of values.keys()) if (!["name", "description", "kind", "argumentHint", "ave-origin", "ave-authored-by"].includes(key)) fail(path, `unknown frontmatter field ${key}`);
  const name = requiredString(values.get("name"), path, "name", 63);
  requiredString(values.get("description"), path, "description", 500);
  if (name !== basename || !COMPONENT_NAME.test(name)) fail(path, "name must match the file name");
  const kind = values.get("kind");
  if (kind !== "template" && kind !== "persona") fail(path, "kind must be template or persona");
  if (Buffer.byteLength(body, "utf8") > 8 * 1024 || !body.trim()) fail(path, "body must be nonempty and at most 8 KiB");
  return { name, kind };
}

function routineSchedule(value: unknown, path: string): RoutineSchedule {
  const schedule = record(value, path);
  if (Object.keys(schedule).some((key) => !["at", "repeat"].includes(key))) fail(path, "unknown schedule field");
  const at = schedule.at;
  if (at !== undefined && (typeof at !== "string" || !Number.isFinite(Date.parse(at)))) fail(path, "invalid schedule.at");
  let repeat: RoutineRepeat | undefined;
  if (schedule.repeat !== undefined) {
    const value = record(schedule.repeat, path);
    const kind = value.kind;
    if (kind === "cron") {
      if (Object.keys(value).some((key) => !["kind", "expression"].includes(key))
        || typeof value.expression !== "string" || value.expression.length > MAX_CRON_EXPR_LENGTH
        || !isValidCronExpression(value.expression)) fail(path, "invalid cron repeat");
      repeat = { kind, expression: value.expression as string };
    } else if (kind === "interval") {
      if (Object.keys(value).some((key) => !["kind", "intervalMs"].includes(key))
        || typeof value.intervalMs !== "number" || !Number.isFinite(value.intervalMs)
        || value.intervalMs < MIN_INTERVAL_MS || value.intervalMs > MAX_FUTURE_OFFSET_MS) fail(path, "invalid interval repeat");
      repeat = { kind, intervalMs: value.intervalMs as number };
    } else if (kind === "none" || kind === "daily" || kind === "weekly" || kind === "monthly") {
      if (Object.keys(value).some((key) => key !== "kind")) fail(path, "unknown repeat field");
      repeat = { kind };
    } else fail(path, "invalid repeat kind");
  }
  if (repeat?.kind !== "cron" && at === undefined) fail(path, "non-cron schedule needs at");
  return { ...(at !== undefined ? { at: at as string } : {}), ...(repeat ? { repeat } : {}) };
}

export function parseAgentPluginRoutineTemplates(bytes: Buffer, path = "ai.agent-connector.ave/routines.json"): Array<Omit<AgentPluginRoutineTemplate, "packageName" | "version">> {
  const document = json(bytes, path);
  if (Object.keys(document).some((key) => !["version", "templates"].includes(key))) fail(path, "unknown root field");
  if (document.version !== 1 || !Array.isArray(document.templates) || document.templates.length > 8) {
    fail(path, "needs version 1 and at most eight templates");
  }
  const ids = new Set<string>();
  return document.templates.map((value: unknown) => {
    const entry = record(value, path);
    if (Object.keys(entry).some((key) => !["id", "title", "description", "trigger", "schedule", "execution", "prePrompt", "notificationTitle", "notificationBody", "suggestedScope"].includes(key))) {
      fail(path, "unknown template field");
    }
    const id = requiredString(entry.id, path, "id", 63);
    if (!COMPONENT_NAME.test(id) || ids.has(id)) fail(path, `invalid or repeated id ${id}`);
    ids.add(id);
    const title = requiredString(entry.title, path, "title");
    const description = requiredString(entry.description, path, "description", 1000);
    if (entry.trigger !== "schedule" && entry.trigger !== "shutdown") fail(path, "invalid trigger");
    if (entry.execution !== "llm-session" && entry.execution !== "notification-only") fail(path, "invalid execution");
    const schedule = entry.schedule === undefined ? undefined : routineSchedule(entry.schedule, path);
    if (entry.prePrompt !== undefined && (typeof entry.prePrompt !== "string" || !entry.prePrompt.trim()
      || Buffer.byteLength(entry.prePrompt, "utf8") > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(entry.prePrompt))) {
      fail(path, "invalid prePrompt");
    }
    if (entry.notificationTitle !== undefined) requiredString(entry.notificationTitle, path, "notificationTitle", 500);
    if (entry.notificationBody !== undefined && (typeof entry.notificationBody !== "string"
      || Buffer.byteLength(entry.notificationBody, "utf8") > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(entry.notificationBody))) {
      fail(path, "invalid notificationBody");
    }
    if (entry.trigger === "schedule" && !schedule) fail(path, "a scheduled template needs schedule");
    if (entry.trigger === "shutdown" && schedule) fail(path, "a shutdown template cannot have schedule");
    if (entry.execution === "llm-session" && entry.prePrompt === undefined) fail(path, "an LLM template needs prePrompt");
    if (entry.execution === "notification-only" && entry.notificationTitle === undefined) fail(path, "a notification template needs notificationTitle");
    const scope = entry.suggestedScope === undefined ? undefined : record(entry.suggestedScope, path);
    if (scope && (Object.keys(scope).some((key) => key !== "pluginIds") || !Array.isArray(scope.pluginIds)
      || !scope.pluginIds.every((item) => typeof item === "string" && /^[a-z][a-z0-9-]*$/u.test(item)))) fail(path, "invalid suggestedScope");
    return {
      id, title, description, trigger: entry.trigger, execution: entry.execution,
      ...(schedule ? { schedule } : {}),
      ...(entry.prePrompt !== undefined ? { prePrompt: entry.prePrompt as string } : {}),
      ...(entry.notificationTitle !== undefined ? { notificationTitle: entry.notificationTitle as string } : {}),
      ...(entry.notificationBody !== undefined ? { notificationBody: entry.notificationBody as string } : {}),
      ...(scope ? { suggestedScope: { pluginIds: scope.pluginIds as string[] } } : {}),
    };
  });
}

function routineTemplates(bytes: Buffer): AgentPluginComponents["routineTemplates"] {
  return parseAgentPluginRoutineTemplates(bytes).map((template) => ({
    id: template.id, title: template.title, trigger: template.trigger, execution: template.execution,
    ...(template.schedule ? { schedule: template.schedule } : {}),
    ...(template.suggestedScope ? { suggestedScope: template.suggestedScope.pluginIds } : {}),
    digest: sha256Hex(canonicalStringify(template)),
  }));
}

function hookComponents(bytes: Buffer, files: ReadonlyMap<string, Buffer>, executable: ReadonlySet<string>): AgentPluginComponents["hooks"] {
  const path = "ai.agent-connector.ave/hooks.json";
  const document = json(bytes, path);
  if (Object.keys(document).some((key) => !["version", "hooks"].includes(key)) || (document.version !== undefined && document.version !== 1)) {
    fail(path, "needs version 1 and a hooks object");
  }
  const groups = record(document.hooks, path);
  for (const [event, blocks] of Object.entries(groups)) {
    if (!Array.isArray(blocks)) fail(path, `${event} must be an array`);
    for (const block of blocks) {
      const item = record(block, path);
      if (Object.keys(item).some((key) => !["matcher", "hooks"].includes(key)) || !Array.isArray(item.hooks)) {
        fail(path, `${event} has an invalid matcher block`);
      }
      for (const handler of item.hooks) {
        const entry = record(handler, path);
        if (Object.keys(entry).some((key) => !["type", "command", "env", "timeoutMs"].includes(key))
          || !Array.isArray(entry.command) || !entry.command.every((part: unknown) => typeof part === "string")) {
          fail(path, `${event} requires argv command handlers`);
        }
      }
    }
  }
  const parsed = parseHookConfig(document, { bundled: true });
  if (parsed.errors.length || parsed.warnings.length) fail(path, [...parsed.errors, ...parsed.warnings].join("; "));
  return parsed.entries.map((entry) => {
    try { validateSymbolicHookArgv([...entry.command, ...Object.values(entry.env ?? {})], `${path} ${entry.id}`); }
    catch (error) { fail(path, (error as Error).message); }
    for (const token of [...entry.command, ...Object.values(entry.env ?? {})]) {
      const name = token.startsWith("./") ? token.slice(2)
        : token.startsWith("${PLUGIN_ROOT}/") ? token.slice("${PLUGIN_ROOT}/".length) : null;
      if (name !== null && !files.has(name)) fail(path, `${entry.id} references missing package file ${name}`);
    }
    return {
      event: entry.event,
      ...(entry.matcher ? { matcher: entry.matcher } : {}),
      command: entry.command,
      ...(entry.env ? { env: entry.env } : {}),
      timeoutMs: entry.timeoutMs,
      digest: mcpDigest({ event: entry.event, matcher: entry.matcher ?? null, command: entry.command, env: entry.env ?? null, timeoutMs: entry.timeoutMs }, files, executable),
    };
  });
}

/** Read only package bytes. Installation roots and activation ids never enter a digest. */
export function deriveAgentPluginComponents(files: readonly AgentPluginFile[], expected: AgentPluginManifestIdentity = {}): AgentPluginComponents {
  const map = new Map(files.map((file) => [file.path, file.data]));
  const executable = new Set(files.filter((file) => file.executable === true).map((file) => file.path));
  if (map.size !== files.length) fail("plugin.json", "duplicate package path");
  const manifestBytes = map.get("plugin.json");
  if (!manifestBytes) fail("plugin.json", "is missing");
  let manifest: ReturnType<typeof parseAgentPluginManifest>;
  try { manifest = parseAgentPluginManifest(manifestBytes, expected); }
  catch (error) { fail("plugin.json", (error as Error).message); }
  const own = manifest.extensions?.["ai.agent-connector.ave"];
  const auth = (own?.mcpAuth ?? {}) as BundledMcpAuth;
  const skills: AgentPluginComponents["skills"] = [];
  const names = new Set<string>();
  for (const file of files) {
    const match = SKILL_PATH.exec(file.path);
    if (match) names.add(match[1]!);
  }
  for (const name of [...names].sort()) {
    const root = `skills/${name}/`;
    const group = files.filter((file) => file.path.startsWith(root)).map((file) => ({ path: file.path.slice(root.length), data: file.data }));
    const entry = map.get(`${root}SKILL.md`);
    if (!entry) fail(root, "SKILL.md is missing");
    try {
      const parsed = parseFrontmatter(entry.toString("utf8"));
      if (parsed.fm.name !== name || !parsed.fm.description || !parsed.body.trim()
        || Buffer.byteLength(parsed.body.trim(), "utf8") > 8 * 1024) fail(root, "invalid SKILL.md frontmatter or body");
    } catch (error) {
      fail(root, `invalid SKILL.md: ${(error as Error).message}`);
    }
    skills.push({ name, hasScripts: group.some((file) => file.path.startsWith("scripts/")), digest: fileDigest(group) });
  }
  const prompts: AgentPluginComponents["prompts"] = [];
  const agents: AgentPluginComponents["agents"] = [];
  for (const file of files) {
    const promptMatch = PROMPT_PATH.exec(file.path);
    if (promptMatch) prompts.push({ ...parsePackagePrompt(file.data, file.path, promptMatch[1]!), digest: sha256Hex(file.data) });
    const agentMatch = AGENT_PATH.exec(file.path);
    if (agentMatch) {
      let parsed: ReturnType<typeof parseAgentFrontmatter>;
      try { parsed = parseAgentFrontmatter(file.data.toString("utf8")); }
      catch (error) { fail(file.path, `invalid frontmatter: ${(error as Error).message}`); }
      if (parsed.fm.name !== agentMatch[1] || !parsed.body.trim()
        || Buffer.byteLength(parsed.body.trim(), "utf8") > 16 * 1024) fail(file.path, "invalid agent name or body");
      agents.push({ name: agentMatch[1]!, digest: sha256Hex(file.data) });
    }
  }
  prompts.sort((a, b) => a.name.localeCompare(b.name));
  agents.sort((a, b) => a.name.localeCompare(b.name));
  const mcp = map.get("mcp.json");
  if (!mcp && Object.keys(auth).length > 0) fail("plugin.json", "mcpAuth declares a server without mcp.json");
  const staticServers = mcp ? projectPortableMcp(parsePortableMcp(mcp), auth) : {};
  const mcpServers = Object.create(null) as AgentPluginComponents["mcpServers"];
  for (const name of Object.keys(staticServers).sort()) {
    const server = staticServers[name]!;
    if (server.transport === "stdio" && server.command.startsWith("./")) {
      const commandPath = server.command.slice(2);
      if (!commandPath.startsWith("server/") || !map.has(commandPath)) fail("mcp.json", `server ${name} command must name a package file under server/`);
    }
    mcpServers[name] = { ...server, digest: mcpDigest(server, map, executable) };
  }
  const routineBytes = map.get("ai.agent-connector.ave/routines.json");
  const hookBytes = map.get("ai.agent-connector.ave/hooks.json");
  return {
    skills, mcpServers,
    ...(Object.keys(auth).length > 0 ? { mcpAuth: auth } : {}),
    prompts, agents,
    routineTemplates: routineBytes ? routineTemplates(routineBytes) : [],
    hooks: hookBytes ? hookComponents(hookBytes, map, executable) : [],
  };
}
