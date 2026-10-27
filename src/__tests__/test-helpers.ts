import { refuseNamespaceFileCreation } from "./support/feature-namespace.js";
import { afterAll, afterEach, vi } from "vitest";
import { createServer as createNetServer } from "node:net";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDirTracker, removeLinkOnly } from "./support/tmp-dir-teardown.js";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { IpcMainInvokeEvent } from "electron";
import { IPC_APPROVAL_REQUEST } from "../permissions/approval-gate.js";
import type { FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import type { ChatEntry } from "../lib/chat-stream-state.js";
import { SessionGoalStore } from "../main/session-goal-store.js";
import type { SessionGoal } from "../shared/session-goal.js";

export function makeMockWebContents() {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

/** Filter approval cards separately from settlement events before counting or indexing sends. */
export function sentApprovalCards<T>(
  wc: { send: { mock: { calls: unknown[][] } } },
): T[] {
  return wc.send.mock.calls
    .map((call) => call as unknown as [string, T])
    .filter(([channel]) => channel === IPC_APPROVAL_REQUEST)
    .map(([, payload]) => payload);
}

export const HOST_FRAME_URL = "file:///Applications/Ave.app/dist/index.html";

export const PLUGIN_SHELL_FRAME_URL =
  "file:///Applications/Ave.app/dist/plugin-ui-shell.html";

/** Trusted IPC events require a valid host frame; missing frames must fail closed. */
export function hostFrameEvent(): IpcMainInvokeEvent {
  return {
    senderFrame: { url: HOST_FRAME_URL },
    sender: {},
  } as unknown as IpcMainInvokeEvent;
}

export function foreignFrameEvent(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url }, sender: {} } as unknown as IpcMainInvokeEvent;
}

export function untrustedEvent(): IpcMainInvokeEvent {
  return foreignFrameEvent("https://evil.example.com/");
}

/** Plugin-shell file frames must not gain host-channel authority. */
export function pluginShellFrameEvent(): IpcMainInvokeEvent {
  return foreignFrameEvent(PLUGIN_SHELL_FRAME_URL);
}

/** A destroyed or navigated-away sender frame must be refused. */
export function framelessEvent(): IpcMainInvokeEvent {
  return { senderFrame: null, sender: {} } as unknown as IpcMainInvokeEvent;
}

type RegisteredHandler = (...args: unknown[]) => unknown;

export function invokeRegisteredHandler<T = unknown>(
  handlers: Map<string, RegisteredHandler>,
  channel: string,
  ...args: unknown[]
): T {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(hostFrameEvent(), ...args) as T;
}

export function invokeRegisteredHandlerWithEvent<T = unknown>(
  handlers: Map<string, RegisteredHandler>,
  channel: string,
  event: unknown,
  ...args: unknown[]
): T {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(event, ...args) as T;
}

export function makeRegisteredHandlerInvoker(
  handlers: Map<string, RegisteredHandler>,
): <T = unknown>(channel: string, event: unknown, ...args: unknown[]) => T {
  return (channel, event, ...args) =>
    invokeRegisteredHandlerWithEvent(handlers, channel, event, ...args);
}

export function makeMockPermissionManager() {
  return {
    getMode: vi.fn(() => "default"),
    setModePersist: vi.fn(),
    listPersistedRules: vi.fn(async () => []),
    addAlwaysAllowedPersist: vi.fn(),
    addAlwaysDeniedPersist: vi.fn(),
    removeRule: vi.fn(),
    getVisibilityDenyRules: vi.fn(() => []),
    setDeferredEntryAsk: vi.fn(),
  };
}

export function makeMockConversationLoop(
  permissionManager: ReturnType<typeof makeMockPermissionManager>,
) {
  return {
    permissionManager,
    hasProvider: vi.fn(),
    runTurn: vi.fn(),
    newConversation: vi.fn(),
    getSessionId: vi.fn(() => "s1"),
    listSessions: vi.fn(() => []),
    loadSession: vi.fn(),
    refreshProvider: vi.fn(),
  };
}

export function makeMockApprovalGate() {
  return { resolve: vi.fn(), setPolicy: vi.fn() };
}

