# Side-panel browser repair report

## Current follow-up corrections after 23df511d9

Scope: repair exhaustive builtin action presentation, static parked main-session preview delivery, and model-turn-end live browser cleanup. One local commit per item; no push. Permission requirements and decision-tree ordering remain unchanged. Earlier sections retain their historical validation scope.

### Static parked main-session preview

Root cause: the screencast requested only every third compositor frame. A static, never-revealed page can paint without producing a third frame, leaving the real conversation thumbnail at Updating with zero preview messages. The previous native fixture revealed the guest before parking it and animated the page every 100 ms, so it missed this case.

The screencast now admits the first compositor frame. Existing JPEG size/quality caps, four forwarded frames per second, one unrendered frame in flight, immediate native acknowledgement and one queued newest frame remain unchanged. Upstream JPEG generation/native traffic can increase on animated pages; the forwarding limit does not claim to cap encoding cost. No debugger attachment, capture API, effect authorization or model-facing capability was added.

RED: `TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/main-session-browser-preview.spec.ts --output=/private/tmp/webfix-followup/native-static-red`: 1 failed because no decoded thumbnail appeared after 15 seconds; captured preview messages were empty while the real guest reported visible/1024x768 and no native focus (native-static-red.log). No observation events or frames were injected.

GREEN: `TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/main-session-browser-preview.spec.ts --output=/private/tmp/webfix-followup/native-static-green`: 1 passed (6.5 seconds). The final regression asserts the panel remains closed, actual IPC frames name the real tool tab, the thumbnail image decodes, and a second static page across a different origin updates that image. Model responses are loopback fixtures; tool execution, approval, observation, guest and screencast are real. The screenshots in trace.zip were visually checked. The run emitted a native listener-limit warning; it did not establish sustained listener growth.

`AVE_TEST_TMP_ROOT=/private/tmp/webfix-followup/test-tmp bun run test:vitest -- run src/observation/__tests__/browser-screencast.test.ts src/ui/renderer/preview/__tests__/browser-observation-preview.test.tsx`: 2 files / 27 tests passed (preview-unit.log). `bun run build:main` passed (static-main-build.log). Independent review found no production correctness/privacy blocker; the requested documentation and explicit closed-panel assertions were added.

Files: src/observation/browser-screencast.ts; src/observation/__tests__/browser-screencast.test.ts; test/e2e/ui/main-session-browser-preview.spec.ts; docs/architecture/architecture.md; this report. Local receipts are under /private/tmp/webfix-followup/.

### All registered builtin action summaries

One action descriptor mapping now covers actual core/workflow/meta builtin registration, including optional tool groups. Builtin source returns through that mapping before the external-tool execution fallback; even an unknown builtin receives action framing and a nonempty subject. The real boot-registry test iterates tools, rejects missing descriptors, verifies both locale titles/subjects, and derives operand assertions from actual tool schemas. It does not mirror registration in a test-maintained name list. Canonical file/transfer targets take precedence; patch summaries show affected paths and text-input summaries omit typed values. Site/egress precedence, approval rules/choices and execution are unchanged. Two independent reviewers found no authorization or completeness objection.

RED: `AVE_TEST_TMP_ROOT=/private/tmp/webfix-followup/test-tmp bun run test:vitest -- run src/boot/__tests__/builtin-approval-actions.test.ts`: 6 failed / 0 passed (builtins-red.log).

GREEN: `AVE_TEST_TMP_ROOT=/private/tmp/webfix-followup/test-tmp bun run test:vitest -- run src/boot/__tests__/builtin-approval-actions.test.ts src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx src/ui/renderer/__tests__/ApprovalDock.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-allowed-choices.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-agent-action.test.tsx src/i18n/__tests__`: 11 files / 132 tests passed (builtins-consumers.log). `bun run typecheck` passed. `bun run check:i18n-catalog` passed: 2 locales / 5862 keys. The real-registry regression is registered in the cross-platform CI test list. No new native screenshots of builtin cards were taken.

Files: src/ui/renderer/components/permissions/approval-action.ts; src/ui/renderer/components/permissions/builtin-approval-action.ts; src/i18n/messages/en.ts; src/i18n/messages/ko.ts; src/boot/__tests__/builtin-approval-actions.test.ts; src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx; .github/workflows/ci.yml; docs/architecture/architecture.md; this report.

### Model-turn-end browser presentation and control

Root cause: host model-turn teardown notified the document observer but not the browser observer. A long-lived main conversation therefore retained its browser view, thumbnail and agent-active owned-tab state after the work ended. Child-row completion filtering concealed this missing host boundary in earlier UI coverage.

The shared host observation context now publishes model-turn start/end. The browser runtime tracks exact session/turn ownership independently of renderer subscriptions, retires the previous turn's view and download callbacks, and clears the ending turn's live target. Registry cleanup returns idle owned tabs to human mode while retaining the guest, creator, opener provenance, site grants and future authorized eligibility. Human-paused state is preserved. Held model leases are privately stamped with their admitted turn: an exact ending lease retires publicly at once and aborts its old action scope, while a private settlement fence keeps the original page exclusive until its old handler finally releases. That late release cannot reactivate control or overwrite a replacement/newer lease. Exact held-lease retirement runs for every ended turn; only idle-owner/view cleanup depends on the latest turn. No wire field, permission mode or approval requirement changed.

RED before the initial fix: the main completed/interrupted/error matrix failed 3 tests. Additional independent review regressions failed 14 tests for released/unobserved views, old download replay and newer held leases. Delayed handler settlement failed 1 test; overlapping A-lease / B-start / A-end / B-end / late-A-settlement failed 1 test. Raw commands/counts are in lifecycle-red.log, lifecycle-review-red.log, lifecycle-settlement-red.log and lifecycle-overlap-red.log. The initial native completed-main regression also failed: its live row remained after completion (native-turn-red.log).

Final focused command:
`AVE_TEST_TMP_ROOT=/private/tmp/webfix-followup/test-tmp bun run test:vitest -- run src/main/__tests__/browser-observation.test.ts src/main/__tests__/browser-observation-preview.test.ts src/tools/__tests__/agent-observation-context.test.ts src/tools/__tests__/agent-browser-observation.test.ts src/main/browser/__tests__/browser-tab-registry.test.ts`
5 files / 210 tests passed (lifecycle-final-green.log). This connects actual host turn/invocation contexts, observation runtime/daemon and registry, covering main and child completion/interruption/error, view release and no-view paths, stale downloads, pause, newer/non-model leases, delayed settlement and guest replacement. Existing live-preview fixtures now keep a real host turn open between invocations instead of expecting live state after ending the turn. Both independent reviews ended with no objections.

Final main-session native command:
`TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/main-session-browser-preview.spec.ts --output=/private/tmp/webfix-followup/native-main-final`
1 passed (7.1 seconds). Real tools navigate static pages while the panel stays closed; the actual thumbnail receives and decodes frames. After final model completion the strip/preview disappear, public control becomes human, both control badges disappear, and the same creator-owned guest/tab retains its URL. Opening the panel and selecting that tab displays the real retained page. The final screenshot was visually inspected (turn-ended-retained-tab.png).

Files: src/tools/agent-observation-context.ts; src/tools/__tests__/agent-observation-context.test.ts; src/main/browser-observation.ts; src/main/__tests__/browser-observation.test.ts; src/main/__tests__/browser-observation-preview.test.ts; src/main/browser/browser-tab-registry.ts; src/main/browser/__tests__/browser-tab-registry.test.ts; src/__tests__/support/agent-observation-admission.ts; test/e2e/ui/main-session-browser-preview.spec.ts; docs/architecture/architecture.md; this report.

### Final validation of all three follow-up corrections

All commands ran from the clone. Local receipts are under `/private/tmp/webfix-followup/`; the former receipt path remains an alias. Raw invocations, including their original environment values, are retained in each log and test-command.txt. Tests used the wrapper with AVE_TEST_TMP_ROOT pointing at the receipt test-tmp directory. The final full selection ran with native sandbox execution available. Exact wrapper arguments:

```sh
bun run test:vitest -- run src/__tests__/preload-shape.test.ts src/boot/__tests__/builtin-approval-actions.test.ts src/boot/steps/__tests__/workflow-stores-approval-gate.test.ts src/engine/__tests__/a2a-subagent-message-bus.test.ts src/engine/__tests__/conversation-history-trim.test.ts src/engine/__tests__/conversation-loop-guidance.test.ts src/engine/__tests__/conversation-loop-rounds.test.ts src/engine/__tests__/subagent-approval-provenance.test.ts src/engine/__tests__/subagent-resume.test.ts src/engine/__tests__/subagent-runner.test.ts src/engine/__tests__/suggested-replies.test.ts src/engine/turn/__tests__/directory-instructions.test.ts src/i18n/__tests__ src/ipc/__tests__/channel-inventory.test.ts src/ipc/domains/__tests__/browser.test.ts src/ipc/domains/__tests__/preview-document.test.ts src/ipc/handlers/__tests__/chat-subagent-mailbox.test.ts src/main/__tests__/browser-observation-preview.test.ts src/main/__tests__/browser-observation.test.ts src/main/__tests__/browser-preview-guest.test.ts src/main/__tests__/document-observation.test.ts src/main/__tests__/document-open.test.ts src/main/__tests__/terminal-observation.test.ts src/main/browser/__tests__/browser-actions.test.ts src/main/browser/__tests__/browser-guest-tracking.test.ts src/main/browser/__tests__/browser-popup-navigation.test.ts src/main/browser/__tests__/browser-select-script.test.ts src/main/browser/__tests__/browser-site-navigation.test.ts src/main/browser/__tests__/browser-tab-activity.test.ts src/main/browser/__tests__/browser-tab-registry.test.ts src/main/browser/__tests__/browser-tools-source.test.ts src/main/terminal/__tests__/pty-manager.test.ts src/observation/__tests__/browser-screencast.test.ts src/permissions/__tests__/approval-gate.test.ts src/permissions/__tests__/browser-site-card.test.ts src/permissions/__tests__/browser-site-permissions.test.ts src/permissions/__tests__/rules-store-and-decision.test.ts src/permissions/__tests__/sandbox-process-home.test.ts src/permissions/__tests__/session-scope-end.test.ts src/prompts/__tests__/suggested-replies-contract.test.ts src/shared/__tests__/conversation-title.test.ts src/shared/__tests__/tool-result-trim.test.ts src/tools/__tests__/agent-browser-observation.test.ts src/tools/__tests__/agent-observation-context.test.ts src/tools/__tests__/agent-spawn-background.test.ts src/tools/__tests__/agent-terminal-observation.test.ts src/tools/__tests__/browser-tools.test.ts src/tools/__tests__/executor-approval-memory-skip-integration.test.ts src/tools/__tests__/memory-recall.test.ts src/tools/__tests__/shell-windows-mxc.test.ts src/tools/__tests__/shell-workload-broker.test.ts src/tools/__tests__/verified-shell-execution.test.ts src/tools/__tests__/xlsx-edit-sandbox.integration.test.ts src/ui/renderer/__tests__/ApprovalDock.test.tsx src/ui/renderer/__tests__/ChatView.test.tsx src/ui/renderer/__tests__/TranscriptRenderer.test.tsx src/ui/renderer/components/__tests__/ChatSidePanel.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-agent-action.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-allowed-choices.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-session-scope.test.tsx src/ui/renderer/components/__tests__/WebSurfaceLayer.test.tsx src/ui/renderer/hooks/__tests__/use-chat-state-remote-turn.test.tsx src/ui/renderer/preview/__tests__/agent-browser-bridge.test.ts src/ui/renderer/preview/__tests__/browser-observation-bridge.test.tsx src/ui/renderer/preview/__tests__/host-focus-memory.test.ts test/renderer/chat-columns.test.tsx test/renderer/main-panels.test.tsx
```

Result: **73 files / 2268 passed / 3 existing platform skips** (final-tests.log, 42.87 seconds). No new skip/only or baseline growth. An initial restricted parallel run failed the document-observation status assertion and native sandbox probe; both passed in the native-enabled two-suite retry (23 tests), and the final whole selection passed without source/baseline changes for those failures.

| Command | Result |
|---|---|
| `bun run typecheck` | PASS, zero production diagnostics |
| `bun run check:knip` | PASS, baseline held |
| `bun run check:biome` | PASS, baseline held |
| `bun run check:sot-shapes` | PASS, 6 tests; baseline held |
| `bun run check:i18n-catalog` | PASS, 2 locales / 5862 keys |
| `bun run check:gate-core` | PASS, 11 component checks / 55 script tests |
| `bun run check:typecheck-tests` | PASS, no growth against existing 208-file / 921-error baseline |
| `bun run build:main` | PASS |
| `bun run build:renderer` | PASS |

Native preview/focus/close/navigation selection: `TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/main-session-browser-preview.spec.ts test/e2e/ui/browser-observation-preview.spec.ts --output=/private/tmp/webfix-followup/native-final`: **5 passed** (36.0 seconds). The final main-only rerun above adds the explicit retained-page visibility assertion. Trace archives include decoded preview and retained-tab screenshots.

Not verified: the lead's external model/provider route and public websites were not rerun; loopback model responses and two local origins isolate the real host observation/control path. Native completion is covered; interruption/error and delayed settlement use connected host integration tests rather than separate native UI runs. New native screenshots of every builtin approval card, Windows/Linux runtime, and remote CI were not run. A native run emitted an 11-destroyed-listener warning; these checks do not establish sustained listener growth or diagnose that warning. Passing test-typecheck means no new historical-baseline errors, not zero existing test diagnostics. No push.

## Review corrections after d614d1623

Understood as: repair each of the four independent review findings in its own local commit, prove each with a failing regression, repeat the requested validation, and compare the cross-site native failure with the same scenario on the clone's origin/main. No push.

### Recovery tool registration

The scope-probe and frozen-resume registries now include the same recovery-tool registration as boot. Both regressions failed before the fix. Child registry composition now registers recovery only when the nonempty scope does not already contain that tool, using the factory's name. This preserves the inherited implementation, deny-all scope and frozen resume scope. Cold review found no additional gap in that guard.

`AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/engine/__tests__/subagent-runner.test.ts src/engine/__tests__/subagent-resume.test.ts -t 'whole parent registry|does NOT expose a tool'`: RED, 2 failed / 139 filtered (`finding1-red.log`). The same command without `-t` passed 2 files / 141 tests (`finding1-green.log`). Evidence is local under `/private/tmp/webfix-review/`.

### Parked guest focus and input

Background preparation captures a focus receipt without native guest focus. Parked page keyboard actions use bounded page-local focus emulation; native selection uses a fixed isolated-world function against the exact main-document select, with unchanged option/value and accessibility verification. Disabled fieldsets remain disabled. Neither path changes approval requirements.

Before hiding a previously visible guest, placement waits for main's accepted binding update. Main blocks real keyboard delivery and removes native guest focus before acknowledging. An in-flight unpark invalidates the previous park acknowledgement; rapid show/hide waits for a fresh one. Failed or stale updates leave the frame visible. Showing precedes clearing parking. Accidental native focus returns to visible chrome, and takeover cannot preserve focus in an invisible guest. This supersedes historical native-focus borrowing statements below.

RED: `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/main/browser/__tests__/browser-tab-registry.test.ts src/main/browser/__tests__/browser-actions.test.ts src/main/browser/__tests__/browser-guest-tracking.test.ts -t 'prepares an awake leased background|selects in an awake owned background|blocks real keyboard delivery'`: 5 failed / 268 filtered. `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/ui/renderer/preview/__tests__/host-focus-memory.test.ts -t 'restores the exact prior target'`: 3 failed / 9 filtered. Logs: finding2-red.log, finding2-focus-red.log.

