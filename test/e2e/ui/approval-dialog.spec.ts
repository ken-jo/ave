import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { TEST_IDS } from "../../../src/shared/test-ids.js";

// Geometry coverage needs no seeded plugin.
test.use({ seedViewFixturePlugin: false });

async function currentSessionId(mainWindow: Page): Promise<string> {
  return mainWindow.evaluate(async () => {
    const api = (window as unknown as {
      aveApi?: { chatSessions?: (opts?: { kind?: string }) => Promise<{ current?: string }> };
    }).aveApi;
    if (typeof api?.chatSessions !== 'function') {
      throw new Error('window.aveApi.chatSessions unavailable');
    }
    const listed = await api.chatSessions({ kind: 'main' });
    if (typeof listed.current !== 'string' || listed.current.length === 0) {
      throw new Error('current chat session id unavailable');
    }
    return listed.current;
  });
}

test('approval toast returns to the requesting conversation and focuses its card', async ({ app, mainWindow }, testInfo) => {
  const sessionId = await currentSessionId(mainWindow);
  const features = mainWindow.getByTestId('sidebar-group-features');
  if ((await features.getAttribute('aria-expanded')) !== 'true') await features.click();
  await mainWindow.getByTestId('toolbar-work-board').click();
  await expect(mainWindow.getByTestId('work-board-panel')).toBeVisible();
  await app.evaluate(({ BrowserWindow }, sid) => {
    const win = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible());
    if (!win) throw new Error('Visible window unavailable');
    win.webContents.send('ave:approval:request', {
      id: 'approval-notice-e2e', sessionId: sid, category: 'tool', kind: 'tool',
      toolName: 'write_file', toolCategory: 'write', source: 'builtin', trustOrigin: 'user-keyboard',
      args: { path: '/workspace/views.c4' }, reason: 'User confirmation required (category: write, trust: high)',
      createdAt: Date.now(), requireExplicit: false,
    });
    win.webContents.send('ave:notification:toast', {
      kind: 'approval', title: 'Approval needed', body: 'Write views.c4 · Conversation: Set up diagrams',
      contextRef: { approvalId: 'approval-notice-e2e', sessionId: sid },
    });
  }, sessionId);
  await expect(mainWindow.getByRole('button', { name: /Return to conversation|대화로 돌아가기/ })).toBeVisible();
  await mainWindow.screenshot({ path: testInfo.outputPath('covered-approval.png') });
  await mainWindow.getByRole('button', { name: /Learn more|자세히 알아보기/ }).click();
  await expect(mainWindow.getByTestId('work-board-panel')).not.toBeVisible();
  const panel = mainWindow.getByTestId('tool-approval-panel');
  await expect(panel).toHaveAttribute('data-approval-request-id', 'approval-notice-e2e');
  await expect(panel).toBeFocused();
  await mainWindow.screenshot({ path: testInfo.outputPath('conversation-approval.png') });
});