export function createInMemoryFeatureNamespace() {
  let stored: unknown;
  const handle = {
    dir: "memory",
    readJson: async <T>(_name: string, fallback: T): Promise<T> =>
      structuredClone(stored === undefined ? fallback : stored) as T,
    writeJson: async <T>(_name: string, value: T): Promise<void> => {
      stored = structuredClone(value);
    },
    childDir: async (name: string): Promise<string> => name,
    createFile: refuseNamespaceFileCreation,
  } satisfies FeatureNamespaceHandle;
  return {
    handle,
    getStored: () => structuredClone(stored),
  };
}

export async function collectAsyncIterable<T>(
  iterable: AsyncIterable<T>,
): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

export interface RecordedSpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnOptions;
}

export function makeRecordedSpawn(
  child: ChildProcess,
  calls: RecordedSpawnCall[],
): (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => ChildProcess {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
}

export interface FakeBrowserWindow {
  isDestroyed: () => boolean;
  webContents: { isDestroyed: () => boolean; send: (channel: string, payload?: unknown) => void };
}

export function liveWindow(): FakeBrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

/** Pin and restore TZ through async settlement so calendar tests do not inherit the runner's zone. */
export function withTz<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  const restore = (): void => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  };
  process.env.TZ = zone;
  let result: T;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Anchor source reads to this file, independent of the working directory. */
export function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

/** Register scratch cleanup with the shared tracker so all suites use the same lock-retry policy. */
export function useTempDirs(prefix: string): (ownPrefix?: string) => string {
  const tracker = createTmpDirTracker();
  afterAll(async () => {
    await tracker.cleanup();
  });
  return (ownPrefix = prefix) => tracker.track(mkdtempSync(join(tmpdir(), ownPrefix)));
}

/** Return uncreated paths so subjects, rather than fixtures, perform the writes under test. */
export function useTempPaths(prefix: string, fileName: string): () => string {
  const makeDir = useTempDirs(prefix);
  return () => join(makeDir(), fileName);
}

/** Create only the directory; the subject must create the file. */
export function useTempDirFile(
  prefix: string,
  fileName: string,
): () => { dir: string; path: string } {
  const makeDir = useTempDirs(prefix);
  return () => {
    const dir = makeDir();
    return { dir, path: join(dir, fileName) };
  };
}

/** Remove links before scratch trees so recursive cleanup cannot traverse Windows junctions. */
export function useScratchLinks(): (target: string, at: string) => string {
  const links: string[] = [];
  afterEach(() => {
    for (const link of links.splice(0)) removeLinkOnly(link);
  });
  return (target, at) => {
    symlinkSync(target, at, "junction");
    links.push(at);
    return at;
  };
}

export { deferred } from "./support/deferred.js";

export function userEntry(text: string): ChatEntry {
  return { kind: "user", text };
}

export function assistantEntry(text: string): Extract<ChatEntry, { kind: "assistant" }> {
  return { kind: "assistant", text, streaming: false };
}

/** Drain queued setImmediate work before assertions. */
export function settleMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The caller must restore process.platform in afterEach. */
export function setProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

export function parseJsonRecord(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

/** Read identity and bytes through one handle so replacement races cannot mix files. */
export function inspectFile(path: string): { ino: number; mode: number; text: string } {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    return { ino: stat.ino, mode: stat.mode & 0o777, text: readFileSync(fd, "utf-8") };
  } finally {
    closeSync(fd);
  }
}

/** Expose in-memory persisted state and a deterministic clock to test restart behavior. */
export function makeSessionGoalStore(now?: () => string): {
  store: SessionGoalStore;
  disk: Map<string, SessionGoal | null>;
} {
  const disk = new Map<string, SessionGoal | null>();
  const persistence = {
    load: (sessionId: string) => disk.get(sessionId) ?? null,
    save: async (sessionId: string, goal: SessionGoal | null) => {
      disk.set(sessionId, goal);
    },
  };
  return {
    store: now ? new SessionGoalStore(persistence, now) : new SessionGoalStore(persistence),
    disk,
  };
}

/** Hold a loopback port per test; an already occupied port satisfies the precondition. */
export async function occupyLoopbackPort(port: number): Promise<() => Promise<void>> {
  const held = createNetServer();
  const bound = await new Promise<boolean>((resolve, reject) => {
    held.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(false);
      else reject(err);
    });
    held.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
  });
  if (!bound) return async () => undefined;
  return () => new Promise<void>((resolve) => held.close(() => resolve()));
}
