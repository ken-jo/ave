import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AskpassBroker, promptHost, TOKEN_USERNAME } from "../askpass.js";

function runLauncher(broker: AskpassBroker, env: Record<string, string>, prompt: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(broker.launcherPath, [prompt], { env: { PATH: process.env.PATH ?? "", ...env } }, (error, stdout) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout) }),
    );
  });
}

describe("promptHost", () => {
  it.each([
    ["Username for 'https://github.com': ", { field: "username", host: "github.com" }],
    ["Password for 'https://x-access-token@GitHub.com.': ", { field: "password", host: "github.com" }],
    ["Password for 'http://127.0.0.1:8080': ", { field: "password", host: "127.0.0.1" }],
  ] as const)("%j", (prompt, expected) => {
    expect(promptHost(prompt)).toEqual(expected);
  });

  it("ignores prompts that are not credential prompts", () => {
    expect(promptHost("Are you sure you want to continue connecting (yes/no)? ")).toBeNull();
    expect(promptHost("Password for 'not a url': ")).toBeNull();
  });
});

describe("AskpassBroker", () => {
  let broker: AskpassBroker | null = null;
  afterEach(async () => {
    await broker?.close();
    broker = null;
  });

  it("answers only prompts naming the ticket's host, only while the ticket lives", async () => {
    broker = await AskpassBroker.start({ getToken: (host) => (host === "github.com" ? "ghs_token" : null) });
    const ticket = broker.issueTicket({ host: "github.com", sourceId: "ave" });
    const id = ticket.env.AVE_ASKPASS_TICKET!;
    expect(broker.answer(id, "Username for 'https://github.com': ")).toBe(TOKEN_USERNAME);
    expect(ticket.credentialOffered()).toBe(false);
    expect(broker.answer(id, "Password for 'https://x-access-token@github.com': ")).toBe("ghs_token");
    expect(ticket.credentialOffered()).toBe(true);
    expect(broker.answer(id, "Password for 'https://evil.example': ")).toBe("");
    expect(broker.answer("forged", "Password for 'https://github.com': ")).toBe("");
    ticket.revoke();
    expect(broker.answer(id, "Password for 'https://github.com': ")).toBe("");
  });

  it("asks for the token with the ticket's source, so a token typed into a preview answers that preview only", async () => {
    broker = await AskpassBroker.start({ getToken: (host, sourceId) => (sourceId === "preview-1" ? "typed" : host === "github.com" ? "stored" : null) });
    const preview = broker.issueTicket({ host: "github.com", sourceId: "preview-1" });
    const other = broker.issueTicket({ host: "github.com", sourceId: "ave" });
    expect(broker.answer(preview.env.AVE_ASKPASS_TICKET!, "Password for 'https://github.com': ")).toBe("typed");
    expect(broker.answer(other.env.AVE_ASKPASS_TICKET!, "Password for 'https://github.com': ")).toBe("stored");
    expect(broker.hasToken("github.com", "ave")).toBe(true);
    expect(broker.hasToken("git.example", "ave")).toBe(false);
  });

  it("answers nothing when no token is stored for the host", async () => {
    broker = await AskpassBroker.start({ getToken: () => null });
    const ticket = broker.issueTicket({ host: "git.example", sourceId: "custom" });
    expect(broker.answer(ticket.env.AVE_ASKPASS_TICKET!, "Username for 'https://git.example': ")).toBe("");
  });

  it.skipIf(process.platform === "win32")("the launcher round-trips through the socket in a private directory", async () => {
    broker = await AskpassBroker.start({ getToken: () => "tok" });
    const dirMode = statSync(broker.launcherPath.replace(/\/[^/]+$/u, "")).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const ticket = broker.issueTicket({ host: "git.example", sourceId: "custom" });
    expect(await runLauncher(broker, ticket.env, "Password for 'https://git.example': ")).toEqual({ code: 0, stdout: "tok\n" });
    expect(await runLauncher(broker, ticket.env, "Password for 'https://other.example': ")).toEqual({ code: 0, stdout: "\n" });
    expect((await runLauncher(broker, {}, "Password for 'https://git.example': ")).code).not.toBe(0);
  });

  it.skipIf(process.platform === "win32")("listens outside a directory too deep for a unix socket, and removes both on close", async () => {
    const deep = join(mkdtempSync(join(tmpdir(), "ave-askpass-deep-")), "x".repeat(80));
    mkdirSync(deep, { recursive: true });
    try {
      const long = await AskpassBroker.start({ getToken: () => "tok", parentDir: deep });
      expect(Buffer.byteLength(long.endpoint)).toBeLessThanOrEqual(103);
      expect(long.launcherPath.startsWith(deep)).toBe(true);
      expect(statSync(dirname(long.endpoint)).mode & 0o777).toBe(0o700);
      const ticket = long.issueTicket({ host: "git.example", sourceId: "custom" });
      expect(await runLauncher(long, ticket.env, "Password for 'https://git.example': ")).toEqual({ code: 0, stdout: "tok\n" });
      await long.close();
      expect(existsSync(dirname(long.endpoint))).toBe(false);
      expect(existsSync(dirname(long.launcherPath))).toBe(false);
    } finally {
      rmSync(dirname(deep), { recursive: true, force: true });
    }
  });

  it("refuses new tickets and removes its directory after close", async () => {
    const closing = await AskpassBroker.start({ getToken: () => null });
    const launcher = closing.launcherPath;
    await closing.close();
    expect(() => closing.issueTicket({ host: "a", sourceId: "b" })).toThrow("closed");
    expect(() => statSync(launcher)).toThrow();
  });
});