Independent review exposed the pending-unpark race (covered by a delayed-ack placement test) and inherited fieldset disabledness. `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/main/browser/__tests__/browser-select-script.test.ts` initially failed 1 / passed 2; the script now checks effective disabledness. No target substitution bypass was found in the exact world/object/function guards.

GREEN: `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/main/browser/__tests__/browser-tab-registry.test.ts src/main/browser/__tests__/browser-actions.test.ts src/main/browser/__tests__/browser-guest-tracking.test.ts src/main/browser/__tests__/browser-select-script.test.ts src/ui/renderer/preview/__tests__/host-focus-memory.test.ts src/ui/renderer/preview/__tests__/agent-browser-bridge.test.ts src/ui/renderer/components/__tests__/WebSurfaceLayer.test.tsx src/ipc/domains/__tests__/browser.test.ts`: 8 files / 353 tests passed (finding2-green-final.log).

Native Mac evidence: `TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/browser-observation-preview.spec.ts -g 'selects in a parked guest|streams a bounded live preview' --output=/private/tmp/webfix-review/native-fixed`: 2 passed (native-fixed.log). The parked test verifies final select value b, zero native focus events during selection, forced focus returned, zero real key deliveries to the guest, and composer typing. Traces/screenshots and parked-focus.json are under native-fixed. Builds: `bun run build:main`, `bun run build:renderer` passed. The second scenario includes the separate navigation-gate correction documented when committed.

### Builtin action summaries

The remaining protected read, copy, fetch and upload cards now lead with their actual actions in both locales. Reads prefer the captured canonical path; copies show canonical source/destination; fetch shows URL; upload describes the next native file-picker step, destination and page element, without inventing filenames. Only presentation and catalog code changed. Unknown actions keep the fallback. Independent review found no objection or approval-order change.

RED: `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx`: 8 failed / 14 passed (finding4-red.log).

GREEN: `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx src/ui/renderer/__tests__/ApprovalDock.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-allowed-choices.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-agent-action.test.tsx src/i18n/__tests__`: 10 files / 121 tests passed (finding4-consumers.log). `bun run check:i18n-catalog`: 2 locales / 5800 keys passed. Native screenshots of these four cards were not rerun; rendered consumer tests verify their summaries and existing choices.

### Cross-site navigation and interceptor lifetime

The original cross-site scenario passes on origin/main 8a73d6a2fab572fdd5c09808da85df23524f79b4. In a detached same-clone worktree `/private/tmp/webfix/ave-main-check`, `bun run build` passed, then `TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/browser-observation-preview.spec.ts -g 'streams a bounded live preview' --output=/private/tmp/webfix-review/native-main` passed 1 test (main-build.log, main-e2e.log). Thus the historical ERR_FAILED was a branch regression.

Actual native diagnostic showed three handlers handling one interception ID: obsolete policies aborted it, then the current one tried to continue the invalidated ID. The boot loader creates fresh action adapters; factory-local gate ownership left stale handlers and destroyed callbacks attached to the retained page session. Gate and full-disposal ownership now share the session/guest lifetime, synchronously retiring the prior handler and native destruction callback. Stale cleanup cannot remove the replacement. Approval policies and request bytes are unchanged. Temporary diagnostics were removed. Independent review found no objection.

RED: `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/main/browser/__tests__/browser-site-navigation.test.ts -t 'replaces a previous'`: 1 failed / 4 filtered (navigation-red.log). `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/main/browser/__tests__/browser-actions.test.ts -t 'replaces site gate disposal'`: 1 failed / 164 filtered (navigation-disposal-red.log), two destroyed listeners instead of one.

GREEN: `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/main/browser/__tests__/browser-site-navigation.test.ts src/main/browser/__tests__/browser-actions.test.ts`: 2 files / 170 tests passed (navigation-green-final.log). `bun run build:main` passed. `TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/browser-observation-preview.spec.ts --output=/private/tmp/webfix-review/native-all`: 4 passed in 29.5 seconds (native-all.log), covering parked liveness, parked focus/selection, renderer evaluation after guest close, and live preview across a cross-site commit. Retained traces/screenshots are under native-all. These results supersede the historical ERR_FAILED below.

### Popup consent and command lifetime

The native callback now retains popup outcomes for the exact originating lease. The click awaits site admission and child opening before releasing control; failures become `Browser popup could not open: ...` in its tool result. A shared exact-guest/lease lifecycle follows document-controller replacements, while takeover, caller cancellation, command failure and lease loss cancel admission before a late grant. Page input retains its document guard. Intercepted navigation combines executor and adapter lifetimes; terminal adapter paths abort before detaching watches. This preserves ASK → LIVE, grant choices and approval requirements.

RED: `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/tools/__tests__/browser-tools.test.ts -t 'keeps popup consent|cancels popup consent'`: 3 failed / 86 filtered (finding3-red.log), demonstrating prematurely released leases. Additional independent-review regressions: `-t 'keeps popup consent'` failed 1 / passed 1 / filtered 89 when the opener moved documents; `-t 'originating click fails'` failed 1 / filtered 93 because consent survived command failure; `-t 'cancels intercepted'` failed 4 / filtered 94 for this-site/any-site and unchanged/changed documents. All use the same wrapper and test file; receipts: finding3-navigation-red.log, finding3-failure-red.log, finding3-intercept-red.log.

GREEN: `AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/tools/__tests__/browser-tools.test.ts src/main/browser/__tests__/browser-popup-navigation.test.ts src/main/browser/__tests__/browser-actions.test.ts`: 3 files / 265 tests passed (finding3-green.log). These tests connect the actual executor, approval gate, permission manager, grant store, tab registry and popup/interception routers with controlled page-action/guest fixtures. They verify no late exact-site or any-site grant, no stale request continuation, denial as a click error, retained lease during approval and real registry child binding before success. Final independent review found no objections.

### Final validation for the review corrections

Final selected branch/consumer validation passed 57 files / 1774 tests (final-tests.log). The first broad run exposed four stale source-contract assertions for the new sealed selection and local focus preparation. Their allowlist is now restricted to the exact owning modules/methods, the renamed main-document proof is checked, and the new focus suites are registered in the cross-platform job. No baseline was expanded. Exact command:

```sh
AVE_TEST_TMP_ROOT=/private/tmp/webfix-review/test-tmp bun run test:vitest -- run src/__tests__/preload-shape.test.ts src/boot/steps/__tests__/workflow-stores-approval-gate.test.ts src/engine/__tests__/a2a-subagent-message-bus.test.ts src/engine/__tests__/conversation-history-trim.test.ts src/engine/__tests__/conversation-loop-guidance.test.ts src/engine/__tests__/conversation-loop-rounds.test.ts src/engine/__tests__/subagent-approval-provenance.test.ts src/engine/__tests__/subagent-resume.test.ts src/engine/__tests__/subagent-runner.test.ts src/engine/__tests__/suggested-replies.test.ts src/engine/turn/__tests__/directory-instructions.test.ts src/ipc/__tests__/channel-inventory.test.ts src/ipc/domains/__tests__/browser.test.ts src/ipc/handlers/__tests__/chat-subagent-mailbox.test.ts src/main/__tests__/browser-observation-preview.test.ts src/main/__tests__/browser-preview-guest.test.ts src/main/browser/__tests__/browser-actions.test.ts src/main/browser/__tests__/browser-guest-tracking.test.ts src/main/browser/__tests__/browser-popup-navigation.test.ts src/main/browser/__tests__/browser-select-script.test.ts src/main/browser/__tests__/browser-site-navigation.test.ts src/main/browser/__tests__/browser-tab-activity.test.ts src/main/browser/__tests__/browser-tab-registry.test.ts src/main/browser/__tests__/browser-tools-source.test.ts src/permissions/__tests__/approval-gate.test.ts src/permissions/__tests__/browser-site-card.test.ts src/permissions/__tests__/browser-site-permissions.test.ts src/permissions/__tests__/rules-store-and-decision.test.ts src/permissions/__tests__/session-scope-end.test.ts src/prompts/__tests__/suggested-replies-contract.test.ts src/shared/__tests__/conversation-title.test.ts src/shared/__tests__/tool-result-trim.test.ts src/tools/__tests__/agent-browser-observation.test.ts src/tools/__tests__/agent-spawn-background.test.ts src/tools/__tests__/browser-tools.test.ts src/tools/__tests__/executor-approval-memory-skip-integration.test.ts src/ui/renderer/__tests__/ApprovalDock.test.tsx src/ui/renderer/__tests__/ChatView.test.tsx src/ui/renderer/__tests__/TranscriptRenderer.test.tsx src/ui/renderer/components/__tests__/ChatSidePanel.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-agent-action.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-allowed-choices.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-session-scope.test.tsx src/ui/renderer/components/__tests__/WebSurfaceLayer.test.tsx src/ui/renderer/hooks/__tests__/use-chat-state-remote-turn.test.tsx src/ui/renderer/preview/__tests__/agent-browser-bridge.test.ts src/ui/renderer/preview/__tests__/browser-observation-bridge.test.tsx src/ui/renderer/preview/__tests__/host-focus-memory.test.ts test/renderer/chat-columns.test.tsx test/renderer/main-panels.test.tsx src/i18n/__tests__
```

| Command from clone | Final result |
|---|---|
| `bun run typecheck` | PASS, zero diagnostics |
| `bun run check:knip` | PASS, baseline held |
| `bun run check:biome` | PASS, baseline held |
| `bun run check:sot-shapes` | PASS, 6 tests; baseline held |
| `bun run check:i18n-catalog` | PASS, 2 locales / 5800 keys |
| `bun run check:gate-core` | PASS, 11 component checks / 55 script tests |
| `bun run check:typecheck-tests` | PASS against existing 208-file / 921-error baseline, no new errors |
| `bun run build:main` | PASS |
| `bun run build:renderer` | PASS |

Final native command: `TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/browser-observation-preview.spec.ts --output=/private/tmp/webfix-review/native-final`: **4 passed** (36.3 seconds). After guest close, five renderer evaluation samples were 7.49, 11.72, 1.16, 1.79 and 1.10 ms; preview count and post-close frames were both zero. All local receipts are under `/private/tmp/webfix-review/`, including native traces/screenshots and JSON measurements. No new hot loop was observed in this run.

Not verified: a native popup-consent E2E and new screenshots of the four localized builtin cards were not run. Popup lifetime is covered by the connected executor/router regressions; cards by rendered consumers in both locales. This was a local Mac run; Windows/Linux runtime and remote CI were not run. Test-typecheck passing means no baseline growth, not zero historical test diagnostics. No push was performed.

### Changed files by correction

Recovery registration:

- `docs/evidence/web-panel-2026-11-09/report.md`
- `src/engine/__tests__/subagent-resume.test.ts`
- `src/engine/__tests__/subagent-runner.test.ts`
- `src/engine/subagent-runner.ts`

Parked focus:

- `.github/workflows/ci.yml`
- `docs/architecture/architecture.md`
- `docs/architecture/permission-policy-design.md`
- `docs/evidence/web-panel-2026-11-09/report.md`
- `src/ipc/domains/__tests__/browser.test.ts`
- `src/ipc/domains/browser.ts`
- `src/main/browser/__tests__/browser-actions.test.ts`
- `src/main/browser/__tests__/browser-guest-tracking.test.ts`
- `src/main/browser/__tests__/browser-select-script.test.ts`
- `src/main/browser/__tests__/browser-tab-registry.test.ts`
- `src/main/browser/__tests__/browser-tools-source.test.ts`
- `src/main/browser/browser-action-guard.ts`
- `src/main/browser/browser-actions.ts`
- `src/main/browser/browser-guest-tracking.ts`
- `src/main/browser/browser-select-script.ts`
- `src/main/browser/browser-tab-registry.ts`
- `src/shared/browser-surface.ts`
- `src/ui/renderer/components/WebSurfaceLayer.tsx`
- `src/ui/renderer/components/__tests__/WebSurfaceLayer.test.tsx`
- `src/ui/renderer/preview/__tests__/agent-browser-bridge.test.ts`
- `src/ui/renderer/preview/__tests__/host-focus-memory.test.ts`
- `src/ui/renderer/preview/agent-browser-bridge.ts`
- `test/e2e/ui/browser-observation-preview.spec.ts`

Builtin action summaries:

- `docs/evidence/web-panel-2026-11-09/report.md`
- `src/i18n/messages/en.ts`
- `src/i18n/messages/ko.ts`
- `src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx`
- `src/ui/renderer/components/permissions/approval-action.ts`

Cross-site navigation:

- `docs/evidence/web-panel-2026-11-09/report.md`
- `src/main/browser/__tests__/browser-actions.test.ts`
- `src/main/browser/__tests__/browser-site-navigation.test.ts`
- `src/main/browser/browser-actions.ts`
- `src/main/browser/browser-site-navigation.ts`

Popup lifetime:

- `docs/architecture/architecture.md`
- `docs/architecture/permission-policy-design.md`
- `docs/evidence/web-panel-2026-11-09/report.md`
- `src/main/browser/__tests__/browser-popup-navigation.test.ts`
- `src/main/browser/browser-actions.ts`
- `src/main/browser/browser-control-lifecycle.ts`
- `src/main/browser/browser-popup-navigation.ts`
- `src/tools/__tests__/browser-tools.test.ts`
- `src/tools/browser-tools-execute.ts`

## Historical implementation and validation

The following sections retain their original commit, base and validation context. Current corrections and validation are above and in the final validation section; old limitations are not current pass claims.

Branch: fix/web-panel-site-permission. Base: origin/main 44988dfe6.
Four commits, in requested order. No push. Tracked tree clean after commits.
Dependencies were not installed; the existing node_modules junction was retained. No web/ files changed. No baselines extended. Every touched test file is present in the ci.yml Windows list.

## Item 1 — session site permission

Commit: 7946db101.
Root cause: src/permissions/decision-pipeline.ts:117 previously had no distinct agent-browser tool-use lane; src/tools/browser-tools.ts classified each browser action through the ordinary tool/network approval path. Origin-scoped tool memory made the tool itself the approved subject.

Changes and decision points:
- Agent-owned builtin tools use a host-derived canonical-tool signal. Explicit asks, deny rules and mandatory floors retain precedence. User-owned tabs retain the independent surface choice.
- src/permissions/browser-site-permissions.ts holds exact normalized origins or an HTTP(S)-only any-site grant, indexed by exact session, without persistence or parent/child lookup. Session end removes grants.
- src/tools/invocation-execution.ts:735 checks actual navigation URLs, current deny/admission rules, policy epoch, remote authority and exfiltration signals. An exfiltration signal gets a separate non-recordable human approval even under any-site.
- src/permissions/approval-gate.ts authenticates native site choices and exposes a one-use receipt. Missing/forged/invalid choices, dismissal and headless operation deny. The renderer cannot invent a host browserSite field.
- src/main/browser/browser-site-navigation.ts:11 holds original top-level Document requests at the protocol Request stage, including click/submit and redirect hops. It only continues the original request ID; it never reads response bodies or rewrites/replays headers or POST data. Unknown frames and lost authority deny.
- src/main/browser/browser-actions.ts installs the gate before navigation/input; registry provenance remains agent-owned during an admitted agent navigation. Existing native will-navigate/will-redirect scheme restrictions remain in force.
- src/main/browser/browser-popup-navigation.ts blocks native agent popups and opens valid GET destinations through the same site-authorized new-agent-tab path. Invalid schemes and body-bearing popups fail closed.
- Native choice payload, IPC validation, renderer hook, site card and en/ko copy move together. Old per-tool browser remember strings were removed. The decision tree records owner decision 2026-11-08; the owning policy design documents interception and popup restrictions.

