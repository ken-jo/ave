import { describe, it, expect, vi, beforeEach } from "vitest";
import { invokeRegisteredHandler } from "../../../__tests__/test-helpers.js";
import { MAX_SESSION_FILE_BYTES } from "../../../memory/memory-manager.js";
import {
  MAX_LOCAL_USER_CONTENT_PARTS,
  MAX_LOCAL_USER_CONTENT_TEXT_CHARS,
  MAX_LOCAL_USER_CONTENT_TEXT_PARTS,
} from "../../../main/subscription-attachment-input.js";

const CHANNEL = "ave:chat:import";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

const dialogState: { canceled: boolean; filePaths: string[] } = { canceled: false, filePaths: ["/tmp/import.json"] };
const fsState: { size: number; text: string; statThrows: boolean; readThrows: boolean } = {
  size: 100,
  text: "{}",
  statThrows: false,
  readThrows: false,
};

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: dialogState.canceled, filePaths: dialogState.filePaths })),
  },
}));

// Read stat and contents from the same file handle to avoid a path-swap race.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  open: vi.fn(async () => {
    if (fsState.statThrows) throw new Error("ENOENT");
    return {
      stat: vi.fn(async () => ({ size: fsState.size })),
      readFile: vi.fn(async () => {
        if (fsState.readThrows) throw new Error("EIO");
        return fsState.text;
      }),
      close: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("../../../audit/dlp-filter.js", () => ({
  redactForLLM: vi.fn((s: string) => ({ redacted: s, totalCount: 0, counts: {} })),
  redactFsPath: vi.fn((s: string) => s),
  redactAuditPayload: vi.fn((p: unknown) => p),
  maskSensitiveData: vi.fn((s: string) => ({ masked: s, findings: [] })),
  isPiiRedactionEnabled: vi.fn(() => false),
  initDlpAudit: vi.fn(),
  initPiiRedactionPolicy: vi.fn(),
}));
vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() })),
}));

interface ImportResult {
  ok: boolean;
  sessionId?: string;
  messageCount?: number;
  error?: string;
  canceled?: boolean;
}

function makeDeps() {
  return {
    conversationLoop: { getSessionId: vi.fn(() => "active"), listSessions: vi.fn(() => []) } as any,
    settingsService: { get: vi.fn(() => ({})), patch: vi.fn(async () => undefined) } as any,
    memoryManager: {
      saveImportedSession: vi.fn(async () => undefined),
      saveSession: vi.fn(async () => undefined),
      saveSessionMetadata: vi.fn(async () => undefined),
    } as any,
    auditLogger: { log: vi.fn() } as any,
    getMainWindow: vi.fn(() => null),
  };
}

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerChatHandlers } = await import("../chat.js");
  const deps = makeDeps();
  registerChatHandlers(deps as any);
  return deps;
}

function setFile(obj: unknown): void {
  fsState.text = JSON.stringify(obj);
  fsState.size = Buffer.byteLength(fsState.text);
}

function invoke(): Promise<ImportResult> {
  // A null event uses the internal-caller seam accepted by validateSender.
  return Promise.resolve(invokeRegisteredHandler<Promise<ImportResult>>(handlers, CHANNEL));
}

const validExport = {
  sessionId: "original-session-id",
  exportedAt: "2026-07-05T00:00:00.000Z",
  messages: [
    { role: "user", content: "hello there" },
    { role: "assistant", content: "hi back", thought: "reasoning" },
    { role: "tool_result", toolUseId: "tu-1", content: "result", toolName: "Read", isError: false },
  ],
};

beforeEach(() => {
  dialogState.canceled = false;
  dialogState.filePaths = ["/tmp/import.json"];
  fsState.statThrows = false;
  fsState.readThrows = false;
});

