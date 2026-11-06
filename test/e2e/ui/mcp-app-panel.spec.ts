import { test, expect, type ElectronFixtures } from './fixtures.js';
import { launchElectron, buildIsolatedElectronEnv, buildLlmSettings, MAIN_ENTRY } from './seeded-electron.js';
import type { ElectronApplication, Page } from 'playwright';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';

type FixtureContext = Pick<ElectronFixtures, 'app' | 'mainWindow' | 'aveHome' | 'userDataDir' | 'tempHome'>;
async function admittedApp({ app, mainWindow, aveHome, userDataDir, tempHome }: FixtureContext) {
  await mainWindow.getByTestId('sidebar-settings').click();
  await mainWindow.getByRole('tab', { name: 'Permissions', exact: true }).click();
  await mainWindow.getByTestId('home-trust-approve-all').click();
  await expect(mainWindow.getByTestId('home-trust-done')).toBeVisible();
  await app.close();
  const restarted = await launchElectron({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: buildIsolatedElectronEnv({ HOME: tempHome, USERPROFILE: tempHome, AVE_HOME: aveHome, AVE_DEV: '1' }),
  });
  const page = await restarted.firstWindow();
  await page.getByTestId('sidebar-group-plugins').waitFor();
  return { app: restarted, page };
}
async function openPanel(app: ElectronApplication, page: Page) {
  await page.getByTestId('sidebar-group-plugins').click();
  await page.getByRole('menuitem', { name: 'View Fixture', exact: true }).click();
  await expect.poll(() => app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('ave-mcp-app://'));
    return guest ? guest.executeJavaScript("document.querySelector('iframe')?.contentDocument?.getElementById('status')?.textContent") : null;
  })).toBe('Standard app ready');
}
async function stageFromPanel(app: ElectronApplication) {
  await app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('ave-mcp-app://'));
    if (!guest) throw new Error('App guest not found');
    await guest.executeJavaScript("document.querySelector('iframe').contentDocument.getElementById('draft').click()");
  });
}

async function clickHostTool(page: Page, method: string, payload: unknown) {
  await page.evaluate(({ method, payload }) => {
    const button = document.createElement('button');
    button.dataset.testid = 'fixture-host-tool'; button.textContent = 'Fixture action';
    button.style.cssText = 'position:fixed;top:40px;left:50%;z-index:2147483647';
    button.onclick = async () => {
      try {
        await window.aveApi.callPluginMethod(method, payload, { userAction: true });
        button.dataset.result = 'ok';
      } catch (error) { button.dataset.result = String(error); }
    };
    document.body.append(button);
  }, { method, payload });
  const button = page.getByTestId('fixture-host-tool');
  await button.click();
  await expect(button).toHaveAttribute('data-result', 'ok');
  await button.evaluate((node) => node.remove());
}

test('sidebar app messages fill the composer without sending a turn', async ({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome }, testInfo) => {
  test.setTimeout(120_000);
  const { app, page } = await admittedApp({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome });
  try {
    await openPanel(app, page);
    await page.screenshot({ path: testInfo.outputPath('sidebar.png') });
    await stageFromPanel(app);
    await page.getByTestId('pane-close').click();
    await expect(page.locator('textarea').first()).toHaveValue('Review the selected fixture item');
    await expect(page.getByTestId('composer-send-button')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('composer-draft.png') });
    const composer = page.locator('textarea').first();
    await composer.fill(''); await composer.fill('Keep my user draft');
    await page.getByTestId('pane-split').first().click();
    await page.getByTestId('pane-split-row').click();
    await openPanel(app, page);
    await composer.focus();
    await composer.press('End');
    await stageFromPanel(app);
    await expect(page.getByRole('button', { name: 'Replace draft', exact: true })).toBeVisible();
    await expect(composer).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await composer.press('Space'); await composer.press('x');
    await expect(composer).toHaveValue('Keep my user draft x');
    await expect(page.getByRole('button', { name: 'Replace draft', exact: true })).toBeVisible();
    const evidence = await composer.evaluate((node) => ({ focused: document.activeElement === node, value: (node as HTMLTextAreaElement).value }));
    writeFileSync(testInfo.outputPath('composer-focus.json'), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: testInfo.outputPath('pending-app-draft.png') });
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(composer).toHaveValue('Keep my user draft x');
    await stageFromPanel(app);
    await page.getByRole('button', { name: 'Replace draft', exact: true }).click();
    await expect(composer).toHaveValue('Review the selected fixture item');
  } finally { await app.close(); }
});