Red/green:
Command (after setting the environment below): node <lab>/tmp-codex/webfix/red-green-item1.cjs
The script backs up decision-pipeline.ts, tests with its HEAD baseline restored, then restores the product file in finally and reruns.
Exact test command: node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/permissions/__tests__/browser-site-permissions.test.ts
RED exit 1 (agent-tool permission assertion fails); GREEN exit 0, 3 tests passed. Receipts: item1-red.log, item1-green.log.

## Item 2 — navigate without a shown tab

Commit: 75445bdfd. A narrow interface correction and empty-pane case discovered during final type/flow checks are included in 92e676b4d; existing commits were not amended or rewritten.
Root cause: src/tools/browser-tools-execute.ts:463 immediately resolved a live tab and returned the no-shown-tab error; navigation had no opening path.

Changes and decision points:
- src/tools/browser-tools.ts pins an omitted-tab navigation to an agent opening scope only when no page is shown (including an empty bound browser pane). Explicit missing IDs, closed bound pages and terminal-bound conversations do not become arbitrary replacements.
- src/tools/browser-tools-execute.ts:468 reuses openAgentTab, the same renderer operation, site gate and control/identity checks as browser_tab_new; the result includes tabId, URL and openedBy.
- en/ko navigateDescription now describes this behavior and site consent.
- src/tools/__tests__/browser-tools.test.ts covers initial opening, single site card, returned ID, empty pane and explicit missing-tab refusal. The final typing repair uses the supported defaultBrowserTab interface rather than the registry-only activeBrowserTab method.

Red/green command: node <lab>/tmp-codex/webfix/red-green.cjs 2 src/tools/browser-tools-execute.ts src/tools/__tests__/browser-tools.test.ts
RED exit 1 (new-tab operation never appears with baseline executor); GREEN exit 0, 77 tests passed. The final added empty-pane case also passed in final-touched.log (138 tests across 3 suites).

## Item 3 — placeholder-only ghost suggestions

Commit: df501ada8.
Root cause: src/engine/suggested-replies.ts:31 accepted the first non-empty candidate of at most 80 characters, including the prompt's literal {text} template.

Changes and decision points:
- Parser rejects a candidate consisting solely of a brace token, angle-bracket token, three dots, a single ellipsis or whitespace; it can choose the next real candidate.
- Real sentences containing brace-like text remain eligible. Streaming completion uses the same parser.
- Changed files: src/engine/suggested-replies.ts, src/engine/__tests__/suggested-replies.test.ts and the Windows test list. Prompt wording was left unchanged; en/ko remain synchronized.

Red/green command: node <lab>/tmp-codex/webfix/red-green.cjs 3 src/engine/suggested-replies.ts src/engine/__tests__/suggested-replies.test.ts
RED exit 1 (placeholder candidates leak through); GREEN exit 0, 25 tests passed. Receipts: item3-red.log, item3-green.log.

## Item 4 — action-based approval framing

Commit: 92e676b4d.
Root cause: src/ui/renderer/components/permissions/ApprovalDock.tsx:253 supplied generic tool/action approval titles; ToolApprovalContent's identity strip led with the tool token ahead of the requested effect.

Changes and decision points:
- New permissions/approval-action.ts:5 derives a shared heading and primary content from structured host input. Shell: command heading and exact command first. File write/edit/append: file heading and path first. External tool: host-owned server/plugin and tool, with invocation arguments. Site: existing origin-specific heading. Unknown families keep the old title.
- ApprovalDock and ApprovalLaneCard use the same heading as ToolApprovalContent. Tool identity remains visible as secondary text.
- en/ko use matching named {server}/{tool} tokens. No permission-tree decision, tool-wide shell grant or new blanket-shell remember choice was added. Existing exact/prefix command rule editing and folder grants remain the authoritative save paths.
- Tests cover both languages, each file family, shell ordering, external arguments, plugin identity, fallback and disabled remembering without a host command rule. Existing shell-rule suites also verify prefix edits store a command pattern rather than a whole shell tool.
- Windows list includes every changed test. This commit also contains the final item-2 interface/empty-pane correction described above.

Red/green command: node <lab>/tmp-codex/webfix/red-green.cjs 4 src/ui/renderer/components/ToolApprovalContent.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx
RED exit 1 (action title/primary nodes absent); GREEN exit 0, 12 tests passed. Receipts: item4-red.log, item4-green.log.

## Test environment and execution

All test/gate shells set:
$env:TEMP='<lab>/tmp-codex/webfix/ctmp'; $env:TMP=$env:TEMP; $env:TMPDIR=$env:TEMP; $env:AVE_TEST_TMP_ROOT=$env:TEMP; Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue

Tests use Node with config/vitest.analysis.config.ts and --configLoader runner. The runner loader avoids writing .vite-temp into the shared dependency junction.

Execution deviation: the initial prescribed bun run test:vitest command was tried before inspecting its script. It invoked the Electron executable in NODE mode through scripts/run-vitest-under-electron.mjs, generated ignored branding assets, and failed at the shared .vite-temp path. No GUI app window was launched, but invoking that executable violated the no-Electron constraint. This was disclosed during work. All later tests used the Node-only analysis runner. No dev server, Playwright or E2E was launched. No admin, registry, sandbox recovery, config/secret inspection or dependency reinstall was performed.

The broad src/permissions directory attempt was canceled after the exhaustive suite produced no useful bounded progress; it is CANCELED, not a passing result. Only that invocation's verified process tree was stopped. Subsequent explicit selections below completed.

Native fixture repair: resources/windows-path-kind/x64/ave-path-kind.exe was absent despite the handoff. Four IPC tests failed with ENOENT / untrusted-boundary errors. Ran ./scripts/build-windows-job.ps1 -Helper path-kind using installed tools (no download); ignored helper outputs were not staged. The failed IPC suite then passed. One stale dock-title assertion was updated to the requested external-action heading and passed.

## Final verification

| Check | Result |
| --- | --- |
| bun run typecheck | PASS |
| bun run check:typecheck-tests | PASS; existing 208-file / 921-error baseline held, no additions |
| bun run check:knip | PASS; existing baseline held |
| bun run check:biome | PASS; no baseline update |
| bun run check:test-duplicates -- --fail-on-duplicates | PASS; 0 duplicate helpers; advisory paraphrases retained |
| bun run check:i18n-catalog | PASS; 2 locales, 5716 keys |
| node scripts/check-type-tokens.mjs | PASS; 1784 files |
| git diff --check and commit hook cached diff checks | PASS |
| Focused permissions + browser suites | PASS; 43 suites, 19,115 tests; final-permissions.log |
| ApprovalContent + Composer + suggested replies | PASS; 23 suites, 340 tests; final-ui.log |
| IPC and dock after fixture/title repair | PASS; 2 suites, 213 tests; final-boundaries-repair.log |
| Last touched browser/card/dock tests | PASS; 3 suites, 138 tests; final-touched.log |
| Exfil/browser reviewers and user-owned-surface decisions | PASS; 4 suites, 226 tests; final-reviewer.log |

These selections overlap; their counts must not be added as unique tests.

Exact focused-permissions command:
$permissionTests=@(rg --files src/permissions/__tests__ | Where-Object { $_ -match '(decision-pipeline|permission-manager|approval-gate|child-approval|user-owned-surface|browser-site|user-approval-store).*\.test\.ts$' }); node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner @permissionTests src/tools/__tests__/browser-tools.test.ts src/tools/__tests__/approval-cache-key-identity.test.ts src/main/browser src/main/__tests__/side-browser-webview.test.ts

Exact UI selection:
$tests=@(rg --files src/ui/renderer/components/__tests__ | Where-Object { $_ -match '(ToolApprovalContent|Composer\.test|Composer-keyboard)' }); node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner @tests src/engine/__tests__/suggested-replies.test.ts src/engine/__tests__/suggested-replies-tag-drift.test.ts src/ui/renderer/hooks/__tests__/use-suggested-replies.test.ts src/ui/renderer/hooks/__tests__/use-chat-state-suggested-replies.test.tsx

## Open scope and limits

- Body-bearing new-window POST requests are denied, including with any-site consent. They are not replayed as GET or through a second POST. This preserves fail-closed behavior but does not provide site-approved POST popup completion. A follow-up must implement request-preserving native popup admission and verify body/redirect/irreversible-submit behavior before enabling it.
- Real native browser behavior, timing of redirect interception, long human-answer delays and visual layout are unit/adapter-tested only. No Electron/dev/Playwright/E2E acceptance is claimed. Actual app acceptance remains unverified under the explicit no-launch instruction; the owner must authorize a later isolated native validation run if needed. Success means no request reaches a disallowed origin before consent, every redirect hop is gated, and one permitted command completes after human consent without changing request data.
- The full repository test suite was not run. The exhaustive canceled permissions attempt is not counted as evidence.
- No remote CI was triggered and nothing was pushed.

## Files in 7946db101

- .github/workflows/ci.yml
- docs/architecture/permission-decision-tree.md
- docs/architecture/permission-policy-design.md
- src/i18n/messages/en.ts
- src/i18n/messages/ko.ts
- src/ipc/domains/permissions.ts
- src/main/browser/__tests__/browser-actions.test.ts
- src/main/browser/__tests__/browser-popup-navigation.test.ts
- src/main/browser/__tests__/browser-site-navigation.test.ts
- src/main/browser/__tests__/browser-tab-registry.test.ts
- src/main/browser/__tests__/browser-tools-source.test.ts
- src/main/browser/browser-actions.ts
- src/main/browser/browser-popup-navigation.ts
- src/main/browser/browser-site-navigation.ts
- src/main/browser/browser-tab-registry.ts
- src/main/side-browser-webview.ts
- src/permissions/__tests__/browser-site-card.test.ts
- src/permissions/__tests__/browser-site-permissions.test.ts
- src/permissions/approval-gate.ts
- src/permissions/browser-site-permissions.ts
- src/permissions/decision-pipeline.ts
- src/permissions/permission-manager.ts
- src/shared/permissions-events.ts
- src/tools/__tests__/browser-tools.test.ts
- src/tools/browser-tools-execute.ts
- src/tools/browser-tools.ts
- src/tools/invocation-authorization.ts
- src/tools/invocation-execution.ts
- src/tools/invocation-runner.ts
- src/tools/pipeline/approval-memory-skip.ts
- src/tools/types.ts
- src/ui/renderer/components/ToolApprovalContent.tsx
- src/ui/renderer/components/__tests__/ToolApprovalContent-session-scope.test.tsx
- src/ui/renderer/components/permissions/BrowserSiteApprovalCard.tsx
- src/ui/renderer/hooks/use-approval.ts

## Files in 75445bdfd

- src/i18n/messages/en.ts
- src/i18n/messages/ko.ts
- src/tools/__tests__/browser-tools.test.ts
- src/tools/browser-tools-execute.ts
- src/tools/browser-tools.ts

## Files in df501ada8

- .github/workflows/ci.yml
- src/engine/__tests__/suggested-replies.test.ts
- src/engine/suggested-replies.ts

## Files in 92e676b4d

- .github/workflows/ci.yml
- src/i18n/messages/en.ts
- src/i18n/messages/ko.ts
- src/tools/__tests__/browser-tools.test.ts
- src/tools/browser-tools.ts
- src/ui/renderer/__tests__/ApprovalDock.test.tsx
- src/ui/renderer/components/ToolApprovalContent.tsx
- src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx
- src/ui/renderer/components/permissions/ApprovalDock.tsx
- src/ui/renderer/components/permissions/approval-action.ts
## Follow-up 2026-11-09 — initial gates and item 4 clarification

Same branch and clean starting tree verified (four existing commits retained). No dependency install, Electron, dev, Playwright, E2E or push.
- Fresh `bun run typecheck`: PASS (followup-typecheck.log).
- Fresh `bun run check:typecheck-tests`: PASS; existing 208-file / 921-error baseline held, no baseline change (followup-check-typecheck-tests.log).
- Item 4 clarification commit: fc87ba71a. External tool approval headings now ask to **use** the host-owned server/plugin tool, in both en/ko. Existing per-tool memory and decision rows are unchanged.
- Root cause: src/i18n/messages/en.ts:5442 and ko.ts:5444 still framed external approval as execution. Changed those catalogs and ToolApprovalContent-identity-strip.test.tsx; tests assert literal tool-use wording in both languages for server and plugin cards.
- RED: Node-only analysis Vitest runner, ToolApprovalContent-identity-strip.test.tsx, exit 1 with four wording failures (followup-item4-red.log). GREEN: identical command, exit 0, 14 tests passed (followup-item4-green.log). Locale backups: followup-item4-en.bak / followup-item4-ko.bak. Exact command: `node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx`.
- Initial unified exec process launch failed twice with CreateProcessAsUserW error 5. A Node runtime confirmed read/Git access; approved execution outside the malfunctioning restricted launcher works. No OS security settings were changed.
- Item 4 visual/native acceptance remains owner-run under the no-launch constraint. Items 5–9 are in progress; no completion claimed.

## Item 5 — background guest activity

Commit dd897864b. Root causes: WebSurfaceLayer.tsx:153–193 kept never-shown guests at their initial zero dimensions; browser-actions.ts had no main-owned layout admission before input. ChatView's agent select/new callbacks could also open the panel.
- Added browser-tab-activity.ts: main owns per-guest activity, checks a real non-zero viewport and non-hidden document before acting, temporarily disables background throttling, retains activity for a 1500ms idle grace, and restores it on idle/cancel/destruction. Up to eight simultaneous active/retained guests; idle entries can be evicted to admit another, all-busy admission fails clearly. Hung readiness and zero layout fail within the centralized 3000ms wake budget.
- Added validated wake/sleep operations to the existing main-to-renderer tab-operation contract. Registry permits waking agent-owned embedded guests only. Renderer keeps the same guest at opacity zero with pointer events disabled and inert/aria-hidden; uses its last size or 1024×768 for a never-shown guest. Visible slots take precedence, so showing a tab mid-action uses the same node/src and existing takeover path. Sleep cannot hide a visible slot; a live preview independently retains painting through the existing observer path.
- All page input methods, including upload, go through activity admission; snapshot, screenshot, wait and navigation do too. User-owned and native popup guests retain their previous paths. Click hit-test coordinate mapping is unchanged; a zero viewport is rejected before DOM.getNodeForLocation with `the tab is not laid out; show the tab and retry`.
- Agent new/select callbacks no longer open the panel. User strip/thumbnail click handlers still explicitly open it.
- Files: browser-tab-activity.ts and test; browser-actions.ts and test; browser-action-guard.ts; browser-tab-registry.ts; shared/browser-surface.ts; shared/tool-timeout-policy.ts; renderer/preview/{web-surfaces,agent-browser-bridge}.ts; WebSurfaceLayer.tsx and test; ChatView.tsx; ci.yml Windows list.
- RED: `node <lab>/tmp-codex/webfix/red-green-item5.cjs` backs up guard/layer, restores their pre-change blobs, runs the action/layer suites, and restores files in finally. Exit 1: never-shown guest sizing and zero-layout rejection fail (item5-red.log).
- GREEN exact command: `node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/main/browser/__tests__/browser-tab-activity.test.ts src/main/browser/__tests__/browser-actions.test.ts src/main/browser/__tests__/browser-tab-registry.test.ts src/ui/renderer/components/__tests__/WebSurfaceLayer.test.tsx`. PASS, 4 suites / 287 tests (item5-green.log). `bun run typecheck` PASS (item5-typecheck.log).
- Coverage: bounded readiness, idle sleep, repeated-action reuse, independent concurrent guests, cancellation, same guest identity across reveal, zero-layout refusal and unchanged user-owned behavior. Actual native viewport/visibility, delivered pointer/keyboard input and human takeover while revealing require the owner's live CDP run. No Electron/dev/E2E was launched; no native acceptance claim.