// Inject a real main-to-renderer request to verify route-independent approval without an ambient tool run.
test('approval dock floats over the route without changing its layout', async ({
  app,
  mainWindow,
}) => {
  // Session ownership determines composer blocking and focus; sessionless requests belong in the lane.
  const sessionId = await currentSessionId(mainWindow);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.setContentSize(460, 841);
  });
  await expect.poll(() => mainWindow.evaluate(() => (
    Math.abs(window.innerWidth - 460) <= 1
    && Math.abs(window.innerHeight - 841) <= 1
  ))).toBe(true);

  const sidebarToggle = mainWindow.getByTestId('sidebar-collapse-toggle');
  if ((await sidebarToggle.getAttribute('aria-pressed')) !== 'true') {
    await sidebarToggle.click();
  }
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true');

  const featuresGroup = mainWindow.getByTestId('sidebar-group-features');
  const openWorkBoard = async () => {
    if ((await featuresGroup.getAttribute('aria-expanded')) !== 'true') {
      await featuresGroup.click();
    }
    await mainWindow.getByTestId('toolbar-work-board').click();
  };
  await openWorkBoard();
  const workBoardPanel = mainWindow.getByTestId('work-board-panel');
  await expect(workBoardPanel).toBeVisible();
  const routeBefore = await workBoardPanel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });

  // Release sidebar focus before checking card autofocus; another surface must keep its caret.
  await mainWindow.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });

  await app.evaluate(({ BrowserWindow }, sid) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.webContents.send('ave:approval:request', {
      id: 'approval-dock-e2e',
      sessionId: sid,
      category: 'tool',
      kind: 'tool',
      toolName: `read_file_${'long_identity_'.repeat(16)}`,
      toolCategory: 'read',
      source: 'builtin',
      trustOrigin: 'user-keyboard',
      args: { path: 'C:\\workspace\\approval-dock-e2e.txt' },
      reason: 'deterministic approval dock e2e fixture',
      createdAt: Date.now(),
      requireExplicit: false,
    });
  }, sessionId);

  const dock = mainWindow.getByTestId(TEST_IDS.approvalDock).first();
  await expect(dock).toBeVisible();
  await expect(dock).toHaveAttribute('role', 'region');
  await expect(dock).not.toHaveAttribute('aria-modal', 'true');
  await expect(dock.locator('[role="dialog"], [role="alertdialog"]')).toHaveCount(0);
  expect(await mainWindow.locator('body').getAttribute('data-scroll-locked')).toBeNull();
  expect(await mainWindow.locator('main').getAttribute('inert')).toBeNull();
  await expect(mainWindow.locator('main')).not.toHaveAttribute('aria-hidden', 'true');

  const geometry = await dock.evaluate((element) => {
    const root = element as HTMLElement;
    const canvas = root.closest<HTMLElement>('[data-testid="route-canvas"]');
    const panel = root.querySelector<HTMLElement>('[data-testid="tool-approval-panel"]');
    const body = root.querySelector<HTMLElement>('[data-testid="tool-approval-card"] > section');
    const actions = root.querySelector<HTMLElement>('[data-testid="approval-decision-actions"]');
    const sidebar = document.querySelector<HTMLElement>('[data-testid="primary-sidebar"]');
    const rect = root.getBoundingClientRect();
    const canvasRect = canvas?.getBoundingClientRect();
    const sidebarRect = sidebar?.getBoundingClientRect();
    return {
      position: getComputedStyle(root).position,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      canvasLeft: canvasRect?.left ?? -1,
      canvasRight: canvasRect?.right ?? -1,
      canvasBottom: canvasRect?.bottom ?? -1,
      sidebarRight: sidebarRect?.right ?? -1,
      dockClientWidth: root.clientWidth,
      dockScrollWidth: root.scrollWidth,
      panelClientWidth: panel?.clientWidth ?? -1,
      panelScrollWidth: panel?.scrollWidth ?? -1,
      bodyOffsetWidth: body?.offsetWidth ?? -1,
      bodyClientWidth: body?.clientWidth ?? -1,
      bodyScrollWidth: body?.scrollWidth ?? -1,
      bodyClientHeight: body?.clientHeight ?? -1,
      bodyScrollHeight: body?.scrollHeight ?? -1,
      bodyScrollbarGutter: body ? getComputedStyle(body).scrollbarGutter : null,
      actionsClientWidth: actions?.clientWidth ?? -1,
      actionsScrollWidth: actions?.scrollWidth ?? -1,
    };
  });
  expect(geometry.position).toBe('absolute');
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.canvasLeft + 8);
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.sidebarRight + 8);
  expect(geometry.right).toBeLessThanOrEqual(geometry.canvasRight - 8);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.canvasBottom - 8);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.dockScrollWidth).toBeLessThanOrEqual(geometry.dockClientWidth);
  expect(geometry.panelScrollWidth).toBeLessThanOrEqual(geometry.panelClientWidth);
  expect(geometry.bodyScrollbarGutter).toBe('auto');
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.bodyClientWidth);
  if (geometry.bodyScrollHeight <= geometry.bodyClientHeight) {
    expect(geometry.bodyOffsetWidth - geometry.bodyClientWidth).toBeLessThanOrEqual(2);
  }
  expect(geometry.actionsClientWidth).toBeGreaterThan(0);
  expect(geometry.actionsScrollWidth).toBeLessThanOrEqual(geometry.actionsClientWidth);

  const approve = dock.getByTestId(TEST_IDS.approveButton);
  const deny = dock.getByTestId(TEST_IDS.denyButton);
  const allowAlways = dock.getByTestId(TEST_IDS.allowSessionButton);
  await expect(approve).toBeVisible();
  await expect(deny).toBeVisible();
  await expect(allowAlways).toBeVisible();
  await expect(allowAlways).toBeEnabled();
  await expect(deny).toBeFocused();
  await expect(dock.locator('input, textarea, [contenteditable="true"], [role="textbox"]'))
    .toHaveCount(0);
  await expect(dock.getByTestId('approval-tool-identity')).toContainText('read_file');
  await expect(dock.getByTestId('approval-impact-summary')).toBeVisible();
  await expect(dock.getByTestId(TEST_IDS.approvalReviewDetails)).not.toHaveAttribute('open', '');
  await expect(dock.getByText(/Review details|검토 상세/)).toBeVisible();
  await expect(dock.getByText(/Click to expand|펼쳐서 확인/)).toBeVisible();
  // Always deny lives in the Deny dropdown of the shared decision row (owner 2026-10-25, unified approval card).
  await expect(dock.getByTestId("approval-deny-menu")).toBeVisible();
  await expect(dock.getByTestId("approval-allow-menu")).toBeVisible();

  // Narrow cards must contain long translated action labels.
  const translatedControlOverflow = await dock.evaluate((element) => {
    const root = element as HTMLElement;
    const replacements = new Map<string, string>([
      ['deny-button', 'Ablehnen'],
      ['allow-session-button', 'Für diese Sitzung dauerhaft zulassen'],
      ['approve-button', 'Nur dieses eine Mal zulassen'],
    ]);
    for (const [testId, label] of replacements) {
      const control = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (control) control.textContent = label;
    }
    const actions = root.querySelector<HTMLElement>('[data-testid="approval-decision-actions"]');
    const controls = [...replacements.keys()]
      .map((testId) => root.querySelector<HTMLElement>(`[data-testid="${testId}"]`))
      .filter((control): control is HTMLElement => control !== null);
    return {
      rootFits: root.scrollWidth <= root.clientWidth,
      actionsFit: Boolean(actions && actions.scrollWidth <= actions.clientWidth),
      controlsFit: controls.every((control) => control.scrollWidth <= control.clientWidth),
    };
  });
  expect(translatedControlOverflow).toEqual({
    rootFits: true,
    actionsFit: true,
    controlsFit: true,
  });

  const routeAfter = await workBoardPanel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
  expect(routeAfter.left).toBeCloseTo(routeBefore.left, 0);
  expect(routeAfter.top).toBeCloseTo(routeBefore.top, 0);
  expect(routeAfter.width).toBeCloseTo(routeBefore.width, 0);
  expect(routeAfter.height).toBeCloseTo(routeBefore.height, 0);

  // History navigation must remain interactive while the floating card stays mounted.
  await mainWindow.getByTestId(TEST_IDS.viewPathBack).click();
  await expect(workBoardPanel).toBeHidden();
  const composerDock = mainWindow.locator('[data-composer-placement]').first();
  const composerInput = mainWindow.getByTestId(TEST_IDS.composerInputBar).first();
  await expect(composerDock).toBeVisible();
  await expect(composerInput).toBeVisible();
  await expect(composerDock).toHaveAttribute('inert', '');
  await expect(composerDock).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => dock.evaluate((element) => {
    const root = element as HTMLElement;
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-input-bar"]');
    if (!composer) return false;
    const dockRect = root.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const overlapTop = Math.max(dockRect.top, composerRect.top);
    const overlapBottom = Math.min(dockRect.bottom, composerRect.bottom);
    if (overlapBottom - overlapTop < 24) return false;
    const x = Math.max(dockRect.left, composerRect.left)
      + Math.min(dockRect.width, composerRect.width) / 2;
    const y = overlapTop + (overlapBottom - overlapTop) / 2;
    return document.elementFromPoint(x, y)?.closest('[data-testid="approval-dock"]') === root;
  })).toBe(true);
  await expect(dock).toBeVisible();

  // Approval floats above the composer and takes precedence over simultaneous questions.
  await app.evaluate(({ BrowserWindow }, sid) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.webContents.send('ave:ask-user-question:request', {
      id: 'approval-dock-question-overlap-e2e',
      sessionId: sid,
      createdAt: Date.now(),
      questions: [{
        question: 'Which report range should be used?',
        choices: ['Today', 'This week', 'This month'],
      }],
    });
  }, sessionId);
  const questionOverlay = mainWindow.getByTestId(TEST_IDS.questionOverlay);
  await expect(questionOverlay).toBeVisible();
  await expect(composerDock).toHaveAttribute('inert', '');
  await expect(composerDock).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => dock.evaluate((element) => {
    const root = element as HTMLElement;
    const question = document.querySelector<HTMLElement>('[data-testid="question-overlay"]');
    if (!question) return false;
    const dockRect = root.getBoundingClientRect();
    const questionRect = question.getBoundingClientRect();
    const overlapTop = Math.max(dockRect.top, questionRect.top);
    const overlapBottom = Math.min(dockRect.bottom, questionRect.bottom);
    if (overlapBottom - overlapTop <= 0) return false;
    const x = Math.max(dockRect.left, questionRect.left)
      + Math.min(dockRect.width, questionRect.width) / 2;
    const y = overlapTop + (overlapBottom - overlapTop) / 2;
    return document.elementFromPoint(x, y)?.closest('[data-testid="approval-dock"]') === root;
  })).toBe(true);

  // Resolving approval must focus the pending question rather than the obscured composer.
  await approve.focus();
  await approve.press('Enter');
  await expect(dock).toHaveCount(0);
  const firstQuestionChoice = questionOverlay.getByRole('option').first();
  await expect(firstQuestionChoice).toBeFocused();
  await expect(composerDock).not.toHaveAttribute('inert', '');
  await expect(composerDock).not.toHaveAttribute('aria-hidden', 'true');

  await app.evaluate(({ BrowserWindow }, sid) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.webContents.send('ave:approval:request', {
      id: 'approval-dock-layout-continuation-e2e',
      sessionId: sid,
      category: 'tool',
      kind: 'tool',
      toolName: `read_file_${'long_identity_'.repeat(16)}`,
      toolCategory: 'read',
      source: 'builtin',
      trustOrigin: 'user-keyboard',
      args: { path: 'C:\\workspace\\approval-dock-layout-continuation-e2e.txt' },
      reason: 'deterministic approval dock continuation fixture',
      createdAt: Date.now(),
      requireExplicit: false,
    });
  }, sessionId);
  await expect(dock).toBeVisible();
  await expect(deny).toBeFocused();
  await expect(composerDock).toHaveAttribute('inert', '');
  await expect(composerDock).toHaveAttribute('aria-hidden', 'true');

  // At minimum height, scroll only the card body while header and decisions remain visible.
  await openWorkBoard();
  await expect(workBoardPanel).toBeVisible();
  // Native resize tweens can change bounds; override the renderer viewport for deterministic layout checks.
  const cdp = await mainWindow.context().newCDPSession(mainWindow);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 460,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await expect.poll(() => mainWindow.evaluate(() => (
    Math.abs(window.innerWidth - 460) <= 1
    && Math.abs(window.innerHeight - 640) <= 1
  ))).toBe(true);
  const reviewDetails = dock.getByTestId(TEST_IDS.approvalReviewDetails);
  await reviewDetails.locator('summary').click();
  await expect(reviewDetails).toHaveAttribute('open', '');
  const compactGeometry = await dock.evaluate((element) => {
    const root = element as HTMLElement;
    const header = root.querySelector<HTMLElement>(':scope > header');
    const card = root.querySelector<HTMLElement>('[data-testid="tool-approval-card"]');
    const body = card?.querySelector<HTMLElement>(':scope > section');
    const footer = card?.lastElementChild as HTMLElement | null;
    const rootRect = root.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    return {
      height: rootRect.height,
      maxViewportHeight: window.innerHeight * 0.48,
      headerInside: (headerRect?.top ?? -1) >= rootRect.top - 1
        && (headerRect?.bottom ?? Number.POSITIVE_INFINITY) <= rootRect.bottom + 1,
      footerInside: (footerRect?.top ?? -1) >= rootRect.top - 1
        && (footerRect?.bottom ?? Number.POSITIVE_INFINITY) <= rootRect.bottom + 1,
      bodyClientHeight: body?.clientHeight ?? -1,
      bodyScrollHeight: body?.scrollHeight ?? -1,
      bodyClientWidth: body?.clientWidth ?? -1,
      bodyScrollWidth: body?.scrollWidth ?? -1,
      footerClientWidth: footer?.clientWidth ?? -1,
      footerScrollWidth: footer?.scrollWidth ?? -1,
    };
  });
  expect(compactGeometry.height).toBeLessThanOrEqual(compactGeometry.maxViewportHeight + 1);
  expect(compactGeometry.headerInside).toBe(true);
  expect(compactGeometry.footerInside).toBe(true);
  expect(compactGeometry.bodyClientHeight).toBeGreaterThan(0);
  expect(compactGeometry.bodyScrollHeight).toBeGreaterThan(compactGeometry.bodyClientHeight);
  expect(compactGeometry.bodyScrollWidth).toBeLessThanOrEqual(compactGeometry.bodyClientWidth);
  expect(compactGeometry.footerScrollWidth).toBeLessThanOrEqual(compactGeometry.footerClientWidth);
  const scrollBody = dock.locator('[data-testid="tool-approval-card"] > section').first();
  await scrollBody.evaluate((element) => {
    element.scrollTop = Math.min(48, element.scrollHeight - element.clientHeight);
  });
  await expect.poll(() => scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(approve).toBeVisible();
  await expect(deny).toBeVisible();

  // Keys outside the dock must not decide approval.
  await featuresGroup.focus();
  await featuresGroup.press('d');
  await expect(dock).toBeVisible();

  await approve.focus();
  await approve.press('ArrowLeft');
  await expect(allowAlways).toBeFocused();
  await allowAlways.press('ArrowLeft');
  await expect(deny).toBeFocused();
  await deny.press('ArrowRight');
  await expect(allowAlways).toBeFocused();
  await allowAlways.press('ArrowRight');
  await expect(approve).toBeFocused();
  await approve.press('Enter');
  await expect(dock).toHaveCount(0);

  // Preserve native Space activation alongside directional focus movement.
  await app.evaluate(({ BrowserWindow }, sid) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.webContents.send('ave:approval:request', {
      id: 'approval-dock-space-e2e',
      sessionId: sid,
      category: 'tool',
      kind: 'tool',
      toolName: 'read_file_space_activation',
      toolCategory: 'read',
      source: 'builtin',
      trustOrigin: 'user-keyboard',
      args: { path: 'C:\\workspace\\approval-dock-space-e2e.txt' },
      reason: 'space activation fixture',
      createdAt: Date.now(),
      requireExplicit: false,
    });
  }, sessionId);
  await expect(dock).toBeVisible();
  const secondApprove = dock.getByTestId(TEST_IDS.approveButton);
  const secondDeny = dock.getByTestId(TEST_IDS.denyButton);
  const secondAlways = dock.getByTestId(TEST_IDS.allowSessionButton);
  await expect(secondDeny).toBeFocused();
  await secondDeny.press('ArrowRight');
  await expect(secondAlways).toBeFocused();
  await secondAlways.press('ArrowRight');
  await expect(secondApprove).toBeFocused();
  await secondApprove.press('Space');
  await expect(dock).toHaveCount(0);
});

