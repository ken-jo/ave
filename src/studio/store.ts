import { readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { openFeatureNamespace, writeFileAtomicAtPath } from "../main/storage/feature-namespace.js";
import { isPackageName } from "../marketplace/catalog/types.js";
import { checkContentFiles, contentFileProblem } from "../marketplace/content/rules.js";
import { deriveAgentPluginComponents } from "../marketplace/content/agent-plugin-components.js";
import { treeDigest } from "../marketplace/resolve/plugin-ladder.js";
import { parseStrictJson } from "../marketplace/catalog/strict-json.js";
import { AGENT_PLUGINS_SCHEMA_URL, AVE_EXTENSION_NAMESPACE } from "../plugins/public-contract.js";
import type { StudioConnectorConfirmation, StudioConnectorCopyPreview, StudioConnectorStatus, StudioDraft, StudioDraftView, StudioOrigin, StudioPart, StudioWriteRequest } from "../shared/plugin-studio.js";
import { exportPortableMcp, parsePortableMcp, projectPortableMcp, type BundledMcpAuth } from "../mcp/portable-mcp.js";
import { lintStudioFiles } from "./lint.js";
import { importStudioArchive, type ImportedStudioPackage } from "./import.js";
import { studioFileText } from "./package.js";
import { portableStudioConnector, verifyStudioConnectorPreview } from "./connector.js";
import { clearedImportedHooks } from "../hooks/hook-import-export.js";

const namespace = openFeatureNamespace("studio");
const MAX_FILES = 256;
const MAX_BYTES = 8 * 1024 * 1024;

function draftName(name: string): string {
  if (!isPackageName(name)) throw new Error("Studio draft name must be a package name");
  return name;
}

function filePath(path: string): string {
  if (path === "ave-package.json") throw new Error(`${path} is a sharing descriptor`);
  if (path.split("/").some((part) => !part || part === "." || part === "..") || path.includes("\\") || path.includes("\0") || contentFileProblem("agent-plugin", path)) {
    throw new Error(`Invalid Studio package path: ${path}`);
  }
  return path;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDraft(value: unknown, name: string): StudioDraft {
  if (!object(value) || value.version !== 1 || value.name !== name || !Array.isArray(value.parts)
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string"
    || !Array.isArray(value.diagnostics) || !Array.isArray(value.pendingHooks)) {
    throw new Error(`Studio draft ${name} is malformed`);
  }
  if (value.reviewed !== undefined && (!object(value.reviewed) || !/^[a-f0-9]{64}$/u.test(String(value.reviewed.treeDigest)) || typeof value.reviewed.at !== "string")) {
    throw new Error(`Studio draft ${name} has invalid review metadata`);
  }
  if (value.writeState !== undefined && value.writeState !== "pending") {
    throw new Error(`Studio draft ${name} has invalid write state`);
  }
  return value as unknown as StudioDraft;
}

async function readDraftRecord(name: string): Promise<StudioDraft | null> {
  const path = join(namespace.dir, draftName(name), "draft.json");
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseDraft(parseStrictJson(bytes.toString("utf8")), name);
}

async function readPackageFiles(name: string): Promise<Array<{ path: string; data: Buffer }>> {
  const root = join(namespace.dir, draftName(name), "package");
  const files: Array<{ path: string; data: Buffer }> = [];
  let size = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Studio package contains a symbolic link: ${path}`);
      if (entry.isDirectory()) await walk(full, path);
      else if (entry.isFile()) {
        filePath(path);
        const data = await readFile(full);
        files.push({ path, data });
        size += data.length;
        if (files.length > MAX_FILES || size > MAX_BYTES) throw new Error("Studio package exceeds its limits");
      } else throw new Error(`Studio package contains a non-file: ${path}`);
    }
  };
  await walk(root, "");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function digest(files: readonly { path: string; data: Buffer }[]): string {
  return treeDigest(files.map((file) => ({ ...file, executable: false })));
}

function portableOrigin(origin: StudioOrigin, path: string): Record<string, unknown> {
  if (origin.kind === "conversation") return { kind: "conversation" };
  if (origin.kind === "user-store") {
    const store = path.startsWith("skills/") ? "skills" : path.startsWith("ai.agent-connector.ave/agents/") ? "agents" : "prompts";
    return { kind: "user-store", store, name: basename(dirname(path)) === "prompts" ? basename(path, ".md") : basename(dirname(path)) };
  }
  return origin;
}

function provenance(parts: readonly StudioPart[]): Buffer {
  const safe = parts.map(({ path, origin }) => ({ path, origin: portableOrigin(origin, path) }));
  return Buffer.from(`${JSON.stringify({ version: 1, parts: safe }, null, 2)}\n`);
}

function authoredText(path: string, text: string, author: "model" | "user"): Buffer {
  if (!/^skills\/[a-z][a-z0-9-]*\/SKILL\.md$/u.test(path)
    && !/^xyz\.ave\/prompts\/[a-z][a-z0-9-]*\.md$/u.test(path)) return Buffer.from(text);
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
  if (!front) throw new Error(`Studio authored file ${path} needs frontmatter`);
  const fields: unknown = parseYaml(front[1]!);
  if (!object(fields)) throw new Error(`Studio authored file ${path} has invalid frontmatter`);
  const separator = front[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = front[1]!.split(/\r?\n/u);
  if (path.startsWith("skills/")) {
    const metadata = fields.metadata === undefined ? {} : fields.metadata;
    if (!object(metadata) || Object.values(metadata).some((value) => typeof value !== "string")) {
      throw new Error(`Studio skill ${path} needs string metadata`);
    }
    const metadataIndex = lines.findIndex((line) => /^metadata:\s*$/u.test(line));
    if (fields.metadata !== undefined && metadataIndex < 0) {
      throw new Error(`Studio skill ${path} needs block-style metadata for authorship`);
    }
    if (metadataIndex < 0) lines.push("metadata:", "  ave-origin: studio", `  ave-authored-by: ${author}`);
    else {
      let end = metadataIndex + 1;
      while (end < lines.length && (lines[end]!.trim() === "" || /^\s/u.test(lines[end]!))) end++;
      const children = lines.slice(metadataIndex + 1, end).filter((line) => !/^\s+ave-(?:origin|authored-by):/u.test(line));
      lines.splice(metadataIndex + 1, end - metadataIndex - 1, ...children,
        "  ave-origin: studio", `  ave-authored-by: ${author}`);
    }
  } else {
    if (lines.some((line) => /^\s+\S/u.test(line))) {
      throw new Error(`Studio prompt ${path} needs single-line frontmatter fields`);
    }
    for (const key of ["name", "description", "kind", "argumentHint"]) {
      const value = fields[key];
      if (value !== undefined && (typeof value !== "string" || /[\r\n]/u.test(value))) {
        throw new Error(`Studio prompt ${path} needs a single-line ${key}`);
      }
    }
    const kept = lines.filter((line) => !/^ave-(?:origin|authored-by):/u.test(line));
    lines.splice(0, lines.length, ...kept, "ave-origin: studio", `ave-authored-by: ${author}`);
  }
  const start = /^---\r?\n/u.exec(text)![0].length;
  return Buffer.from(`${text.slice(0, start)}${lines.join(separator)}${text.slice(start + front[1]!.length)}`);
}

function portableProvenance(value: unknown): boolean {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.parts)
    || Object.keys(value).some((key) => key !== "version" && key !== "parts")) return false;
  return value.parts.every((part: unknown) => {
    if (!object(part) || typeof part.path !== "string" || !object(part.origin)
      || Object.keys(part).some((key) => key !== "path" && key !== "origin")) return false;
    const origin = part.origin;
    if (origin.kind === "typed" || origin.kind === "conversation") return Object.keys(origin).length === 1;
    if (origin.kind === "user-store") return typeof origin.name === "string"
      && ["skills", "prompts", "agents"].includes(String(origin.store))
      && Object.keys(origin).every((key) => ["kind", "store", "name"].includes(key));
    if (origin.kind === "copied") return object(origin.from) && typeof origin.from.kind === "string"
      && typeof origin.from.name === "string" && (origin.from.version === undefined || typeof origin.from.version === "string")
      && Object.keys(origin.from).every((key) => ["kind", "name", "version"].includes(key))
      && Object.keys(origin).every((key) => key === "kind" || key === "from");
    return false;
  });
}

async function persist(name: string, draft: StudioDraft): Promise<void> {
  const dir = await namespace.childDir(name);
  await writeFileAtomicAtPath(join(dir, "draft.json"), `${JSON.stringify(draft, null, 2)}\n`);
}

async function putFile(name: string, path: string, data: Buffer): Promise<void> {
  const dir = await namespace.childDir(name);
  await writeFileAtomicAtPath(join(dir, "package", ...filePath(path).split("/")), data);
}

function validateFiles(draft: StudioDraft, files: readonly { path: string; data: Buffer }[], connectorStatuses: StudioConnectorStatus[]): Pick<StudioDraftView, "components" | "errors" | "lint"> {
  const errors: string[] = [];
  let components: StudioDraftView["components"] = null;
  try {
    checkContentFiles("agent-plugin", files);
    components = deriveAgentPluginComponents(files, { name: draft.name });
    if (components.hooks.some((hook) => hook.command[0]?.startsWith("./")
      || hook.command[0]?.startsWith("${PLUGIN_ROOT}/"))) {
      errors.push("Studio drafts cannot prepare executable hook files; use node or bun for the script, or install the package from file");
    }
  } catch (error) { errors.push((error as Error).message); }
  if (draft.pendingHooks.length) errors.push("Imported hooks need adaptation before validation");
  for (const status of connectorStatuses) if (status.status !== "confirmed") {
    errors.push(`Connector ${status.serverId} needs current value confirmation`);
  }
  const lint = lintStudioFiles(files);
  return { components, errors, lint };
}

function preflightImport(imported: ImportedStudioPackage): void {
  for (const file of imported.files) filePath(file.path);
  checkContentFiles("agent-plugin", imported.files);
  const manifestBytes = imported.files.find((file) => file.path === "plugin.json")?.data;
  if (!manifestBytes) throw new Error("Imported plugin.json is missing");
  const manifest = parseStrictJson(manifestBytes.toString("utf8"));
  if (!object(manifest)) throw new Error("Imported plugin.json must be an object");
  const mcp = imported.files.find((file) => file.path === "mcp.json");
  if (mcp) parsePortableMcp(mcp.data);
  const files = imported.files.map((file) => file.path === "plugin.json" && (manifest.version === undefined || manifest.description === undefined)
    ? { path: file.path, data: Buffer.from(JSON.stringify({ ...manifest,
      ...(manifest.version === undefined && imported.diagnostics.some((item) => item.path === "plugin.json.version" && item.group === "needs-input")
        ? { version: "0.1.0" } : {}),
      ...(manifest.description === undefined && imported.diagnostics.some((item) => item.path === "plugin.json.description" && item.group === "needs-input")
        ? { description: "Pending description" } : {}),
    })) } : file);
  deriveAgentPluginComponents(files, { name: imported.name });
}

export class PluginStudioStore {
  constructor(private readonly connectorSummary?: (serverId: string) => Promise<{ digest: string; argsCount: number; envCount: number }>,
    private readonly assertConnectorSafe?: (serverId: string, preview: StudioConnectorCopyPreview) => Promise<void>) {}

  private async connectorStatuses(draft: StudioDraft): Promise<StudioConnectorStatus[]> {
    return Promise.all((draft.connectorCopies ?? []).map(async (copy) => {
      const confirmedArgs = Object.keys(copy.confirmedArgs).length;
      const confirmedEnv = Object.keys(copy.confirmedEnv).length;
      const current = this.connectorSummary ? await this.connectorSummary(copy.serverId).catch(() => null) : null;
      let status: StudioConnectorStatus["status"] = "needs-confirmation";
      if (copy.specDigest && confirmedArgs === copy.argsCount && confirmedEnv === copy.envCount) {
        status = current?.digest === copy.specDigest ? "confirmed" : "stale";
      }
      return { serverId: copy.serverId, argsCount: current?.argsCount ?? copy.argsCount, envCount: current?.envCount ?? copy.envCount,
        confirmedArgs, confirmedEnv, status };
    }));
  }

  async listDrafts(): Promise<StudioDraft[]> {
    const entries = await readdir(namespace.dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const drafts: StudioDraft[] = [];
    for (const entry of entries) if (entry.isDirectory() && isPackageName(entry.name)) {
      const draft = await readDraftRecord(entry.name);
      if (draft) drafts.push(draft);
    }
    return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readDraft(name: string): Promise<StudioDraftView> {
    const draft = await readDraftRecord(name);
    if (!draft) throw new Error(`Studio draft ${name} does not exist`);
    const files = await readPackageFiles(name);
    const connectorStatuses = await this.connectorStatuses(draft);
    const checked = validateFiles(draft, files, connectorStatuses);
    const treeDigest = digest(files);
    const incomplete = draft.writeState === "pending"
      || (draft.reviewed !== undefined && draft.reviewed.treeDigest !== treeDigest);
    if (incomplete) checked.errors.push("Studio draft has an incomplete write; save it again before review");
    const reviewStatus = draft.reviewed?.treeDigest === treeDigest && checked.errors.length === 0
      ? "reviewed" as const : "needs-review" as const;
    return { draft, files: files.map(({ path, data }) => ({ path, text: studioFileText(data) })),
      treeDigest, reviewStatus, diagnostics: draft.diagnostics, connectorStatuses, ...checked };
  }

  async writeDraft(input: StudioWriteRequest, sessionId?: string, copiedFiles: readonly { path: string; data: Buffer; origin: StudioOrigin }[] = []): Promise<StudioDraftView> {
    const name = draftName(input.name);
    const old = await readDraftRecord(name);
    const wasPending = old?.writeState === "pending";
    const suppliedMutation = input.version !== undefined || input.description !== undefined
      || (input.files?.length ?? 0) > 0 || (input.removePaths?.length ?? 0) > 0
      || (input.references?.length ?? 0) > 0 || input.adaptedHooks !== undefined || copiedFiles.length > 0;
    if (wasPending && !suppliedMutation) throw new Error("Studio draft needs an update to repair its incomplete write");
    if (old && !suppliedMutation) return this.readDraft(name);
    const now = new Date().toISOString();
    const draft: StudioDraft = old ?? { version: 1, name, createdAt: now, updatedAt: now, parts: [], diagnostics: [], pendingHooks: [] };
    for (const reference of input.references ?? []) if (reference.kind === "connector") {
      if (!draft.connectorCopies?.some((copy) => copy.serverId === reference.name)) {
        (draft.connectorCopies ??= []).push({ serverId: reference.name, confirmedArgs: {}, confirmedEnv: {}, argsCount: 0, envCount: 0 });
      }
    }
    const before = old ? digest(await readPackageFiles(name)) : null;
    // Persist the pending marker before changing package bytes. A crash at any later
    // write leaves the draft unreadable as reviewed until a successful update repairs it.
    draft.writeState = "pending";
    delete draft.reviewed;
    await persist(name, draft);
    const packageDir = join(namespace.dir, name, "package");
    for (const path of input.removePaths ?? []) {
      filePath(path);
      await rm(join(packageDir, ...path.split("/")), { force: true });
      draft.parts = draft.parts.filter((part) => part.path !== path);
    }
    const manifestPath = join(packageDir, "plugin.json");
    const manifestBytes = old ? await readFile(manifestPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && wasPending) return null;
      throw error;
    }) : null;
    const existingManifest: unknown = manifestBytes ? parseStrictJson(manifestBytes.toString("utf8")) : {};
    if (!object(existingManifest)) throw new Error("Studio plugin.json must be an object");
    const manifest = { ...existingManifest, $schema: AGENT_PLUGINS_SCHEMA_URL, name,
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}) };
    if (input.version?.trim()) draft.diagnostics = draft.diagnostics.filter((item) => item.path !== "plugin.json.version");
    if (input.description?.trim()) draft.diagnostics = draft.diagnostics.filter((item) => item.path !== "plugin.json.description");
    await putFile(name, "plugin.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    for (const part of input.files ?? []) {
      filePath(part.path);
      const authoredPath = /^skills\/[a-z][a-z0-9-]*\/SKILL\.md$/u.test(part.path)
        || /^xyz\.ave\/prompts\/[a-z][a-z0-9-]*\.md$/u.test(part.path)
        || part.path === "ai.agent-connector.ave/routines.json";
      if (!authoredPath && !(sessionId === undefined && part.path === "mcp.json")) {
        throw new Error(`Studio cannot author ${part.path}`);
      }
      if (part.path === "mcp.json" && draft.connectorCopies?.length) throw new Error("Confirm selected connectors before editing mcp.json");
      if (part.path === "plugin.json" || part.path === "ai.agent-connector.ave/provenance.json") throw new Error(`${part.path} is managed by Studio`);
      await putFile(name, part.path, authoredText(part.path, part.text, sessionId ? "model" : "user"));
      const origin = sessionId ? { kind: "conversation" as const, sessionId } : { kind: "typed" as const };
      draft.parts = draft.parts.filter((oldPart) => oldPart.path !== part.path);
      draft.parts.push({ path: part.path, origin });
    }
    for (const part of copiedFiles) {
      filePath(part.path);
      if (part.path === "plugin.json" || part.path === "ai.agent-connector.ave/provenance.json") throw new Error(`${part.path} is managed by Studio`);
      await putFile(name, part.path, part.data);
      draft.parts = draft.parts.filter((oldPart) => oldPart.path !== part.path);
      draft.parts.push({ path: part.path, origin: part.origin });
    }
    if (input.adaptedHooks !== undefined) {
      if (!Array.isArray(input.adaptedHooks) || input.adaptedHooks.length !== draft.pendingHooks.length
        || new Set(input.adaptedHooks.map((item) => item.index)).size !== draft.pendingHooks.length) {
        throw new Error("Every imported hook needs an adaptation decision");
      }
      const cleared = input.adaptedHooks.map((item) => {
        const hook = draft.pendingHooks[item.index];
        if (!hook || !Array.isArray(item.command) || !item.command.length
          || item.command.some((part) => typeof part !== "string" || !part)) {
          throw new Error("Imported hook adaptation is invalid");
        }
        return { ...hook, command: item.command, needsAdaptation: false as const };
      });
      await putFile(name, "ai.agent-connector.ave/hooks.json", Buffer.from(`${JSON.stringify(clearedImportedHooks(cleared), null, 2)}\n`));
      draft.parts.push({ path: "ai.agent-connector.ave/hooks.json", origin: sessionId ? { kind: "conversation", sessionId } : { kind: "typed" } });
      draft.pendingHooks = [];
      draft.diagnostics = draft.diagnostics.filter((item) => !(item.group === "needs-input" && item.path.startsWith("hooks.")));
    }
    draft.parts.sort((a, b) => a.path.localeCompare(b.path));
    await putFile(name, "ai.agent-connector.ave/provenance.json", provenance(draft.parts));
    const after = digest(await readPackageFiles(name));
    if (before !== after) delete draft.reviewed;
    delete draft.writeState;
    draft.updatedAt = now;
    await persist(name, draft);
    return this.readDraft(name);
  }

  async confirmConnectorCopy(name: string, serverId: string, preview: StudioConnectorCopyPreview,
    confirmation: StudioConnectorConfirmation): Promise<StudioDraftView> {
    const draft = await readDraftRecord(name);
    const copy = draft?.connectorCopies?.find((item) => item.serverId === serverId);
    if (!draft || !copy) throw new Error(`Connector ${serverId} is not selected in this draft`);
    if (preview.serverId !== serverId || confirmation.specDigest !== preview.specDigest
      || !Array.isArray(confirmation.args) || !Array.isArray(confirmation.env)) {
      throw new Error("Connector preview changed before confirmation");
    }
    verifyStudioConnectorPreview(preview);
    if (!this.connectorSummary) throw new Error("Connector source is unavailable for confirmation");
    const current = await this.connectorSummary(serverId);
    if (current.digest !== preview.specDigest || current.argsCount !== preview.args.length || current.envCount !== preview.env.length) {
      throw new Error("Connector source changed before confirmation");
    }
    if (!this.assertConnectorSafe) throw new Error("Connector credential guard is unavailable");
    await this.assertConnectorSafe(serverId, preview);
    const confirmedArgs: Record<string, string> = {};
    for (const item of confirmation.args) {
      const expected = preview.args.find((entry) => entry.index === item.index);
      if (!expected || expected.digest !== item.digest || Object.hasOwn(confirmedArgs, String(item.index))) {
        throw new Error("Connector argument confirmation is invalid or stale");
      }
      confirmedArgs[String(item.index)] = item.digest;
    }
    const confirmedEnv: Record<string, string> = {};
    for (const item of confirmation.env) {
      const expected = preview.env.find((entry) => entry.name === item.name);
      if (!expected || expected.digest !== item.digest || Object.hasOwn(confirmedEnv, item.name)) {
        throw new Error("Connector environment confirmation is invalid or stale");
      }
      confirmedEnv[item.name] = item.digest;
    }
    const complete = confirmation.args.length === preview.args.length && confirmation.env.length === preview.env.length;
    const packageDir = join(namespace.dir, draft.name, "package");
    const manifest = parseStrictJson((await readFile(join(packageDir, "plugin.json"))).toString("utf8"));
    if (!object(manifest)) throw new Error("Studio plugin.json must be an object");
    const extensions = manifest.extensions === undefined ? {} : manifest.extensions;
    if (!object(extensions)) throw new Error("Studio extensions must be an object");
    const own = extensions[AVE_EXTENSION_NAMESPACE] === undefined ? {} : extensions[AVE_EXTENSION_NAMESPACE];
    if (!object(own)) throw new Error("Studio extension namespace must be an object");
    const existingAuth = own.mcpAuth === undefined ? {} : own.mcpAuth;
    if (!object(existingAuth)) throw new Error("Studio mcpAuth must be an object");
    const auth = Object.assign(Object.create(null) as BundledMcpAuth, existingAuth);
    const existingMcp = await readFile(join(packageDir, "mcp.json")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const existingServers = existingMcp ? parsePortableMcp(existingMcp).mcpServers : {};
    if (!copy.specDigest && Object.hasOwn(existingServers, serverId)) throw new Error(`mcp.json already declares ${serverId}`);
    const servers = Object.assign(Object.create(null) as typeof existingServers, existingServers);
    delete servers[serverId];
    delete auth[serverId];
    if (complete) {
      const portable = portableStudioConnector(preview);
      servers[serverId] = exportPortableMcp({ [serverId]: portable.server }).mcpServers[serverId]!;
      if (portable.auth) auth[serverId] = portable.auth;
    }
    const document = { ...exportPortableMcp({}), mcpServers: servers };
    if (Object.keys(servers).length) projectPortableMcp(parsePortableMcp(JSON.stringify(document)), auth);
    else if (Object.keys(auth).length) throw new Error("mcpAuth names a server without mcp.json");

    draft.writeState = "pending";
    delete draft.reviewed;
    await persist(name, draft);
    copy.specDigest = preview.specDigest;
    copy.confirmedArgs = confirmedArgs;
    copy.confirmedEnv = confirmedEnv;
    copy.argsCount = preview.args.length;
    copy.envCount = preview.env.length;
    if (Object.keys(servers).length) {
      await putFile(name, "mcp.json", Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
      draft.parts = draft.parts.filter((part) => part.path !== "mcp.json");
      draft.parts.push({ path: "mcp.json", origin: { kind: "copied", from: { kind: "connector", name: serverId } } });
    } else {
      await rm(join(packageDir, "mcp.json"), { force: true });
      draft.parts = draft.parts.filter((part) => part.path !== "mcp.json");
    }
    if (Object.keys(auth).length) own.mcpAuth = auth;
    else delete own.mcpAuth;
    if (Object.keys(own).length) extensions[AVE_EXTENSION_NAMESPACE] = own;
    else delete extensions[AVE_EXTENSION_NAMESPACE];
    if (Object.keys(extensions).length) manifest.extensions = extensions;
    else delete manifest.extensions;
    await putFile(name, "plugin.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    await putFile(name, "ai.agent-connector.ave/provenance.json", provenance(draft.parts));
    delete draft.reviewed;
    delete draft.writeState;
    draft.updatedAt = new Date().toISOString();
    await persist(name, draft);
    return this.readDraft(name);
  }

  async importPackage(path: string): Promise<StudioDraftView> {
    const imported = await importStudioArchive(path);
    const name = draftName(imported.name);
    if (await readDraftRecord(name)) throw new Error(`Studio draft ${name} already exists`);
    const now = new Date().toISOString();
    const draft: StudioDraft = { version: 1, name, createdAt: now, updatedAt: now, parts: [], diagnostics: imported.diagnostics,
      pendingHooks: imported.pendingHooks, writeState: "pending" };
    const suppliedProvenance = imported.files.find((file) => file.path === "ai.agent-connector.ave/provenance.json");
    if (suppliedProvenance) {
      const declared = parseStrictJson(suppliedProvenance.data.toString("utf8"));
      if (!portableProvenance(declared)) {
        throw new Error("Imported provenance contains private or malformed fields");
      }
    }
    draft.parts = imported.files.filter((file) => file.path !== "plugin.json" && file.path !== "ai.agent-connector.ave/provenance.json")
      .map((file) => ({ path: file.path, origin: { kind: "copied", from: { kind: "package", name,
        ...(imported.version ? { version: imported.version } : {}) } } }));
    const generatedProvenance = suppliedProvenance ? null : provenance(draft.parts);
    preflightImport({ ...imported, files: generatedProvenance
      ? [...imported.files, { path: "ai.agent-connector.ave/provenance.json", data: generatedProvenance }] : imported.files });
    // The pending marker is durable before package writes, as in draft updates.
    await persist(name, draft);
    for (const file of imported.files) {
      await putFile(name, file.path, file.data);
    }
    if (generatedProvenance) await putFile(name, "ai.agent-connector.ave/provenance.json", generatedProvenance);
    delete draft.writeState;
    await persist(name, draft);
    return this.readDraft(name);
  }

  async reviewDraft(name: string, treeDigest: string): Promise<StudioDraftView> {
    const view = await this.readDraft(name);
    if (view.errors.length) throw new Error(`Studio draft has validation errors: ${view.errors.join("; ")}`);
    if (view.treeDigest !== treeDigest) throw new Error("Studio draft changed since review opened");
    view.draft.reviewed = { treeDigest, at: new Date().toISOString() };
    await persist(name, view.draft);
    return this.readDraft(name);
  }

  async reviewedFiles(name: string): Promise<Array<{ path: string; data: Buffer }>> {
    const view = await this.readDraft(name);
    if (view.draft.writeState === "pending" || (view.draft.reviewed && view.draft.reviewed.treeDigest !== view.treeDigest)) {
      throw new Error("Studio draft has an incomplete write; save it again before review");
    }
    if (!view.draft.reviewed || view.draft.reviewed.treeDigest !== view.treeDigest || view.errors.length) {
      throw new Error("Studio draft must be reviewed at its current tree digest");
    }
    return readPackageFiles(name);
  }

  async installableFiles(name: string): Promise<Array<{ path: string; data: Buffer }>> {
    return this.reviewedFiles(name);
  }

  async markShared(name: string): Promise<void> {
    await this.reviewedFiles(name);
    const draft = await readDraftRecord(name);
    if (!draft) throw new Error(`Studio draft ${name} does not exist`);
    draft.sharedAt = new Date().toISOString();
    await persist(name, draft);
  }

  async packageFiles(name: string): Promise<Array<{ path: string; data: Buffer }>> {
    const view = await this.readDraft(name);
    if (view.errors.length) throw new Error(`Studio draft has validation errors: ${view.errors.join("; ")}`);
    return readPackageFiles(name);
  }
}