test('an app draft queued during streaming starts its next turn with app provenance', async ({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome }, testInfo) => {
  test.setTimeout(120_000);
  let finishInitial: (() => void) | undefined;
  const requestTexts: unknown[] = [];
  const complete = (response: ServerResponse) => {
    for (const [delta, finishReason] of [[{ content: 'Fixture response complete.' }, null], [{}, 'stop']] as const) {
      response.write(`data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 0,
        model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] })); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const last = body.messages?.findLast((message: { role: string }) => message.role === 'user')?.content;
    const text = Array.isArray(last) ? last.find((part: { type: string }) => part.type === 'text')?.text : last;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    requestTexts.push(text);
    if (text === 'Hold the fixture turn' && !finishInitial) { finishInitial = () => complete(response); response.flushHeaders(); }
    else complete(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { app, page } = await admittedApp({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome });
  try {
    await page.getByTestId('pane-close').click();
    const settings = buildLlmSettings('openai-compatible', 'fixture-model');
    const llm = settings.llm as { vendors: Record<string, { baseUrl?: string }> };
    llm.vendors['openai-compatible'].baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await page.evaluate(async (llm) => {
      await window.aveApi.updateSettings({ llm });
      const events: unknown[] = [];
      (window as unknown as { __appDraftEvents: unknown[] }).__appDraftEvents = events;
      window.aveApi.onChatStream((event) => { if (event.type === 'user_message') events.push(event); });
    }, llm);
    const composer = page.locator('[data-composer-surface="main"] textarea');
    await composer.fill('Hold the fixture turn'); await composer.press('Enter');
    await expect.poll(() => Boolean(finishInitial)).toBe(true);
    await openPanel(app, page); await stageFromPanel(app);
    await page.getByTestId('pane-close').click();
    await expect(composer).toHaveValue('Review the selected fixture item');
    await composer.press('Enter');
    await expect(page.getByTestId('message-queue-row-text')).toHaveText('Review the selected fixture item');
    await page.screenshot({ path: testInfo.outputPath('app-draft-queued.png') });
    finishInitial!();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __appDraftEvents: Array<{ origin?: string }> }).__appDraftEvents
      .some((event) => event.origin === 'app-emitted'))).toBe(true);
    const events = await page.evaluate(() => (window as unknown as { __appDraftEvents: unknown[] }).__appDraftEvents);
    await expect(page.getByText('app:viewfixture', { exact: true }).first()).toBeVisible();
    const evidencePath = testInfo.outputPath('host-resolved-origins.json');
    writeFileSync(evidencePath, JSON.stringify({ events, requestTexts }, null, 2));
    await testInfo.attach('host-resolved-origins', { path: evidencePath, contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('app-emitted-turn.png') });
  } finally {
    await app.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a dock auth identity change remounts its app without app-tool auth denials', async ({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome }, testInfo) => {
  test.setTimeout(120_000);
  const { app, page } = await admittedApp({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome });
  const messages: string[] = [];
  app.on('console', (message) => messages.push(message.text()));
  try {
    await clickHostTool(page, 'viewfixture_open_dock', {});
    const guestId = () => app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .find((contents) => contents.getURL().startsWith('ave-mcp-app://'))?.id);
    await expect.poll(guestId).toBeTruthy();
    const before = await guestId();
    await clickHostTool(page, 'viewfixture_set_auth', { authenticated: false });
    await expect.poll(guestId, { timeout: 15_000 }).not.toBe(before);
    await expect.poll(guestId).toBeTruthy();
    expect(messages.join('\n')).not.toContain('MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE');
    expect(messages.join('\n')).not.toContain('tools/call denied or failed');
    const audit = await page.evaluate(() => window.aveApi.audit.search({ textSearch: "MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE", limit: 100 }));
    expect(audit).toMatchObject({ total: 0, entries: [] });
    const dock = app.windows().find((window) => window.url().includes('floating-dock-window.html'));
    if (!dock) throw new Error('Dock window not found');
    await dock.screenshot({ path: testInfo.outputPath('auth-remounted-dock.png') });
    const evidencePath = testInfo.outputPath('dock-auth-lifetime.json');
    writeFileSync(evidencePath, JSON.stringify({ before, after: await guestId(), messages, audit }, null, 2));
    await testInfo.attach('dock-auth-lifetime', { path: evidencePath, contentType: 'application/json' });
  } finally { await app.close(); }
});