test('an ask that names no conversation is a lane card that covers no composer', async ({
  app,
  mainWindow,
}) => {
  // Sessionless requests belong to the focused pane lane and must not block any composer.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.setContentSize(460, 841);
  });
  await expect.poll(() => mainWindow.evaluate(() => (
    Math.abs(window.innerWidth - 460) <= 1
    && Math.abs(window.innerHeight - 841) <= 1
  ))).toBe(true);

  const composerDock = mainWindow.locator('[data-composer-placement]').first();
  await expect(composerDock).toBeVisible();

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.webContents.send('ave:approval:request', {
      id: 'approval-lane-unattributed-e2e',
      category: 'tool',
      kind: 'tool',
      toolName: `read_file_${'long_identity_'.repeat(16)}`,
      toolCategory: 'read',
      source: 'builtin',
      trustOrigin: 'user-keyboard',
      args: { path: 'C:\\workspace\\approval-lane-unattributed-e2e.txt' },
      reason: 'unattributed approval lane fixture',
      createdAt: Date.now(),
      requireExplicit: false,
    });
  });

  const lane = mainWindow.getByTestId('approval-lane-card');
  await expect(lane).toBeVisible();
  await expect(lane).toHaveAttribute('role', 'region');
  await expect(mainWindow.getByTestId(TEST_IDS.approvalDock)).toHaveCount(0);
  await expect(composerDock).not.toHaveAttribute('inert', '');
  await expect(composerDock).not.toHaveAttribute('aria-hidden', 'true');

  const geometry = await lane.evaluate((element) => {
    const root = element as HTMLElement;
    const canvas = root.closest<HTMLElement>('[data-testid="route-canvas"]');
    const rect = root.getBoundingClientRect();
    const canvasRect = canvas?.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      canvasLeft: canvasRect?.left ?? null,
      canvasRight: canvasRect?.right ?? null,
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  if (geometry.canvasLeft !== null && geometry.canvasRight !== null) {
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.canvasLeft);
    expect(geometry.right).toBeLessThanOrEqual(geometry.canvasRight + 1);
  }
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

  await lane.getByTestId(TEST_IDS.denyButton).click();
  await expect(lane).toHaveCount(0);
});