describe("ave:chat:import — success round-trip", () => {
  it("imports a valid export as a BRAND-NEW session (never the original id)", async () => {
    const deps = await setup();
    setFile(validExport);

    const result = await invoke();

    expect(result.ok).toBe(true);
    expect(result.messageCount).toBe(3);
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId).not.toBe("original-session-id");
    expect(deps.memoryManager.saveImportedSession).toHaveBeenCalledTimes(1);
    const [savedId, savedMessages] = deps.memoryManager.saveImportedSession.mock.calls[0];
    expect(savedId).toBe(result.sessionId);
    expect(savedMessages).toHaveLength(3);
    expect(savedMessages[1]).toEqual({ role: "assistant", content: "hi back", thought: "reasoning" });
    expect(savedMessages[2]).toEqual({ role: "tool_result", toolUseId: "tu-1", content: "result", toolName: "Read", isError: false });
  });

  it("accepts array (multi-part) user content", async () => {
    const deps = await setup();
    setFile({
      ...validExport,
      messages: [{ role: "user", content: [{ type: "text", text: "part" }] }],
    });

    const result = await invoke();
    expect(result.ok).toBe(true);
    expect(deps.memoryManager.saveImportedSession).toHaveBeenCalledTimes(1);
  });
});

describe("ave:chat:import — canonical attachment storage", () => {
  it("canonicalizes verified local multipart attachments before persistence", async () => {
    const deps = await setup();
    setFile({
      ...validExport,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "keep" },
          {
            type: "image",
            image: "data:IMAGE/PNG;base64,iVBORw0KGgo=",
            mimeType: "IMAGE/PNG",
            width: 8,
            height: 8,
            bytes: 8,
          },
          {
            type: "file",
            data: "data:TEXT/PLAIN;base64,SGVsbG8=",
            mimeType: "TEXT/PLAIN",
          },
        ],
      }],
    });

    const result = await invoke();
    expect(result.ok).toBe(true);
    expect(deps.memoryManager.saveImportedSession).toHaveBeenCalledWith(
      result.sessionId,
      [{
        role: "user",
        content: [
          { type: "text", text: "keep" },
          { type: "image", image: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", width: 8, height: 8 },
          { type: "file", data: "data:text/plain;base64,SGVsbG8=", mimeType: "text/plain" },
        ],
      }],
    );
  });
});