## Item 6 — loaded agent-tab labels

Commit 64c5210de. Root causes: ChatSidePanel.tsx:485 read only immutable bootstrap tab.content.url; WebSurfaceLayer recorded committed URLs but not titles; browser-guest-tracking.ts did not publish registry metadata at commit/title events.
- Labels subscribe to committed guest metadata, prefer the current title, then current URL host; navigation clears a previous page's title. Bootstrap src/content stays untouched, so metadata updates cannot reload the guest. Native did-navigate, main-frame did-navigate-in-page and page-title-updated also refresh the registry broadcast used by consumers.
- Files: ChatSidePanel.tsx and test; WebSurfaceLayer.tsx; preview/web-surfaces.ts; main/browser/browser-guest-tracking.ts and test; browser-tab-registry.ts; ci.yml.
- RED: `node <lab>/tmp-codex/webfix/red-green-item6.cjs`, backup/restore of tracking and panel code, exit 1 with missing committed label and missing native metadata notifications (item6-red.log).
- GREEN: `node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/main/browser/__tests__/browser-guest-tracking.test.ts src/ui/renderer/components/__tests__/ChatSidePanel.test.tsx src/ui/renderer/components/__tests__/WebSurfaceLayer.test.tsx`, PASS, 3 suites / 175 tests (item6-green.log). The test begins with an agent about:blank guest, dispatches native-style URL/title events, verifies labels and the same guest/src.
- Native event delivery remains owner-live confirmation; unit event-to-label propagation passes.

## Item 7 — narrow overlay composer access and chrome

Commit recorded immediately below. Confirmed source of bleed: ChatView.tsx:852 raised the ENTIRE chat-main-column to z-50 whenever an approval existed in overlay mode; that includes transcript content above the z-40 panel. No translucent surface-token cause was found or assumed.
- Removed that whole-column promotion. Overlay bottom now reserves the actual composer/approval geometry, tracked by ResizeObserver; its guest slot therefore ends above both and cannot cover their buttons. Wide dock mode does not apply the reserve. Existing DESIGN.md z-40 panel ladder retained. Overlay chrome stays opaque during width/slide motion by removing its opacity fade; wide mode keeps its existing fade.
- Files: ChatView.tsx, DockedWorkPanel.tsx, test/renderer/chat-columns.test.tsx, ci.yml. Existing tab-store test now explicitly opens the panel as a user, matching item 5.
- RED: `node <lab>/tmp-codex/webfix/red-green-item7.cjs`, backup/restore of ChatView and DockedWorkPanel, exit 1: overlay bottom reserve absent (item7-red.log).
- GREEN: `node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner test/renderer/chat-columns.test.tsx src/ui/renderer/__tests__/ChatView-columns.test.tsx`, PASS, 2 suites / 6 tests (item7-green.log). At synthetic 783px geometry bottom reserve is 119px for composer and 263px for approval; transcript has no z-50; wide mode clears reserve.
- Owner must verify 783×776 native guest clipping, opaque chrome throughout transitions, send/approval hit targets, growth/resizing and unchanged wide layout by CDP. jsdom asserts geometry/style contracts, not browser compositing pixels. No app was launched.

### Follow-up item 7 commit
Commit: ca3cd32ce.

## Follow-up item 8 — background observation
Root cause: ChatView used only the main-pane hidden-tab membership for eligibility, excluding never-shown side-panel tabs. Read-only snapshot/screenshot/wait calls did not emit browser observation activity.
Changes: ChatView resolves local side tabs directly and keeps the preview visible while the panel is closed or showing another tab; preview click selects the same tab and opens the panel. Read operations now publish observation activity, admitted only for their owner without a conflicting lease. Added en/ko live-strip labels and synchronized the Windows test inventory.
Files: ChatView.tsx and its test; shared/agent-observation.ts; tools/agent-browser-observation.ts and test; tools/browser-tools-execute.ts; BrowserObservationLiveStrip.tsx; en.ts/ko.ts; ci.yml.
Validation: node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts src/ui/renderer/__tests__/ChatView.test.tsx src/tools/__tests__/agent-browser-observation.test.ts src/tools/__tests__/browser-tools.test.ts src/ui/renderer/preview/__tests__/browser-observation-preview.test.tsx — 4 suites, 195 tests PASS (item8-green.log). Backup/revert of ChatView and observation admission with new tests: 6 expected failures (item8-red.log), restored afterward. Tests cover never-shown tabs under snapshot/wait/scroll, closed-panel preview and same-guest reveal.
Native live preview pixels remain for owner CDP verification; no app/E2E was launched. Commit recorded below.

### Follow-up item 8 commit
Commit: 4bfe51e58. The exact analysis runner commands throughout this follow-up include `--configLoader runner`.

## Item 9 — delegated browser ownership, concurrent observation and results

Root causes and decisions:
- src/main/browser/browser-tab-registry.ts:629 granted input access through direct ancestry, and :1096 resolved omitted tab IDs from the host conversation rather than the actual child. Ownership now requires the exact session. Per-owner default selection survives background tab switches; an owned embedded-tab select completes in main without requiring the renderer to show a panel. User-owned/native-popup selection retains its existing receipt path.
- shared/browser-surface.ts:32 and registry requestTabOp previously supplied only the parent display conversation. Added validated ownerSessionId to distinguish the actual child from its parent display host; the renderer stores the real child as agentSessionId. Shared control-state validation now rejects cross-owner leases. No transfer API or implicit ancestry handoff was added.
- renderer/preview/workspace-tabs.ts:47 and ChatSidePanel.tsx:998 previously listed only exact-session tabs. Host-issued owner chains now provide ancestor visibility without input authority. Child tabs carry child title and localized lifecycle status; completed tabs remain mounted/viewable. Existing parent cleanup remains in use.
- renderer/preview/browser-observation-bridge.ts:101 and ChatView.tsx:257 previously chose one latest hosted event, losing concurrent children. The parent now retains and displays each hidden working tab's live strip and 128x80 preview, labelled by child, and preview clicks reveal the same guest. Read/scroll-only work participates. Finished/interrupted/error children stop advertising live previews. Live spawns register the subagent container without opening the panel.
- src/main/browser-observation.ts previewRequest previously keyed one screencast per session view. It now keys per view+tab, so multiple tabs of the same child do not stop each other's stream; stop/idle/cleanup affects the addressed tab, and releasing the view stops all its streams. A close event no longer replaces another tab's live-strip event.
- Item 5's per-guest wake already supports independent concurrent guests; no global shown-tab assumption was introduced. Eight awake guests maximum (idle entries can be evicted; all-busy admission returns an actionable retry error). Existing observation limits remain: four live previews and a 30s preview idle window. Hidden preview painting retains the existing observer path; never-shown guests now reuse the last measured content size before the 1024x768 default.

Already working, retained and verified:
- SubAgentRunner uses child sessionIdOverride and independent permission evaluation. makeSubAgentApprovalAdapter attaches host-only child provenance and labels each card; the gate routes separate request IDs and preserves child session attribution. Added a real-gate two-child test: answering one labelled card leaves the other pending.
- agent_spawn background terminalization already forwards successful summaries (including reported URLs/titles) and explicit failure text through deliverToParent. Added concurrent result tests for two successful page summaries and one takeover/failure result. Existing runner interruption/error tests remain unchanged and pass. A browser action's cancellation returns an explicit tool error through the existing executor; the model may decide what to do with that error.
- Existing teardown releases child observation views when the host conversation ends. Existing user-input attribution revokes only the targeted guest's lease. Registry tests verify pausing one child leaves the sibling lease intact.

Validation refinements included in this final item commit (earlier commits were not amended):
- Final source boundary check rejected the item-5 readiness probe's Runtime call in the generic action module. Moved the fixed read-only expression to browser-layout-probe.ts. The source gate permits that exact module/method/expression only, requires a single send and expression, and continues rejecting arbitrary execution in all other browser modules. No page/tool input is incorporated into executable code.
- Repaired a stale external-tool heading assertion in ApprovalDock to the owner's tool-use wording. Removed new lint diagnostics in earlier follow-up tests and made the overlay's approval-anchor dependency explicit; no baseline was changed.
- Updated main-panel regression expectations to explicitly open the panel as a user. No agent callback opens it.
- Final item-7 anchors: ChatView.tsx:366 reserves the area above composer/approval; :881 keeps transcript stacking below panel chrome. Native compositing still needs visual acceptance.

Red/green evidence (Node-only, lane temp variables set; PSModulePath removed):
- `node <lab>/tmp-codex/webfix/red-green-item9.cjs`: backups/restores ChatView, registry and observation bridge; runs `node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/ui/renderer/__tests__/ChatView.test.tsx src/main/browser/__tests__/browser-tab-registry.test.ts -t "two labelled child|concurrent child tabs"`. RED exit 1: two expected failures, missing child owner and one preview instead of two (item9-red.log). All files restored in finally. The first RED attempt had an incompatible old-hook export and was discarded; the recorded final run reverts its matching bridge too.
- `node <lab>/tmp-codex/webfix/red-green-item9-preview.cjs`: backs up/restores browser-observation.ts and runs the preview suite filtered to `concurrent screencasts`. RED exit 1 because starting the second stream stops the first (item9-preview-red.log).
- `node <lab>/tmp-codex/webfix/test-run.cjs item9-selection src/main/browser/__tests__/browser-tab-registry.test.ts src/tools/__tests__/browser-tools.test.ts`: GREEN 2 suites / 179 tests. Includes concurrent child opening, cross-owner refusal, owner defaults, background selection without renderer activation, and sibling lease survival on takeover.
- `node <lab>/tmp-codex/webfix/test-run.cjs item9-delegation src/engine/__tests__/subagent-approval-provenance.test.ts src/tools/__tests__/agent-spawn-background.test.ts`: GREEN 2 suites / 20 tests (final successful receipt item9-delegation.log).
- `node <lab>/tmp-codex/webfix/test-run.cjs item9-multitab src/main/__tests__/browser-observation-preview.test.ts src/main/__tests__/browser-observation.test.ts src/ui/renderer/preview/__tests__/browser-observation-bridge.test.tsx src/ui/renderer/__tests__/ChatView.test.tsx`: GREEN 4 suites / 134 tests. Includes simultaneous child previews with panel closed, same-node reveal, finished-tab labels/retention, per-tab screencasts and independent stop/cleanup.
- All test-run.cjs commands expand to `node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner <the listed test files>`.

Item 9 files (including final validation refinements; commit SHA recorded below):
.github/workflows/ci.yml
docs/architecture/permission-decision-tree.md
src/engine/__tests__/subagent-approval-provenance.test.ts
src/main/__tests__/browser-observation-preview.test.ts
src/main/browser-observation.ts
src/main/browser/__tests__/browser-actions.test.ts
src/main/browser/__tests__/browser-tab-registry.test.ts
src/main/browser/__tests__/browser-tools-source.test.ts
src/main/browser/browser-actions.ts
src/main/browser/browser-tab-registry.ts
src/shared/browser-surface.ts
src/tools/__tests__/agent-spawn-background.test.ts
src/tools/__tests__/browser-tools.test.ts
src/tools/browser-tools-execute.ts
src/tools/browser-tools.ts
src/ui/renderer/ChatView.tsx
src/ui/renderer/__tests__/ApprovalDock.test.tsx
src/ui/renderer/__tests__/ChatView.test.tsx
src/ui/renderer/components/ChatSidePanel.tsx
src/ui/renderer/components/WebSurfaceLayer.tsx
src/ui/renderer/components/__tests__/ChatSidePanel.test.tsx
src/ui/renderer/components/__tests__/WebSurfaceLayer.test.tsx
src/ui/renderer/preview/__tests__/agent-browser-bridge.test.ts
src/ui/renderer/preview/__tests__/browser-observation-bridge.test.tsx
src/ui/renderer/preview/agent-browser-bridge.ts
src/ui/renderer/preview/browser-observation-bridge.ts
src/ui/renderer/preview/workspace-tabs.ts
test/renderer/chat-columns.test.tsx
test/renderer/helpers.ts
test/renderer/main-panels.test.tsx
src/main/browser/browser-layout-probe.ts (new)

### Item 9 correction discovered during final lifecycle review

The first implementation review above was too broad in saying permission evaluation was already independent. Site consent and user-owned-surface choices were already session-local, but session command rules, exact approval memory and the unavailable-sandbox floor grant were keyed to the root conversation. That contradicted this follow-up's explicit requirement that a child's site/command choices are its own. The old shared-root floor wording in the decision tree was also inconsistent with that requirement; the current owner instruction takes precedence.

- Changed permission-manager.ts:979/1007 to store command rules and floor grants under the requesting session; user-approval-store.ts:320/409 keys exact session decisions under that session. Durable project/global rules retain their existing behavior.
- Root resolution still validates approval origin chains and still groups lifecycle cleanup. Ending a child drops only its own rules/approvals/floor grant/site/surface choices; ending the root clears the entire tree. Judge-breaker accounting remains root-scoped.
- Updated session-scope-end.ts, session-scope-end.test.ts, rules-store-and-decision.test.ts, executor-approval-memory-skip-integration.test.ts and the CI Windows list. Added regressions for parent/sibling command-rule, exact-memory and floor-grant isolation, same-agent reuse, child-only cleanup, and whole-tree cleanup.
- RED exact command: `node <lab>/tmp-codex/webfix/red-green-item9-permission.cjs`. This backs up permission-manager.ts, user-approval-store.ts and session-scope-end.ts, temporarily restores their HEAD blobs, runs `node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/permissions/__tests__/session-scope-end.test.ts -t "does not inherit"`, and restores the backups in finally. Three expected failures: inherited command rule, inherited exact approval, inherited floor grant (item9-permission-red.log).
- GREEN initial isolation check: `node <lab>/tmp-codex/webfix/test-run.cjs item9-permission-isolation src/permissions/__tests__/session-scope-end.test.ts src/permissions/__tests__/user-approval-store.test.ts src/permissions/__tests__/session-authority-withheld.test.ts src/permissions/__tests__/permission-manager.test.ts src/permissions/__tests__/child-approval-gate.test.ts src/tools/__tests__/browser-tools.test.ts` passed 6 suites / 239 tests before adding the separate floor/exact regressions.
- Broader final command: `node <lab>/tmp-codex/webfix/test-run.cjs item9-permission-final src/permissions/__tests__/session-scope-end.test.ts src/permissions/__tests__/host-shell-execution-permit.test.ts src/permissions/__tests__/user-approval-store.test.ts src/permissions/__tests__/session-authority-withheld.test.ts src/permissions/__tests__/approval-run-kinds.integration.test.ts src/permissions/__tests__/root-session-resolver.test.ts src/permissions/__tests__/user-approval-working-directory.test.ts src/permissions/__tests__/rules-store-and-decision.test.ts src/tools/__tests__/executor-approval-memory-skip-integration.test.ts src/tools/pipeline/__tests__/approval-memory-skip-host-plan.test.ts`. Nine suites passed; one own-session fixture expectation was accidentally changed while updating the inheritance table. Restored its original allow expectation and reran the failed suite below. An earlier run also identified obsolete shared-root assertions and missing cyclic-chain validation; the assertions were updated and cyclic-chain rejection was preserved.
- GREEN repair/boundary command: `node <lab>/tmp-codex/webfix/test-run.cjs item9-permission-repair src/tools/__tests__/executor-approval-memory-skip-integration.test.ts src/ipc/domains/__tests__/permissions.test.ts src/tools/__tests__/approval-cache-key-identity.test.ts src/permissions/__tests__/decision-pipeline.test.ts src/permissions/__tests__/permission-manager.test.ts src/permissions/__tests__/child-approval-gate.test.ts`: 6 suites / 919 tests, all passed. This includes the real executor/store boundary, IPC persistence binding and cyclic-origin rejection.

