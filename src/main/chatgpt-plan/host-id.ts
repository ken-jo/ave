import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";

const HOST_ID_FILE = "host.json";
const HOST_ID_PATTERN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class ChatGptPlanHostIdError extends Error {
  constructor() {
    super("chatgpt-plan host id file is unreadable or malformed");
    this.name = "ChatGptPlanHostIdError";
  }
}

export function isChatGptPlanHostId(value: unknown): value is string {
  return typeof value === "string" && HOST_ID_PATTERN.test(value);
}

/**
 * This installation's `ext_agent_host_id`: a UUIDv4 URN created once, before
 * the first sign-in, and reused for every later sign-in on this host.
 *
 * The value is opaque and carries nothing about the user. A stored value
 * that cannot be read back is an error rather than a reason to mint a new
 * one: a silent replacement would register this install as a second host.
 */
export async function loadOrCreateChatGptPlanHostId(namespace: FeatureNamespaceHandle): Promise<string> {
  let raw: string | null = null;
  try {
    raw = await readFile(join(namespace.dir, HOST_ID_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ChatGptPlanHostIdError();
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ChatGptPlanHostIdError();
    }
    const hostId = (parsed as { extAgentHostId?: unknown } | null)?.extAgentHostId;
    if (!isChatGptPlanHostId(hostId)) throw new ChatGptPlanHostIdError();
    return hostId;
  }
  const created = `urn:uuid:${randomUUID()}`;
  await namespace.writeJson(HOST_ID_FILE, { extAgentHostId: created });
  return created;
}