describe("ave:chat:import — rejection branches (fail-closed)", () => {
  it("returns canceled when the user dismisses the file dialog", async () => {
    const deps = await setup();
    dialogState.canceled = true;

    const result = await invoke();
    expect(result).toEqual({ ok: false, canceled: true });
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });

  it("rejects a file larger than MAX_SESSION_FILE_BYTES before reading it", async () => {
    const deps = await setup();
    setFile(validExport);
    fsState.size = MAX_SESSION_FILE_BYTES + 1;

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "file-too-large" });
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });

  it("rejects non-JSON file content", async () => {
    await setup();
    fsState.text = "this is not json {";
    fsState.size = Buffer.byteLength(fsState.text);

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-json" });
  });

  it("rejects a file missing the top-level export shape", async () => {
    await setup();
    setFile({ messages: [{ role: "user", content: "x" }] }); // no sessionId/exportedAt

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-file-shape" });
  });

  it("rejects an empty messages array", async () => {
    await setup();
    setFile({ ...validExport, messages: [] });

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "empty-messages" });
  });

  it("rejects remote multipart attachment URLs rather than persisting them", async () => {
    const deps = await setup();
    setFile({
      ...validExport,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "do not partially import this" },
          { type: "image", image: "https://attacker.example/image.png", mimeType: "image/png" },
          { type: "file", data: "https://attacker.example/document.txt", mimeType: "text/plain" },
        ],
      }],
    });

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-message-shape" });
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });

  it("rejects invalid optional image metadata", async () => {
    const deps = await setup();
    const invalidMetadata = [
      { mimeType: 1 },
      { width: -1 },
      { height: 1.5 },
      { bytes: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const metadata of invalidMetadata) {
      setFile({
        ...validExport,
        messages: [{
          role: "user",
          content: [{
            type: "image",
            image: "data:image/png;base64,iVBORw0KGgo=",
            ...metadata,
          }],
        }],
      });
      expect(await invoke()).toEqual({ ok: false, error: "invalid-message-shape" });
    }
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });


  it("rejects an oversized multipart array before validating each part", async () => {
    const deps = await setup();
    setFile({
      ...validExport,
      messages: [{
        role: "user",
        content: Array.from(
          { length: MAX_LOCAL_USER_CONTENT_PARTS + 1 },
          () => ({ type: "text", text: "bounded" }),
        ),
      }],
    });

    expect(await invoke()).toEqual({ ok: false, error: "invalid-message-shape" });
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });

  it("rejects multipart user text over the part or aggregate-character cap", async () => {
    const deps = await setup();
    setFile({
      ...validExport,
      messages: [{
        role: "user",
        content: Array.from(
          { length: MAX_LOCAL_USER_CONTENT_TEXT_PARTS + 1 },
          (_, index) => ({ type: "text", text: `part ${index}` }),
        ),
      }],
    });
    expect(await invoke()).toEqual({ ok: false, error: "invalid-message-shape" });

    setFile({
      ...validExport,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "x".repeat(MAX_LOCAL_USER_CONTENT_TEXT_CHARS) },
          { type: "text", text: "x" },
        ],
      }],
    });
    // Keep fstat below the independent byte cap so the test reaches composition validation.
    fsState.size = MAX_SESSION_FILE_BYTES;
    expect(await invoke()).toEqual({ ok: false, error: "invalid-message-shape" });
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });

  it("rejects a message with an unknown role (whole import fails, no partial)", async () => {
    const deps = await setup();
    setFile({
      ...validExport,
      messages: [{ role: "user", content: "ok" }, { role: "system", content: "nope" }],
    });

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-message-shape" });
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });

  it("rejects a message carrying an unknown field (arbitrary-field smuggling)", async () => {
    await setup();
    setFile({
      ...validExport,
      messages: [{ role: "user", content: "ok", extra: 1 }],
    });

    const result = await invoke();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-message-shape");
  });

  it("rejects a __proto__ pollution attempt via the REAL JSON.parse path", async () => {
    await setup();
    // Use raw JSON for __proto__; object-literal syntax sets the prototype without creating an own key.
    fsState.text =
      '{"sessionId":"s","exportedAt":"2026-07-05T00:00:00.000Z",' +
      '"messages":[{"role":"user","content":"ok","__proto__":{"polluted":true}}]}';
    fsState.size = Buffer.byteLength(fsState.text);

    const parsed = JSON.parse(fsState.text);
    expect(Object.prototype.hasOwnProperty.call(parsed.messages[0], "__proto__")).toBe(true);

    const result = await invoke();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-message-shape");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects an import whose messages array exceeds MAX_IMPORTED_MESSAGES", async () => {
    const deps = await setup();
    // Stay below the byte cap to isolate the independent message-count limit.
    const many = Array.from({ length: 100_001 }, () => ({ role: "user", content: "x" }));
    setFile({ ...validExport, messages: many });

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "too-many-messages" });
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });

  it("accepts rows carrying meta — this app's own export writes it — and keeps none of it", async () => {
    // Accept exported meta but rebuild it from allowed fields so imported identity or compact boundaries cannot be forged.
    const deps = await setup();
    setFile({
      ...validExport,
      messages: [
        {
          role: "user",
          content: "hello there",
          meta: { messageId: "borrowed-row-id", compactBoundary: true, compactNum: 9 },
        },
        { role: "assistant", content: "hi back", meta: { messageId: "another-borrowed-id" } },
        {
          role: "tool_result",
          toolUseId: "tu-1",
          content: "result",
          meta: { messageId: "third-borrowed-id" },
        },
      ],
    });

    const result = await invoke();

    expect(result.ok).toBe(true);
    const [, savedMessages] = deps.memoryManager.saveImportedSession.mock.calls[0];
    expect(savedMessages).toHaveLength(3);
    expect(JSON.stringify(savedMessages)).not.toContain("borrowed-row-id");
    expect(JSON.stringify(savedMessages)).not.toContain("compactBoundary");
  });

  it("rejects a tool_result missing its required toolUseId", async () => {
    await setup();
    setFile({
      ...validExport,
      messages: [{ role: "tool_result", content: "result" }],
    });

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-message-shape" });
  });

  it("rejects an assistant toolCalls block with a bad shape", async () => {
    await setup();
    setFile({
      ...validExport,
      messages: [{ role: "assistant", content: "x", toolCalls: [{ name: "t" }] }], // missing id/input
    });

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-message-shape" });
  });
});