### Final follow-up gates

All child processes used lane ctmp for TEMP/TMP/TMPDIR/AVE_TEST_TMP_ROOT and removed PSModulePath. The Node-only runner was used because the repository's standard test wrapper starts the desktop executable. No desktop executable, dev server, browser automation or E2E was launched during this follow-up. No baseline was extended, dependencies reinstalled, web/** edited, or push attempted.

| Gate | Final result | Evidence |
| --- | --- | --- |
| bun run typecheck | PASS | final-typecheck.log |
| bun run check:typecheck-tests | PASS, existing 208-file / 921-error baseline held; one file fully fixed | final-check-typecheck-tests.log |
| bun run check:knip | PASS, existing baseline held | final-check-knip.log |
| bun run check:biome | PASS, existing baseline held; three improvements | final-check-biome.log |
| bun run check:test-duplicates -- --fail-on-duplicates | PASS, zero duplicate helpers; 52 advisory paraphrases | final-check-test-duplicates.log |
| bun run check:i18n-catalog | PASS, 2 locales / 5719 keys | final-check-i18n-catalog.log |
| bun run check:import-cycles | PASS, zero source cycles; 5 script tests | final-check-import-cycles.log |
| node scripts/check-type-tokens.mjs | PASS, 1786 files | final-tokens.log |
| bun run build | PASS, build only | final-build.log |
| git diff --check | PASS | final local command |

The final code gates were rerun after permission isolation and cyclic-origin validation. Subsequent edits only corrected two stale comments; typecheck was rerun for that cleanup. Every changed test since 44988dfe6 is explicitly present in the Windows CI test list. Added-line review found only a runtime URL-scheme literal containing an external name; no explanatory vendor names were added.

### Remaining native acceptance (owner CDP / real-model run)

Implementation and allowed local verification are complete. Native acceptance remains explicitly INCOMPLETE under the no-launch boundary, awaiting the owner's planned live run:

1. With the panel closed, exercise click/type/key/scroll/drag/select/upload on sleeping agent guests; confirm non-zero viewport, non-hidden visibility, no user pointer events, bounded wake and grace sleep. Bring either an awake or sleeping guest forward mid-action; verify same guest, URL and scroll, and takeover cancels only its owner's lease. Confirm user-owned background tabs retain their prior behavior.
2. At 783x776 and during panel motion, confirm fully opaque address/live-strip chrome and accessible full composer/approval controls. Check wide mode remains unchanged.
3. With a real parent model and two children, confirm independent site/command cards labelled by child, simultaneous background work and previews, independent answer routing, completed tabs still viewable, both reported page results delivered to the parent, and explicit failure/takeover results followed by parent continuation. Unit tests exercise the existing result adapter; they do not establish real-model continuation.

Existing resource limits are explicit: eight awake agent guests, four concurrent preview streams and the existing 30-second preview idle window. No claim is made that arbitrary numbers of agents each have an unlimited simultaneous stream.

### Final commit receipt

- Item 4 wording clarification: fc87ba71a
- Item 5 background wake/layout: dd897864b
- Item 6 tab labels: 64c5210de
- Item 7 overlay geometry/stacking: ca3cd32ce
- Item 8 background observation: 4bfe51e58
- Item 9 delegated ownership/concurrency/visibility/permission isolation, plus final validation repairs: 389e6c444

The four original item commits were preserved without amend/rewrite. All six follow-up commits carry the required attribution trailer. No push was performed. Item 9 also modifies these permission files in addition to its earlier file list: src/permissions/permission-manager.ts, src/permissions/user-approval-store.ts, src/permissions/session-scope-end.ts, src/permissions/__tests__/session-scope-end.test.ts, src/permissions/__tests__/rules-store-and-decision.test.ts, src/tools/__tests__/executor-approval-memory-skip-integration.test.ts. Baseline diff checks and the pre-commit hook passed.

Final post-commit check: .github/scripts/naming-gate.sh 44988dfe6 HEAD passed (naming-gate: clean). git status --short is empty; branch remains fix/web-panel-site-permission at 389e6c444. No push. Native acceptance remains awaiting the owner's CDP/real-model run as listed above.

## Follow-up 3 — site consent, ownership, background input and approval presentation

