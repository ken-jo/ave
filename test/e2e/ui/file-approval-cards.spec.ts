import { writePermissionSettingsFixture } from "../../../src/__tests__/support/permission-settings-fixture.js";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildE2eBaseSettings, buildLlmSettings, builtMainExists, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";

/**
 * File approval cards raised by real tool calls: a scripted local model asks for one file tool per user message, the host
 * decides through the permission tree, and the card the person sees is checked for what it names.
 * Every card is denied, and the file on disk is checked afterwards.
 */
const RLO = String.fromCodePoint(0x202e);

type ToolCase = { name: string; args: Record<string, unknown> };

test("file tools raise cards that name the reason, the real target and each choice", async () => {
  test.setTimeout(240_000);
  expect(builtMainExists()).toBe(true);
  // Outside every allowed directory (the allowed list covers the temp folders), in its on-disk spelling: mixed case, to show
  // the card does not case-fold it. Every card is denied, so nothing but this fixture folder is written there.
  const outside = realpathSync(mkdtempSync(join(homedir(), ".E2E-File-Approval-Outside-")));
  const escapeTarget = join(outside, "Real-Target.txt");
  writeFileSync(escapeTarget, "outside resource\n");
  const spoofedName = `report${RLO}txt.md`;
  const cases: Record<string, ToolCase> = {
    write: { name: "write_file", args: { path: spoofedName, content: "new file\n" } },
    edit: { name: "edit_file", args: { path: "src/index.ts", oldText: "const a = 1;", newText: "const a = 2;" } },
    secret: { name: "read_file", args: { path: ".env" } },
    protected: { name: "write_file", args: { path: ".git/config", content: "[core]\n\thooksPath = /tmp/hooks\n" } },
    outside: { name: "write_file", args: { path: join(outside, "out.txt"), content: "outside write\n" } },
    escape: { name: "write_file", args: { path: "linked.txt", content: "through the link\n" } },
  };
  const model = "file-approval-model";
  const toolResults: Array<{ role: string; content: unknown }> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ role: string; content: unknown }>; tools?: unknown[];
    };
    const messages = body.messages ?? [];
    const last = messages.at(-1);
    const text = (content: unknown): string => typeof content === "string" ? content
      : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";
    const asked = [...messages].reverse().find((message) => message.role === "user");
    const key = /case:([a-z]+)/u.exec(text(asked?.content))?.[1];
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (delta: Record<string, unknown>, finish: string | null) => response.write(`data: ${JSON.stringify({
      id: "file-approval", object: "chat.completion.chunk", created: 0, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    const scripted = key === undefined ? undefined : cases[key];
    if (last?.role === "tool") {
      toolResults.push(last);
      send({ role: "assistant", content: `Finished case ${key}.` }, null);
      send({}, "stop");
    } else if (scripted !== undefined && (body.tools?.length ?? 0) > 0) {
      send({ role: "assistant", tool_calls: [{ index: 0, id: `file-approval-${key}`, type: "function",
        function: { name: scripted.name, arguments: JSON.stringify(scripted.args) } }] }, null);
      send({}, "tool_calls");
    } else {
      // A request that is not a scripted turn (no tools, or no case marker) gets plain text and no tool call.
      send({ role: "assistant", content: "No tool call." }, null);
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const settings = buildLlmSettings("openai-compatible", model);
  settings.appearance = buildE2eBaseSettings(true, "en").appearance;
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl =
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  try {
    ctx = await launchSeededElectron({ sessionTitle: "File approval cards", settings, historyRows: [] });
    const { app, page } = ctx;
    writePermissionSettingsFixture(ctx.aveHome, JSON.stringify({ permissions: { reviewer: { interactive: { autoApprove: "off" } } } }));
    await setWindowSize(app, 1100, 860);
    // The session's project is the managed workspace the host anchored its working directory at.
    const project = await app.evaluate(() => process.cwd());
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "src", "index.ts"), "const a = 1;\nexport default a;\n");
    writeFileSync(join(project, ".env"), "FIXTURE_SECRET=not-a-real-secret\n");
    writeFileSync(join(project, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    symlinkSync(escapeTarget, join(project, "linked.txt"));
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-file-approval");
      const mode = await window.ave.permission.setMode("strict");
      if (!mode.ok) throw new Error("Could not select strict tool approval");
    });
    const composer = page.locator('[data-composer-surface="main"] [data-testid="composer-textarea"]');
    const dock = page.getByTestId(TEST_IDS.approvalDock).first();
    const panel = dock.getByTestId("tool-approval-panel");
    const raise = async (key: string) => {
      await composer.fill(`Please run case:${key}`);
      await composer.press("Enter");
      const scripted = cases[key];
      if (scripted === undefined) throw new Error(`No scripted case: ${key}`);
      await expect(panel).toHaveAttribute("data-approval-tool-name", scripted.name, { timeout: 30_000 });
    };
    const deny = async (key: string) => {
      await dock.getByTestId(TEST_IDS.denyButton).click();
      await expect(page.getByTestId("chat-main-column").getByText(`Finished case ${key}.`, { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(TEST_IDS.approvalDock)).toHaveCount(0);
    };
    const reason = dock.getByTestId("approval-ask-reason");

    // In-project write, 기본 mode: an ordinary card. The reason is worded for a person, and the hidden character in the name is spelled out.
    await raise("write");
    await expect(reason).toHaveText("This file change needs your approval.");
    await expect(reason).toHaveAttribute("data-reason-code", "file-write");
    await expect(dock.getByTestId("approval-action-primary")).toContainText("report⟨U+202E⟩txt.md");
    await expect(dock.getByTestId("approval-hidden-characters-warning")).toBeVisible();
    expect(await dock.textContent()).not.toContain(RLO);
    // The managed workspace is not reached through a link, so the card shows no second location and is not forced.
    await expect(dock.getByTestId("approval-real-target")).toHaveCount(0);
    await expect(dock.getByTestId(TEST_IDS.allowSessionButton)).toBeVisible();
    await expect(dock.getByText("This write requires approval.", { exact: false })).toHaveCount(0);
    await test.info().attach("write-card", { body: await page.screenshot(), contentType: "image/png" });
    await deny("write");
    expect(existsSync(join(project, spoofedName))).toBe(false);

    // In-project edit: the same ordinary write reason.
    await raise("edit");
    await expect(reason).toHaveText("This file change needs your approval.");
    await expect(dock.getByTestId("approval-real-target")).toHaveCount(0);
    await deny("edit");
    expect(readFileSync(join(project, "src", "index.ts"), "utf8")).toBe("const a = 1;\nexport default a;\n");

    // Secret read: the reason and the pattern that matched.
    await raise("secret");
    await expect(reason).toHaveText("This file may hold secrets, so reading it needs your approval.");
    await expect(reason).toHaveAttribute("data-reason-code", "secret-read");
    await expect(dock.getByTestId("approval-secret-pattern")).toHaveText("Matched secret pattern: **/.env");
    await expect(dock.getByText("Reading this secret file requires approval.", { exact: false })).toHaveCount(0);
    await test.info().attach("secret-read-card", { body: await page.screenshot(), contentType: "image/png" });
    await deny("secret");
    expect(JSON.stringify(toolResults.at(-1))).not.toContain("not-a-real-secret");

    // Protected path: forced, once only, and the matched entry is named in a sentence instead of as a bare token.
    await raise("protected");
    await expect(reason).toHaveText("Protected path (.git): a change here needs your approval every time.");
    await expect(reason).toHaveAttribute("data-reason-code", "protected-path");
    await test.info().attach("protected-path-card", { body: await page.screenshot(), contentType: "image/png" });
    await deny("protected");
    expect(readFileSync(join(project, ".git", "config"), "utf8")).toBe("[core]\n\trepositoryformatversion = 0\n");

    // Outside-project write: one folder card. Each choice is worded as a condition; nothing reads as decided beforehand.
    await raise("outside");
    const target = dock.getByTestId("approval-decision-target");
    await expect(dock.getByTestId(TEST_IDS.denyButton)).toBeFocused();
    await expect(target).toHaveText("If denied: the tool gets no access to this path.");
    await expect(dock.getByText("Access will be denied")).toHaveCount(0);
    await dock.getByTestId(TEST_IDS.allowSessionButton).focus();
    await expect(target).toHaveText(/^If you allow this folder: .*\.e2e-file-approval-outside-/iu);
    await dock.getByTestId(TEST_IDS.approveButton).focus();
    await expect(target).toHaveText(/^If you allow once: .*out\.txt$/iu);
    await expect(dock.getByTestId("approval-real-target")).toHaveCount(0);
    await test.info().attach("outside-project-card", { body: await page.screenshot(), contentType: "image/png" });
    await dock.getByTestId(TEST_IDS.denyButton).focus();
    await deny("outside");
    expect(existsSync(join(outside, "out.txt"))).toBe(false);

    // Symlink escape: the card names where the write really lands, in its on-disk spelling, and why the host asks.
    await raise("escape");
    await expect(reason).toHaveText("This path leads outside the project through a link. Approving acts on the real target.");
    await expect(reason).toHaveAttribute("data-reason-code", "project-escape");
    await expect(dock.getByTestId("approval-real-target")).toHaveText(`Real target: ${escapeTarget}`);
    // Forced cards offer no folder grant, so no folder guidance is shown.
    await dock.getByTestId(TEST_IDS.approvalReviewDetails).locator("summary").first().click();
    await expect(dock.getByTestId("approval-path-grant-candidate")).toBeVisible();
    await expect(dock.getByTestId("approval-path-grant-parent")).toHaveCount(0);
    await expect(dock.getByTestId("approval-folder-project-hint")).toHaveCount(0);
    await test.info().attach("symlink-escape-card", { body: await page.screenshot(), contentType: "image/png" });
    await deny("escape");
    expect(readFileSync(escapeTarget, "utf8")).toBe("outside resource\n");
  } finally {
    // The fixture folder sits in the runner's home, so it and the server are released even when the launch itself fails.
    if (ctx !== undefined) await teardownSeededElectron(ctx, { terminate: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(outside, { recursive: true, force: true });
  }
});