Branch: `fix/web-panel-site-permission`. Start: `389e6c444`. Final: `64a8c679e`.
No push, amend, rebase, Electron/dev/Playwright/E2E launch, registry operation or ACL recovery was performed. No access to web-run/home was needed. No tracked web/**, configuration, secret, dependency or baseline file changed. Existing node_modules junction and native helpers were retained.

### Findings, fixes and commit receipts

1. **L2 — agent tabs reported human.** Root: `src/main/browser/browser-tab-registry.ts:660-665`, releaseControl unconditionally changed an owned tab to human when each tool released its lease. It was not evidence of a user touching the child. Lease release now leaves owned tabs agent-active and preserves human-paused. Regression covers root and child: deferred site answer -> bound blank tab -> awake/reveal -> release -> next lease/action -> genuine guest key pauses. RED 2 fail; GREEN 2 pass (`f3-l2-{red,green}.log`); full registry 103 pass. Commit `fbd0b4aa4`.
   Input-path audit: `browser-guest-tracking.ts:8-20` attributes key/pointer events by the emitting guest ID; `browser-tab-registry.ts:690-730` filters marked injected events and derived taps before takeover. Explicit stop/restore paths intentionally retain human-paused. Bind assigns agent-active for an authenticated new-tab actor; an already taken-over guest stays paused. Wake/sleep (`browser-tab-activity.ts:23-85`), reveal/focus, metadata publication, tabVisibleTo and ownerSessionId resolution do not call userInput. Main-frame navigation invalidates document epochs rather than assigning human. Approval-card answers are permission events, not guest input. The item-5 activity code changes painting/throttling only. These paths were inspected; the demonstrated human assignment was lease release.

2. **L1 + review finding 2 — cold navigation and approval lifetime.** Root: `src/tools/browser-tools-execute.ts:292-306` captured the blank tab's document signal before the first page-adapter preparation; initial debugger attachment invalidates that document. Preparation now precedes document/lease capture. Separately, `src/main/browser/browser-actions.ts:866-884,1413-1436,1477-1486` previously used the ordinary settle budget while a site answer was pending. The site gate (`browser-site-navigation.ts:19-73`) now exposes pending time and denial; action navigation retains its lease/cancellation lifetime across its own document changes, excludes approval wait from settling, and continues the same intercepted request only after approval. Denial, takeover and guest destruction explicitly fail/cancel without continuing that request. RED 5 fail; GREEN 5 pass (`f3-l1-{red,green}.log`); 3 full suites / 240 tests pass (`f3-l1-full.log`). Commit `839288ee4`.

3. **Review finding 1 — explicit destination asks.** Root: `src/tools/invocation-execution.ts:746-753`, a site grant previously bypassed a destination ask unless another signal forced a prompt. The explicit ask now runs a separate non-recordable approval before consulting site consent, preserving abort/remote/policy rechecks. Real executor regressions start with an any-site grant and a domain ask, hold the answer, and exercise allow, deny and policy revocation. RED 3 fail; GREEN 3 pass (`f3-review1-{red,green}.log`). Commit `27d1fb5fa`.

4. **Review finding 3 — background focus/select.** Root: `src/main/browser/browser-tab-registry.ts:881-948`, focus required the embedded tab to be the renderer's shown surface. The main process now focuses the native guest only when it is awake, agent-created, owned by the exact current lease actor, live and in a visible window. The native focus must actually arrive; document/generation/lease/takeover checks still apply. User-owned guests keep the shown-surface guard; the renderer inert guard was not relaxed. Registry and page-adapter regressions cover closed panel and another shown tab, key delivery, focus restoration, and cancellation by real input. RED 4 fail; GREEN 4 pass (`f3-review3-{red,green}.log`); full registry/actions/renderer bridge 282 pass. Commit `3a7829999`.

5. **Review finding 5 — explicit root selection.** Root: `src/main/browser/browser-tab-registry.ts:1106-1128`, root default resolution preferred the visible tab before the owner's selected tab. Explicit owned selection now wins for unbound root sessions too; pane binding remains authoritative. RED 1 fail; GREEN 1 pass (`f3-review5-{red,green}.log`). Commit `9bd42e5a9`.
   Final integration exposed a second issue: new-tab binding also wrote the same selection map. Removed that automatic write; only browser_tabs.select records explicit selection, while no-selection fallback still finds the newest owned tab. Extended regression verifies visible-tab behavior before selection, later explicit selection, and a subsequent new tab not overwriting it. Backup RED 1 fail / GREEN 1 pass (`f3-review5-selection-{red,green}.log`). Final correction commit `fd2f14071` also replaces new non-null assertions with explicit fixture guards and corrects the old domain-ask test's last-card assumption. No baseline was extended or earlier commit rewritten.

6. **L3 — independent child preview publication.** The cold-open failure above prevents successful observation completion; `src/tools/browser-tools-execute.ts:293-317` is the reproduced dependency, rather than a proven separate renderer overwrite. A real executor/observation regression opens two concurrent child tabs, prepares each cold guest, completes both with distinct renderer tab IDs while the panel is closed, and checks both remain agent-active. With the executor from 389e6c444: RED 1 fail; restored executor: GREEN 1 pass (`f3-l3-{red,green}.log`). Commit `61ceea8a9`. Existing independent preview/screencast/renderer suites are included in final verification. This proves publication independently; actual concurrent composer pixels remain live verification.

7. **L4/L5/L6 + review finding 4 — site card (one commit).** Roots: the card used nonexistent `toolApprovalDialog.deny` instead of `decisionDeny`; it duplicated ApprovalDock's heading; canonical policy origins retain explicit default ports; and host child provenance was intentionally removed before renderer delivery. Fixes: `BrowserSiteApprovalCard.tsx:8-33` uses the existing deny key and one dock heading, conversation label and child label; `approval-action.ts:7` formats the display origin with URL.origin. `src/permissions/approval-gate.ts:977-984,1183` derives a masked display-only requestingAgentTitle from authenticated host provenance and discards caller-supplied projections. Host-only identity/provenance stays private. Both en/ko dock renders verify no raw key, no duplicate heading, default-port normalization and separately labelled queued children. Real native gate tests answer each child's site card independently and reject forged display attribution. RED 4 fail; GREEN 4 pass (`f3-site-card-{red,green}.log`); full site-related 3 suites / 68 tests pass. Commit `a65005bb3`.
   An intermediate fixture incorrectly used non-native resolution for a native-only site denial and timed out. The fixture was corrected to resolveFromDesktopRenderer; the final red/green and full-suite receipts above passed.

8. **L7 — action-framed sub-agent approval.** Root: `src/ui/renderer/components/permissions/approval-action.ts:8-12` had no builtin agent_spawn presentation case. Added en/ko action titles using args.title, plus an untitled variant. Risk, memory and one-shot approval behavior are unchanged. Both locale renders verify action heading, retained tool identity and absent remembered-choice selector. RED 2 fail; GREEN 2 pass (`f3-l7-{red,green}.log`). Commit `bd4ace25e`.

All ten new commits carry the required attribution trailer. The ninth and tenth are new final-validation corrections; none of the eight item commits was amended.

### Red/green commands and backups

Runner (from the repository; Node mode is explicitly allowed by this follow-up):
`node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner <test files> -t <selection>`.

The actual backup helper is `<lab>/tmp-codex/webfix/f3-red-green.cjs`: arguments are ID, comma-separated product paths, comma-separated test paths, test-name selection. It copies current product files to `followup3-backups/`, writes the before-item product blobs from git for RED, restores backups in finally, and executes GREEN. Tests are kept throughout; no stash or index reset is used. Each row's f3-ID-red.log / f3-ID-green.log records Vitest exit 1 / exit 0 respectively.

| ID | RED product ref | Product files | Test files | Test-name selection |
| --- | --- | --- | --- | --- |
| l2 | 389e6c444 | src/main/browser/browser-tab-registry.ts | src/main/browser/__tests__/browser-tab-registry.test.ts | retains agent mode after approval, wake and lease release |
| l1 | fbd0b4aa4 | src/tools/browser-tools-execute.ts, src/main/browser/browser-actions.ts, src/main/browser/browser-site-navigation.ts | src/tools/__tests__/browser-tools.test.ts, src/main/browser/__tests__/browser-actions.test.ts | prepares a newly approved child tab; holds the original action lease through delayed site approval |
| review1 | 839288ee4 | src/tools/invocation-execution.ts | src/tools/__tests__/browser-tools.test.ts | enforces destination ask before remembered site consent |
| review3 | 27d1fb5fa | src/main/browser/browser-tab-registry.ts | src/main/browser/__tests__/browser-tab-registry.test.ts, src/main/browser/__tests__/browser-actions.test.ts | focuses only an awake leased owned background guest; selects in an awake owned background guest |
| review5 | 3a7829999 | src/main/browser/browser-tab-registry.ts | src/main/browser/__tests__/browser-tab-registry.test.ts | keeps explicit root owner selection authoritative |
| l3 | 389e6c444 | src/tools/browser-tools-execute.ts | src/tools/__tests__/browser-tools.test.ts | publishes each concurrent child's opened page |
| site-card | 61ceea8a9 | src/permissions/approval-gate.ts, src/ui/renderer/components/ToolApprovalContent.tsx, src/ui/renderer/components/permissions/BrowserSiteApprovalCard.tsx, src/ui/renderer/components/permissions/approval-action.ts, src/i18n/messages/en.ts, src/i18n/messages/ko.ts | src/engine/__tests__/subagent-approval-provenance.test.ts, src/ui/renderer/__tests__/ApprovalDock.test.tsx | attributed site cards; labels concurrent child cards; caller-supplied display attribution |
| l7 | a65005bb3 | src/ui/renderer/components/permissions/approval-action.ts, src/i18n/messages/en.ts, src/i18n/messages/ko.ts | src/ui/renderer/__tests__/ApprovalDock.test.tsx | frames a builtin sub-agent approval |
| review5-selection | bd4ace25e | src/main/browser/browser-tab-registry.ts | src/main/browser/__tests__/browser-tab-registry.test.ts | keeps explicit root owner selection |

Selections containing two or more names are regex alternatives for the named cases; the raw receipts retain actual collected/selected counts. Example exact final-correction command:
`node <lab>/tmp-codex/webfix/f3-red-green.cjs review5-selection src/main/browser/browser-tab-registry.ts src/main/browser/__tests__/browser-tab-registry.test.ts "keeps explicit root owner selection"`.

### Final verification

All child processes use TEMP=TMP=TMPDIR=AVE_TEST_TMP_ROOT=`<lab>/tmp-codex/webfix/ctmp` and omit PSModulePath. The ordinary test wrapper launches a prohibited runtime, so the explicitly permitted Node-mode analysis runner was used. There was no app launch.

Changed test files (all already in the Windows CI list; no workflow change necessary):
- src/tools/__tests__/browser-tools.test.ts
- src/main/browser/__tests__/browser-actions.test.ts
- src/main/browser/__tests__/browser-tab-registry.test.ts
- src/engine/__tests__/subagent-approval-provenance.test.ts
- src/ui/renderer/__tests__/ApprovalDock.test.tsx
- src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx
- src/ui/renderer/components/__tests__/ToolApprovalContent-session-scope.test.tsx

The full ci.yml Windows permission-regression list (220 files), the prior report suites (60 matched prior-scope files plus 47 explicitly named files), and locale consumer tests were deduplicated to 281 files. Full path inventory and exact selection are in `f3-test-selection.json`. Exact orchestration command:
`node <lab>/tmp-codex/webfix/f3-validate.cjs tests`.
It invokes Node Vitest with every path in that JSON's all array. No test-file filtering based on failure or platform was added.

Initial complete execution: **FAIL**, 17 failed / 263 passed / 1 skipped files (281), 23 failed / 35,520 passed / 412 skipped tests (35,955); duration 1203.66s. Receipt: `f3-windows-and-prior.log`. This aggregate ran while final local repairs were being integrated; the fresh corrected-file receipts supersede its invalidated browser/UI results. The original FAIL receipt is retained.

After that run:
- Existing isolated ToolApprovalContent expectations still assumed agent_spawn used the generic title and the standalone site body owned a heading. Kept the fallback regression using read_file and asserted the site's normalized dialog name/no duplicate body heading. Commit `64a8c679e`; `node <lab>/tmp-codex/webfix/test-run.cjs f3-ui-repair src/ui/renderer/components/__tests__/ToolApprovalContent-identity-strip.test.tsx src/ui/renderer/components/__tests__/ToolApprovalContent-session-scope.test.tsx`: PASS 2 files / 17 tests.
- The handoff's native prerequisites were not all present: job launcher, site launcher and uv were missing. Ran `node scripts/prepare-windows-job.mjs` (PASS, `f3-prepare-windows-job.log`), copied the installed SDK launcher's bytes only after SHA-256 matched repository pin `090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a`, and ran `node scripts/fetch-uv.mjs --current` (PASS, `f3-prepare-uv.log`). All generated assets are ignored and unstaged; the shared dependency junction was preserved.
- Exact repaired-native command: `node <lab>/tmp-codex/webfix/test-run.cjs f3-native-prerequisite-repair src/permissions/__tests__/mxc-windows-missing-denies.test.ts src/permissions/__tests__/mxc-windows-transport.test.ts src/permissions/__tests__/sandbox-control-writes-mxc.integration.test.ts src/sandbox/__tests__/runtime-grant-native.test.ts src/tools/__tests__/background-shell-windows-job.test.ts src/tools/__tests__/bash-dialect.test.ts src/tools/__tests__/mxc-link-traversal.integration.test.ts src/tools/__tests__/mxc-pipe-lifetime.integration.test.ts`: 7 files passed / 1 failed, 44 tests passed / 3 failed / 1 skipped. Only background-shell-windows-job remained failed, initially requiring AVE_TEST_NODE_EXEC_PATH.
- Retried that failed file only with AVE_TEST_NODE_EXEC_PATH set to the actual native Node executable: `f3-background-job-repair.log`, 3 failures. The sensitive-path guard rejects executing the runner's own protected interpreter. No interpreter copy, guard relaxation or prohibited runtime launch was used to bypass this.
- Isolated benchmark command: `node <lab>/tmp-codex/webfix/test-run.cjs f3-home-benchmark-isolated src/shared/__tests__/ave-home-configuration-read.windows.test.ts -t "reports cold and warm medians over twenty fixture reads"`: PASS 1 selected test; duration 84.41s; cold median 174.76ms, warm median 4.49ms. The original aggregate's timeout is retained; concurrency/resource contention is a hypothesis, not a proven cause.
- Exact remaining-boundary diagnosis command: `node <lab>/tmp-codex/webfix/test-run.cjs f3-unrelated-failure-diagnosis src/permissions/__tests__/asrt-sandbox.test.ts src/permissions/__tests__/mxc-policy-pipe.test.ts src/permissions/__tests__/mxc-sdk-packaging.test.ts`: 3 failed / 276 passed / 12 skipped tests in 3 files, confirming the same failures below. Git diff from 389e6c444 confirms these test/source boundaries were not modified by this task.

**Remaining regression status: incomplete, not all-green.** Five files retain seven failed test cases plus the preview suite's teardown error. In the combined retained receipts, 275 files have passing evidence, one remains skipped, and these five remain failed/unavailable:

| Failed file / location | Confirmed evidence | Repair plan and success criterion |
| --- | --- | --- |
| src/tools/__tests__/preview-document-process.test.ts:53 | Node cannot resolve built-in original-fs; packaged-archive parsing also fails its child contract | Run this archive-specific test in a later owner-permitted standard runtime environment. Success: archive child/chunks parse and cleanup succeeds. The current no-Electron instruction blocks that route; no substitute original-fs shim was installed. |
| src/tools/__tests__/background-shell-windows-job.test.ts:95 | With a real Node path supplied, host-script-resources rejects that path because it is the current protected runner interpreter | Use the owning standard test runtime in a later permitted run, with a distinct native Node child, preserving the sensitive-path guard. Success: kill/dispose/root-exit all reap the actual descendants. |
| src/permissions/__tests__/asrt-sandbox.test.ts:1580 | The asserted deny-write list omits the current Node interpreter path; reproduced independently | Compare this runtime-sensitive floor assertion under the standard permitted runner before changing the security policy. Success: the test and the actual floor agree without weakening runtime protection. Node-mode interaction is an inference, not confirmed root cause. |
| src/permissions/__tests__/mxc-sdk-packaging.test.ts:278 | The graph contains ../ave-font/node_modules/... because existing node_modules is a junction; the pin-key assertion rejects that relative prefix | Validate in an owner-supplied independent dependency layout, or separately authorize an owning-path normalization fix. Preserve the shared installation. Success: actual import graph maps to the pinned SDK keys. |
| src/permissions/__tests__/mxc-policy-pipe.test.ts:195 | Synthetic ChildProcess error emission escapes with spawn ENOENT; reproduced independently | In a separately scoped transport repair, trace bindChild's error-listener lifecycle and its fixture together. Success: a spawn failure is observed, release resolves, helper is killed once, and stdin is destroyed. No browser change addresses this independent path. |

No repeated whole-suite retry was performed. Only failed/invalidated selections were rerun. Requested aggregate acceptance remains explicitly incomplete pending a permitted standard-runtime verification and an owner decision on the independent transport/dependency-layout work.

Final changed-file command:
`node <lab>/tmp-codex/webfix/test-run.cjs f3-final-touched src/engine/__tests__/subagent-approval-provenance.test.ts src/main/browser/__tests__/browser-actions.test.ts src/main/browser/__tests__/browser-tab-registry.test.ts src/tools/__tests__/browser-tools.test.ts src/ui/renderer/__tests__/ApprovalDock.test.tsx`
PASS 5 files / 414 tests, `f3-final-touched.log`. The first attempt identified two obsolete last-card assertions and the automatic-selection regression described above; final rerun passed all cases.

Gate command: `node <lab>/tmp-codex/webfix/f3-validate.cjs gates`. Each row is executed as the literal command shown, with output in its corresponding f3-* log; no baseline update command was used.

| Command | Result | Receipt |
| --- | --- | --- |
| bun run typecheck | PASS | f3-typecheck.log |
| bun run check:typecheck-tests | PASS; existing 208 files / 921 errors, one file fully fixed | f3-check-typecheck-tests.log |
| bun run check:knip | PASS; existing baseline held | f3-check-knip.log |
| bun run check:biome | PASS; existing baseline held | f3-check-biome.log |
| bun run check:test-duplicates -- --fail-on-duplicates | PASS; 0 duplicates, 52 advisory paraphrases | f3-check-test-duplicates.log |
| bun run check:i18n-catalog | PASS; 2 locales / 5722 keys | f3-check-i18n-catalog.log |
| bun run check:import-cycles | PASS; 0 cycles, 5 checker tests | f3-check-import-cycles.log |
| bun run build | PASS; full build, no app launch | f3-build.log |
| git diff --check | PASS | f3-diff-check.log |
| .github/scripts/naming-gate.sh 389e6c444 HEAD | PASS | f3-naming-gate.log |

Initial final lint rejected new non-null assertions/template concatenations. Explicit fixture guards and template strings fixed these; the final complete gates were rerun on the corrected tree. All builds are compile/assets only.

### Still needs live verification

No native acceptance is claimed. The owner’s isolated live run remains necessary to verify:
- L1/L2: first child and root open after answering site consent completes under the original action; later commands work and tabs remain agent-owned; actual guest input alone triggers takeover.
- Long delayed consent, deny, takeover and destruction leave no continued request or retained lease.
- Background select/key/focus behavior with the panel closed or another tab shown, including restored user focus.
- L3: each concurrent child shows its own updating composer preview and final page image/title.
- Site-card en/ko layout, child labels, single heading, normalized origin and deny text in the actual window.
- L7 action framing in the actual spawn flow; L8 model wording after L2 is corrected.

Live success criteria are the observed behavior above on the final commit. Status: requested code fixes, all seven changed-test files (431 tests), and common gates are complete. Full regression acceptance remains incomplete for the five files above. Awaiting the owner's permitted standard-runtime/live run and scope decision for independent transport/dependency-layout repair; no further launch or security-policy change was authorized by this task.

## Follow-up 4

Base: `64a8c679e243cfdf47cfe965c152d1d04a524361`. Final HEAD: `566e5908a`; final product code: `020a0b244`. Branch remains `fix/web-panel-site-permission`; four new commits: one per reviewed P2 finding, one for the separately reproduced replaced-guest cleanup defect, and one test-only correction for the navigation callback consumer; each has the required trailer. No amend, rebase, push, dependency installation, baseline extension, `web/**` edit, registry change, administrative action or application launch. The existing dependency junction was preserved.

### P2: cancel the native site card and its grant writer with browser control

Commit: `bc59979828e0c19df3ceba20becc94ec0685ad00`.

Root cause at the reviewed base: `src/main/browser/browser-site-navigation.ts:46-52` raced only the interception wait; `src/tools/browser-tools-execute.ts:200-208` did not pass that lifecycle to `src/tools/invocation-execution.ts:747-776`. Native cards and the grant commit therefore retained only the invocation signal, so a late answer could write a grant before the executor noticed lost control.

Change: propagate the navigation lifecycle through `BrowserNavigationPolicy.authorize`, `BrowserActionTab.authorizeSite`, and `ToolExecutionContext.authorizeBrowserSite`. The invocation combines that exact signal with caller cancellation, uses it for both explicit destination asks and native site consent, and checks it immediately before the synchronous site-grant write. Existing-tab pre-navigation consent also receives the tab action signal. The lifecycle which survives the action's own approved document transition remains owned by the existing navigation adapter; it was not replaced by document invalidation.

The new real executor/native gate regression covers this-site, any-site and explicit destination-ask cards. For each, it takes over, destroys the guest or releases the original lease while the card is pending (nine scenarios). It checks pending count becomes zero, the exact request snapshot disappears, renderer settlement retracts the card, a delayed signed answer cannot revive it, the original request fails rather than continuing, and both destination and unrelated-site grants remain absent.

Exact backup red/green command:
`node <lab>/tmp-codex/webfix/f4-red-green.cjs p1 src/tools/types.ts,src/tools/browser-tools.ts,src/main/browser/browser-site-navigation.ts,src/tools/browser-tools-execute.ts,src/tools/invocation-execution.ts src/tools/__tests__/browser-tools.test.ts "retracts cancelled native"`

RED: exit 1, three parameterized cases fail because pending count stays 1. GREEN: exit 0, three cases pass. Receipts: `f4-p1-red.log`, `f4-p1-green.log`. The helper copies product files into `followup4-backups/`, temporarily writes their pre-fix HEAD blobs, and restores the copies in `finally`; tests remain present and no stash/index reset is used.

Full targeted command: `node <lab>/tmp-codex/webfix/test-run.cjs f4-p1-full src/tools/__tests__/browser-tools.test.ts src/main/browser/__tests__/browser-actions.test.ts`. PASS, two files / 245 tests. This includes the existing delayed-allow case under its original lease, including its approved document change.

### P2: restore the exact surface that lent native background focus

Commit: `87d76ccf1`.

Root cause at the reviewed base: `src/main/browser/browser-tab-registry.ts:920-921` focused a background guest without first capturing a user surface; `src/ui/renderer/preview/agent-browser-bridge.ts:68-84` deliberately omitted webviews from global focus history. Cleanup could therefore select the remembered composer instead of the user's visible page.

Change: before native background focus, main issues an action receipt tied to the exact guest's lease and renderer slot, then waits for the owning host renderer to capture its exact active element. Scoped restore consumes that receipt and waits for completion. Native focus and the existing awake/exact-owner/current-document/control/visible-window checks remain authoritative; no panel is opened or selected. A previous webview also records its native guest identity; disconnected, hidden, inert, replaced or mismatched targets are refused. Focus changes during the action and native user takeover preserve the user's target. Cancellation can restore under the original receipt even after its lease is released; a different lease cannot consume it. Completed scoped cleanup cannot fall back to global history. Window release/reset settle pending acknowledgements and clear receipts.

The shared operation schema, strict parser, preload method, guarded host-window IPC handler, main pending map, renderer caller, channel inventory and preload shape lock were updated together. Acknowledgements from another window, unknown/replayed request IDs and mismatched borrowing leases are refused. The two inline contract inventories were updated in their sorted position; no error baseline was extended.

Exact backup red/green command:
`node <lab>/tmp-codex/webfix/f4-red-green.cjs p2-final src/main/browser/browser-tab-registry.ts,src/ui/renderer/preview/agent-browser-bridge.ts src/ui/renderer/preview/__tests__/host-focus-memory.test.ts "restores the exact prior target"`

RED: exit 1, three cases fail with the borrowing page still active instead of the exact composer/user page/other child's page. GREEN: exit 0, all three pass. Each passing case also exercises success, cancellation after lease release, a genuine focus change, native takeover, and denied native focus. These assertions inspect the actual active DOM element through the real registry/receipt/memory path, not just an emitted restore operation. Receipts: `f4-p2-final-red.log`, `f4-p2-final-green.log`.

Additional full boundary command:
`node <lab>/tmp-codex/webfix/test-run.cjs f4-p2-final-touched src/main/browser/__tests__/browser-tab-registry.test.ts src/main/browser/__tests__/browser-actions.test.ts src/ui/renderer/preview/__tests__/host-focus-memory.test.ts src/ui/renderer/preview/__tests__/agent-browser-bridge.test.ts src/ipc/domains/__tests__/browser.test.ts src/__tests__/preload-shape.test.ts src/ipc/__tests__/channel-inventory.test.ts`
PASS, seven files / 321 tests. The subsequently added real renderer-router capture/restore/replay test passes with the entire bridge suite: `node <lab>/tmp-codex/webfix/test-run.cjs f4-bridge-final src/ui/renderer/preview/__tests__/agent-browser-bridge.test.ts`, 19 tests. Existing adapter selection tests still verify native key delivery without revealing a panel; the new registry-to-DOM tests verify the exact restored target.

Retained intermediate failures: `f4-p2-red.log` / `f4-p2-green.log` initially exposed an invalid test bootstrap (the new guest began at the destination instead of about:blank). The fixture was corrected; only `p2-final` is the valid red/green evidence. `f4-focus-boundaries.log` initially failed two sorted contract snapshots; those were corrected manually and `f4-focus-contract-final.log` passed all three affected suites / 125 tests. None of these FAIL receipts was replaced by an all-green claim.

### Additional self-review finding: a replaced borrower can strand its receipt

Commit: `020a0b244`. Root: `src/ui/renderer/preview/agent-browser-bridge.ts:88`, the mismatched-borrower guard refused a replacement element but retained the disconnected original receipt. The next action's `capture` then refused because the old receipt still occupied the window. This was discovered after the two P2 commits and fixed in a new commit rather than amending either of them. A mismatched live borrower still cannot consume another action's receipt; a retired/disconnected borrower is now discarded without focusing its replacement.

Exact backup command: `node <lab>/tmp-codex/webfix/f4-red-green.cjs retired-focus src/ui/renderer/preview/agent-browser-bridge.ts src/ui/renderer/preview/__tests__/host-focus-memory.test.ts "retires a disconnected borrowing"`. RED exit 1 (the new capture stays false); GREEN exit 0 (one selected test passes). Receipts: `f4-retired-focus-red.log`, `f4-retired-focus-green.log`. Full affected suites: `node <lab>/tmp-codex/webfix/test-run.cjs f4-retired-focus-full src/ui/renderer/preview/__tests__/host-focus-memory.test.ts src/ui/renderer/preview/__tests__/agent-browser-bridge.test.ts`: PASS, two files / 31 tests.

The aggregate 285-file run was already executing while this two-file correction was integrated. Any affected renderer result from that aggregate is superseded by the final two-suite receipt above; the aggregate itself is retained. The complete gate orchestration and full build were rerun on `020a0b244` and passed, using the final f4 gate receipts below.
### P3 and native acceptance

P3 remains open: null review provenance still omits the child label on the dedicated site card. A separate host-only display metadata path was considered; automatic approval review rejected that optional change as outside the user-authorized small-change condition because it introduced a new cross-module metadata channel. No P3 product edit was made. The user explicitly allowed reporting this item instead of expanding scope; no additional identity/provenance channel or review eligibility was fabricated. A future owner decision must authorize that separate display metadata boundary before implementing its adapter-to-card regression.

No Electron, dev server, Playwright, E2E or UI application was launched. Native compositor/input acceptance, two simultaneous live previews and actual final child-to-parent delivery remain unverified as in Follow-up 3. Success for a later owner-permitted native run remains exact focus restoration after background selection, original-lease delayed consent, cancellation with no retained card/grant, independent live previews and observed final parent receipt.

### Validation

All test/build validation child processes use TEMP=TMP=TMPDIR=AVE_TEST_TMP_ROOT=`<lab>/tmp-codex/webfix/ctmp` and omit PSModulePath. Vitest uses the explicitly permitted Node-mode command:
`node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner <paths> [ -t <selection> ]`.

`node <lab>/tmp-codex/webfix/f4-validate.cjs tests` unions the current ci.yml Windows permission-regression list (220 files), the entire saved Follow-up 3 selection, prior-report named suites, locale consumers, and this follow-up's touched suites: 285 unique files. The exact inventory is `f4-test-selection.json`; no failing/platform-specific suite was filtered away. Full run status: FAIL, seven failed / 277 passed / one skipped files (285); 10 failed / 35,575 passed / 412 skipped tests (35,997), duration 1167.48s. Receipt: `f4-windows-and-prior.log`. Final disposition is below.

Gate orchestration: `node <lab>/tmp-codex/webfix/f4-validate.cjs gates`.

| Command | Result | Receipt |
| --- | --- | --- |
| bun run typecheck | PASS | f4-typecheck.log |
| bun run check:typecheck-tests | PASS; existing 208-file / 921-error baseline held | f4-final-check-typecheck-tests.log |
| bun run check:gate-core | PASS | f4-final-check-gate-core.log |
| bun run check:knip | PASS inside gate-core; baseline held | f4-final-check-gate-core.log |
| bun run check:biome | PASS inside gate-core; baseline held | f4-final-check-gate-core.log |
| bun run check:test-duplicates -- --fail-on-duplicates | PASS inside gate-core | f4-final-check-gate-core.log |
| bun run check:i18n-catalog | PASS; two locales / 5722 keys | f4-check-i18n-catalog.log |
| bun run check:import-cycles | PASS; five checker tests / zero cycles | f4-check-import-cycles.log |
| bun run build | PASS; full compile/assets/build integrity, no app launch | f4-build.log |
| git diff --check | PASS | f4-diff-check.log |
| .github/scripts/naming-gate.sh 64a8c679e HEAD | PASS | f4-naming-gate.log |

The added-line external-name sweep found no new explanatory vendor names. Required commit trailers were verified. Tracked worktree/index are clean. The inherited validator initially wrote the gate manifest to the old f3 filename; its current results were preserved as `f4-gates.json`, the script's path was corrected, and the old manifest's original nine PASS entries were reconstructed from the existing Follow-up 3 report. Original f3 per-command logs were unchanged.
### Aggregate follow-up and final status

The full run found two outdated callback assertions in `src/main/browser/__tests__/browser-site-navigation.test.ts:20,35`: they still expected only a URL, while the fixed gate now supplies its lifecycle signal. New test-only commit `566e5908a` supplies a real signal in those fixtures and checks that the very same signal reaches click/submit and every redirect authorization. Product source is unchanged from the fully built `020a0b244`.

Exact backup command (with `F4_RED_REF=64a8c679e`):
`node <lab>/tmp-codex/webfix/f4-red-green.cjs navigation-contract src/main/browser/browser-site-navigation.ts src/main/browser/__tests__/browser-site-navigation.test.ts "holds click and submit|checks every redirect"`.
RED exit 1 / two failed; GREEN exit 0 / two passed (`f4-navigation-contract-{red,green}.log`). Full affected suites: `node <lab>/tmp-codex/webfix/test-run.cjs f4-navigation-contract-full src/main/browser/__tests__/browser-site-navigation.test.ts src/tools/__tests__/browser-tools.test.ts`: PASS, two files / 90 tests. No production behavior was relaxed to preserve a one-argument mock expectation.

The aggregate's one benchmark timeout was retried alone, with no simultaneous build/large test run:
`node <lab>/tmp-codex/webfix/test-run.cjs f4-home-benchmark-isolated src/shared/__tests__/ave-home-configuration-read.windows.test.ts -t "reports cold and warm medians over twenty fixture reads"`.
PASS, one selected test; 68.67s. Cold median 199.77ms, warm median 4.40ms. Receipt: `f4-home-benchmark-isolated.log`. The 120-second aggregate timeout is retained. Resource contention is a hypothesis, not a proven cause.

Final exact touched command:
`node <lab>/tmp-codex/webfix/test-run.cjs f4-final-touched src/main/browser/__tests__/browser-site-navigation.test.ts src/tools/__tests__/browser-tools.test.ts src/main/browser/__tests__/browser-actions.test.ts src/main/browser/__tests__/browser-tab-registry.test.ts src/ui/renderer/preview/__tests__/host-focus-memory.test.ts src/ui/renderer/preview/__tests__/agent-browser-bridge.test.ts src/ipc/domains/__tests__/browser.test.ts src/__tests__/preload-shape.test.ts src/ipc/__tests__/channel-inventory.test.ts`.
PASS: nine files / 413 tests on `566e5908a`, `f4-final-touched.log`. Final `bun run check:typecheck-tests` and `bun run check:gate-core` also pass (`f4-final-check-typecheck-tests.log`, `f4-final-check-gate-core.log`). The previous full build/typecheck/import-cycle/i18n results validate the identical product source at `020a0b244`; the last commit changes only the navigation test. Naming passed for the final product range; the last test-only added lines were manually checked. Final `git diff --check 64a8c679e HEAD` passes and tracked worktree/index remain clean.

**Full regression acceptance remains INCOMPLETE.** Combining the retained aggregate with the repaired navigation suite and isolated benchmark gives passing evidence for 279 files, one skipped file, and the same five outstanding files as Follow-up 3 (seven failed test cases plus the preview teardown error). This is a composite evidence statement, not a fresh all-green 285-file run. Only failed or invalidated selections were rerun; no repeat of the entire list was performed.

| Outstanding file / location | Current confirmed evidence | Required repair / success criterion / owner |
| --- | --- | --- |
| src/tools/__tests__/preview-document-process.test.ts:53,407 | Packaged-archive child contract fails; teardown cannot resolve original-fs in the allowed Node runtime. | Owner must provide a permitted standard-runtime verification environment, or explicitly revise the no-launch constraint in a later task. Success: actual archive child/split chunks parse and teardown succeeds. No shim or prohibited runtime was used. |
| src/tools/__tests__/background-shell-windows-job.test.ts:46 | Three cases require AVE_TEST_NODE_EXEC_PATH, absent in this direct Node-mode runner. Follow-up 3 already showed that assigning the current protected interpreter instead is refused by the sensitive-path guard. | Owner must supply a permitted standard test runner with a distinct native Node child. Success: kill/dispose/root-exit reap real descendants without interpreter copying or guard relaxation. The known rejected interpreter workaround was not retried. |
| src/permissions/__tests__/asrt-sandbox.test.ts:1580 | The expected deny-write list omits the current native Node interpreter path. | Owner should validate the runtime-sensitive floor assertion under a permitted standard runner and resolve the assertion/policy mismatch in its owning scope. Success: expected and actual floor agree without weakening runtime protection. Runtime causation remains unproven. |
| src/permissions/__tests__/mxc-sdk-packaging.test.ts:278 | Existing dependency junction produces ../ave-font/node_modules/... graph keys which the pinned-key assertion rejects. | Owner must authorize an independent dependency-layout or owning-path normalization repair. Preserve the shared installation. Success: actual import-condition graph maps to the pinned keys. |
| src/permissions/__tests__/mxc-policy-pipe.test.ts:195 | Synthetic launcher spawn-error emission escapes as spawn ENOENT. | Owner must authorize the separate transport/fixture lifecycle repair. Trace bindChild error-listener ownership with release; success: spawn failure is observed, release resolves, helper is killed once, and stdin is destroyed. |

These failing test boundaries were unchanged by `64a8c679e..566e5908a`; their current errors match the earlier report's independent limitations. They were included in the requested full validation and were not filtered out or converted to passes.

Awaiting the owner's permitted standard-runtime/native acceptance run and scope decisions for the independent transport/dependency-layout work and optional P3 display attribution. Browser fixes and final targeted/gate/build verification are complete; full regression/native acceptance remains explicitly incomplete. No push occurred.

# Follow-up 5

Starting HEAD: 566e5908a; branch fix/web-panel-site-permission. No push, history rewrite, app/dev/automation/E2E launch, baseline extension, credential/configuration edit or native recovery command. Live evidence directory remained read-only.

## N1

Root cause: the common marker's 100-line ceiling stubbed a 153-line, 5,438-character / 1,361-token snapshot despite fitting the 2,000-token budget; not a child-specific byte limit. The exact child tool view omitted recovery although the wire stub advertised it. Locations: src/shared/tool-result-trim.ts:20; src/engine/subagent-runner.ts:2307.
Fix: use token size while preserving hard scan bounds; register canonical read_tool_result_chunk for nonempty child scopes. Deny-all stays empty. Recovery uses the receiving child's existing history/artifact reader, not parent history (src/engine/turn/query-loop.ts:1606; src/engine/conversation-loop.ts:645).
Commit: 13a6909a6ed446c5e8dc7cea2db3ff41fe9aaa69.

Red, original product restored from backups with new tests:
node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/shared/__tests__/tool-result-trim.test.ts src/engine/__tests__/subagent-runner.test.ts -t 'small multiline snapshot|named tools and session recovery|recovers only results'
Three failed tests (ctmp/n1-final-red.log).
Green, fixed product restored:
node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/shared/__tests__/tool-result-trim.test.ts src/engine/__tests__/conversation-history-trim.test.ts src/engine/__tests__/subagent-runner.test.ts src/tools/__tests__/tool-result-chunk.test.ts
Four suites / 118 tests passed (ctmp/n1-final-green.log). Covers bounded multiline results, exact advertised/persisted scope, own-result recovery and foreign-result rejection.

## N2

Root cause: requestTabOp queued renderer close and waited for main-observed guest destruction (src/main/browser/browser-tab-registry.ts:1217,1262,468). Transcript toolDisplay.durationMs: 45,685 and 202,207; audit allowed both without another approval. Renderer guest removal was the dependency removed; logs do not establish the exact scheduling cause of every millisecond.
Fix: following existing ownership/actor/pause checks, close the owned embedded guest in main with waitForBeforeUnload:false; resolve only on destruction and send renderer cleanup without awaiting it (src/main/browser/browser-tab-registry.ts:1281). Missing/failed close fails closed; borrowed user tabs retain release-only behavior.
Commit: 167b4f4369498fde7f3c155667fbb33eebbb7eec.

Red with original product:
node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/main/browser/__tests__/browser-tab-registry.test.ts -t 'closes an owned guest'
One failure: unresolved outcome with stationary fake timers (ctmp/n2-red.log).
Green:
node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/main/browser/__tests__/browser-tab-registry.test.ts src/tools/__tests__/browser-tools.test.ts
Two suites / 194 tests passed (ctmp/n2-green-final.log). An unrelated lease and 60-second timer remain untouched.

## N3

Root cause: snapshotRun returned tracked running/working state without consulting pending child approval (src/engine/subagent-runner.ts:2066). Waiting for a card does not end/suspend the child turn.
Fix: exact-session canonical pending query projects status:waiting, taskState:TASK_STATE_INPUT_REQUIRED and pendingApproval:{toolName,target}. Uses display-masked fields bounded to 500 characters plus current controller binding checks (src/permissions/approval-gate.ts:1957). No raw args/signatures/capabilities disclosed. Allow/deny/cancel remove the projection. Parent visibility stays enforced; en/ko tool descriptions explain waiting for the user.
Commit: 6208b8930e9bfadd3087120c0af5a49b3e879788.

Red with original product restored from backups:
node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/engine/__tests__/subagent-runner.test.ts src/permissions/__tests__/approval-gate.test.ts -t 'pending approval status|pending session approval summary'
Four failures: running/working instead of waiting and missing summary query (ctmp/n3-final-red.log).
Green, same command without -t: two suites / 194 tests passed (ctmp/n3-final-green.log). Four new cases passed again with typed cancellation args (ctmp/n3-final-green-typed.log). Covers direct/list/status-tool output, other-parent exclusion, target masking and allow/deny/cancel cleanup.

## Validation corrections

Broader consumers retained obsolete line-count assumptions. Token-sized fixtures and the obsolete type comment were aligned. The command below first failed three cases (ctmp/n1-consumers-before.log), then passed two suites / 60 tests (ctmp/n1-consumers-green.log):
node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/engine/turn/__tests__/directory-instructions.test.ts src/engine/__tests__/conversation-loop-rounds.test.ts

Lint corrections removed two new non-null assertions and two concatenations. No baseline extended. All nine touched suites appear in the Windows CI regression list. Because amendments/history rewrites are prohibited, corrections are a fourth commit: 4bced7de0449a60f9f3476dd6c6d7bf867030c90. Each product item remains in its own commit.

## N4

No concrete hot-loop cause found; no speculative patch/commit. Inspected preview bridge/store/component, hidden guest reconciliation, placement, observation teardown and card lifecycle. Snapshots are cached (src/ui/renderer/preview/browser-observation-bridge.ts:101), preview polling tears down (src/ui/renderer/preview/BrowserObservationPreview.tsx:15), placement uses 24 settling frames (src/ui/renderer/components/WebSurfaceLayer.tsx:218). Live logs contain attachment/completion but no attributed stall profile. The live delay remains unverified. A later owner-run CPU profile across close/card settlement must identify the stack and reproducible regression before a concrete repair. No prohibited live run performed.

## Validation environment

TEMP, TMP, TMPDIR and AVE_TEST_TMP_ROOT: <lab>/tmp-codex/webfix/ctmp; child PSModulePath removed.
The prescribed test wrapper invokes the prohibited app runtime. Direct Node analysis mode honored the explicit no-launch rule; --configLoader runner avoids writes through the shared dependency junction. No runtime shim/permission bypass.

## Gate table

| Check | Result / evidence |
| --- | --- |
| Final touched suites | PASS: 9 files / 485 tests, ctmp/final-touched.log |
| typecheck | PASS, ctmp/typecheck-final.log |
| check:typecheck-tests | PASS existing baseline held (921 pre-existing errors); no baseline edit, ctmp/test-typecheck-final.log |
| check:knip | PASS within check:gate-core, ctmp/gate-core-owner.log |
| check:biome | PASS within check:gate-core, same log |
| check:test-duplicates -- --fail-on-duplicates | PASS within check:gate-core, same log |
| check:gate-core | PASS exit 0, same log |
| check:i18n-catalog | PASS locales=2 keys=5722 within full build, ctmp/build-final.log |
| check:import-cycles | PASS cycles=0 plus 5 checker tests within full build, same log |
| Full bun run build | PASS exit 0, same log |
| git diff --check 566e5908a HEAD | PASS |
| Added-line naming / scope sweep | PASS 218 added lines reviewed; no explanatory external product names; no web/** change |
| Windows CI command list | Final result recorded below |

Initial gate/build attempts under the restricted execution account failed Git ownership verification; re-running under the repository owner's execution route passed. No safe.directory or ownership configuration was changed. Initial lint and consumer failures were repaired, not baselined away. Tests used direct analysis mode throughout; the full build is build-only.

Exact final touched command:
node node_modules/vitest/vitest.mjs run --config config/vitest.analysis.config.ts --configLoader runner src/shared/__tests__/tool-result-trim.test.ts src/engine/__tests__/conversation-history-trim.test.ts src/engine/__tests__/subagent-runner.test.ts src/tools/__tests__/tool-result-chunk.test.ts src/main/browser/__tests__/browser-tab-registry.test.ts src/tools/__tests__/browser-tools.test.ts src/permissions/__tests__/approval-gate.test.ts src/engine/__tests__/conversation-loop-rounds.test.ts src/engine/turn/__tests__/directory-instructions.test.ts

## N5: host report attribution

Understood as: finish the four remaining branch items locally, preserving the permission decision tree, with one commit per item and no push.

Running-parent deliveries now carry an explicit sub-agent source independent of the optional child title, plus a display body separate from the model instruction. Mixed user/report queues split their transcript rows at the same round boundary after the existing whole-batch permission provenance calculation. Each row has its own durable identity and rollback. The existing report block receives the same source live and after reload. Manual mailbox consumption and autonomous wake also project the report body through that block; the model retains the host instruction. Title derivation excludes host injection/report metadata, including the renderer's approval-label fallback. No approval classifier, rule order or grant was changed.

Validation: 5 targeted suites / 124 tests; 12 consumer suites / 373 tests; 4 UI/storage consumer suites / 148 tests. Commands used the repository's test wrapper with `AVE_TEST_TMP_ROOT=/private/tmp/webfix-validation/test-tmp`. `bun run typecheck`, `bun run check:typecheck-tests` and `bun run check:biome` passed without baseline edits. `bun run build` and the subsequent `bun run build:renderer` passed. Native `TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/subagent-report.spec.ts` passed 1 test, checking persisted title and the report block, and attached a screenshot to its trace. The sandboxed desktop launch aborted; the isolated launch outside that sandbox passed. Logs are in `/private/tmp/webfix-validation/` and the trace is under `test-results/` (local, uncommitted).

Cold reading checked the typed source and rollback design. The truncation concern was resolved by reading the bounder: it drops complete entries, so split groups contain only text retained for the model. Whole-batch permission attribution is intentionally unchanged. Consistency audit found the queue, initial mailbox and wake producers using the existing report projection; no new public origin or privilege was added.

## Suggested reply prompt

Both locale instructions describe a single line beginning with `- ` between the existing reply tags, followed by the actual reply. Neither contains a copyable template line. The parser and its placeholder-only rejection test are unchanged. The prompt contract now checks both catalogs for the format and absence of the placeholder. There are no matching prompt snapshots to regenerate. Consistency review kept the parser's exact tags and the one-candidate policy.

`AVE_TEST_TMP_ROOT=/private/tmp/webfix-validation/test-tmp bun run test:vitest -- run src/prompts/__tests__/suggested-replies-contract.test.ts src/prompts/__tests__/system-prompt-builder.test.ts src/engine/__tests__/suggested-replies.test.ts src/ui/renderer/hooks/__tests__/use-chat-state-suggested-replies.test.tsx src/i18n/__tests__` passed 10 files / 126 tests (`/private/tmp/webfix-validation/item2-tests.log`).

## Parked guest liveness on Mac

The existing native preview fixture now has a dedicated parked-guest scope. Its driver accepts the current exact-site card through its actual button, then measures the same guest before and after parking. Parking retains opacity 0, pointer-events none, inert/aria-hidden and the guest instance. A guest-local animation loop is sampled for 750 ms, cancelled, and its visibility, frame count and viewport are attached as JSON.

`TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/browser-observation-preview.spec.ts -g 'keeps a parked agent guest'` passed 1 test. On this Mac, active: visible, 44 frames / 750.9 ms, 474×621; parked: visible, 46 frames / 751.9 ms, 474×621 (`/private/tmp/webfix-validation/item3-e2e.log`). No throttling was observed under this foreground-window, live-preview condition. Production guest preferences are unchanged. This does not establish behavior with the entire app hidden or without a live preview.

The original broader navigation scope also reached and passed the parked measurement (46 frames / 752.3 ms) but failed later on a second-origin navigation with `ERR_FAILED`; its remaining cross-site/takeover assertions are not verified here (`item3-navigation-baseline.log`). The dedicated scope isolates the requested liveness check without removing that broader test. The runtime emitted an 11-destroyed-listener warning; that warning alone does not identify a growing listener count or explain the reported renderer stall. Cold review prompted the same-guest active baseline instead of inferring normal frame rate from a nonzero count alone.

## N4: reproduced close-time exception

No hot-loop defect was found in the composer preview or approval-card paths: observation snapshots are cached, subscriptions use stable methods, the visibility interval is cleared, the placement loop settles, card observers disconnect, and screencast stop clears its watchdog/flush timers. The native close diagnostic did expose a different concrete cause of apparent UI unresponsiveness. Destroying an agent guest called a site-gate disposal callback whose transport re-read the destroyed guest's debugger property. The native error was caught by an uncaught-exception monitor as `TypeError: Object has been destroyed`. A one-second process sample showed the main thread waiting in `NSAlert runModal`; this was a modal wait, not evidence of a renderer CPU loop.

The action and preview transports now retain the debugger handle obtained while the guest is alive for listener removal. Their promised send methods also convert synchronous native command throws into rejections, which the existing cancellation/closed-session handlers consume. Site authorization, navigation rules, lease checks and approval decisions are unchanged. The pending-authorization regression verifies that a late authorization does not continue navigation after destruction. No speculative preview/card patch was made.

Two focused regressions first failed with one unhandled rejection (`item4-red.log`). After the fix, four lifecycle/action suites passed 196 tests; the final combined selection passed 33 files / 922 tests, and four additional browser consumers passed 221 tests. A test-only type correction was then verified by the one affected regression (1 passed / 159 filtered) and the test-typecheck gate; no baseline was extended. Native report replay, parked liveness and agent-close diagnostics passed 3 tests. The final close diagnostic recorded main-renderer CDP evaluation times of 7.22, 1.52, 22.82, 1.34 and 1.83 ms, zero remaining previews and zero late frames. This verifies the reproduced failure path; it does not establish that the original real-model run's 60-second delay had exactly the same cause. Cold review checked captured-handle lifetime, rejected-command handling and late authorization.

## Final local validation for these four items

All commands ran from `/private/tmp/webfix/ave`. Logs and native artifacts are under `/private/tmp/webfix-validation/`; they are local and uncommitted. The following commands were actually run:

```sh
AVE_TEST_TMP_ROOT=/private/tmp/webfix-validation/test-tmp bun run test:vitest -- run src/shared/__tests__/conversation-title.test.ts src/shared/__tests__/chat-history-meta.test.ts src/engine/__tests__/conversation-loop-guidance.test.ts "src/engine/__tests__/a2a-subagent-message-bus.test.ts" "src/engine/__tests__/a2a-wake-drain.test.ts" src/engine/__tests__/conversation-history-user-quotes.test.ts src/engine/turn/__tests__/turn-entry-classification.test.ts src/ipc/handlers/__tests__/chat-subagent-mailbox.test.ts src/ipc/domains/__tests__/chat-verbatim.test.ts src/memory/__tests__/session-repository.test.ts src/ui/renderer/hooks/__tests__/use-chat-state-remote-turn.test.tsx src/ui/renderer/__tests__/TranscriptRenderer.test.tsx src/ui/renderer/utils/__tests__/history.test.ts src/ui/renderer/__tests__/ChatView.test.tsx src/ui/renderer/__tests__/classify-turn-entries.test.ts src/prompts/__tests__/suggested-replies-contract.test.ts src/prompts/__tests__/system-prompt-builder.test.ts src/engine/__tests__/suggested-replies.test.ts src/ui/renderer/hooks/__tests__/use-chat-state-suggested-replies.test.tsx "src/i18n/__tests__" src/observation/__tests__/browser-screencast.test.ts src/main/__tests__/browser-observation-preview.test.ts src/ui/renderer/preview/__tests__/browser-observation-preview.test.tsx src/ui/renderer/preview/__tests__/browser-observation-bridge.test.tsx src/ui/renderer/components/__tests__/WebSurfaceLayer.test.tsx src/ui/renderer/__tests__/ApprovalDock.test.tsx src/main/browser/__tests__/browser-actions.test.ts src/main/__tests__/browser-preview-guest.test.ts
AVE_TEST_TMP_ROOT=/private/tmp/webfix-validation/test-tmp bun run test:vitest -- run src/tools/__tests__/browser-tools.test.ts src/main/browser/__tests__/browser-site-navigation.test.ts src/main/browser/__tests__/browser-tab-registry.test.ts src/main/browser/__tests__/browser-tools-source.test.ts
AVE_TEST_TMP_ROOT=/private/tmp/webfix-validation/test-tmp bun run test:vitest -- run src/main/browser/__tests__/browser-actions.test.ts -t "disposes a closed page session"
TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/browser-observation-preview.spec.ts test/e2e/ui/subagent-report.spec.ts -g 'keeps a parked agent guest|measures renderer evaluation|host reports replay' --output=/private/tmp/webfix-validation/native-final
bun run typecheck
bun run check:knip
bun run check:biome
bun run check:sot-shapes
bun run check:i18n-catalog
bun run check:gate-core
bun run check:typecheck-tests
bun run build
bun run build:renderer
bun run build:main
git -C /private/tmp/webfix/ave diff c7a39683b --check
```

| Command | Result | Log |
| --- | --- | --- |
| Combined test wrapper | 33 files / 922 passed | final-vitest.log |
| Additional browser consumers | 4 files / 221 passed | item4-consumers.log |
| Final type-only test correction | 1 passed / 159 filtered | item4-final-test.log |
| Changed native flows | 3 passed | final-e2e.log; native-final/ traces and attachments |
| typecheck | exit 0 | typecheck.log |
| check:knip | baseline passed: 5 devDependencies, 5 duplicates, 42 exports, 7 files, 140 types | knip.log |
| check:biome | baseline held: 13456 accepted diagnostics / 2851 entries | biome.log |
| check:sot-shapes | 6 checker tests passed; baseline held | sot-shapes.log |
| check:i18n-catalog | 2 locales / 5794 keys | i18n.log |
| check:gate-core | exit 0; 55 checker tests passed; 0 duplicate helpers across 2578 test files | gate-core.log |
| check:typecheck-tests | baseline held: 208 files / 921 pre-existing errors | typecheck-tests.log |
| build / build:renderer / build:main | passed; main rebuilt after the teardown fix | build.log; item1-renderer-build.log; item4-build-main.log |
| diff whitespace | passed | command output |

The broader native cross-site scope was rerun after the fix and still fails at navigation to the local fixture's second origin with `ERR_FAILED`: `TMPDIR=/private/tmp bun run test:ui-e2e -- test/e2e/ui/browser-observation-preview.spec.ts -g 'streams a bounded live preview'` (navigation-recheck.log). Its later assertions remain unverified. No permission change was attempted to make that scenario pass. The earlier real-model multi-child run, a hidden app window, and parked guests without a live preview were not rerun. The native 11-destroyed-listener warning remains; no growing listener count was demonstrated. No remote CI, push or merge was performed.

### Item file inventory

8099ec417a4b2962520e999427d238d10a51c498 fix(chat): preserve host report origin to prevent user steering and title changes

```text
docs/evidence/web-panel-2026-11-09/report.md
src/engine/__tests__/a2a-subagent-message-bus.test.ts
src/engine/__tests__/conversation-loop-guidance.test.ts
src/engine/a2a-subagent-message-bus.ts
src/engine/conversation-loop.ts
src/engine/turn/query-loop.ts
src/engine/turn/run-turn.ts
src/engine/turn/types.ts
src/ipc/domains/chat.ts
src/ipc/handlers/__tests__/chat-subagent-mailbox.test.ts
src/ipc/handlers/chat-stream.ts
src/ipc/handlers/chat.ts
src/shared/__tests__/conversation-title.test.ts
src/shared/conversation-title.ts
src/ui/renderer/ChatView.tsx
src/ui/renderer/__tests__/TranscriptRenderer.test.tsx
src/ui/renderer/hooks/__tests__/use-chat-state-remote-turn.test.tsx
test/e2e/ui/subagent-report.spec.ts
```

6d2a5da9f56fd1c90e6231480a63d76b1b9ea2a7 fix(prompts): describe reply syntax to avoid echoed placeholders

```text
docs/evidence/web-panel-2026-11-09/report.md
src/i18n/messages/en.ts
src/i18n/messages/ko.ts
src/prompts/__tests__/suggested-replies-contract.test.ts
```

76a235ae0bd542b1d6b504b31d609c73f37f64b5 test(browser): compare parked guest animation with its visible baseline

```text
docs/evidence/web-panel-2026-11-09/report.md
test/e2e/ui/browser-observation-preview.spec.ts
```

Close-time exception fix (fourth item; SHA supplied in the final handoff):

```text
src/main/__tests__/browser-preview-guest.test.ts
src/main/browser-observation-preview.ts
src/main/browser/__tests__/browser-actions.test.ts
src/main/browser/browser-actions.ts
test/e2e/ui/browser-observation-preview.spec.ts
docs/evidence/web-panel-2026-11-09/report.md
```
