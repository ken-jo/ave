# Native shutdown and repeated validation

## Teardown cause

The fixture requested quit through a main-process evaluation, waited for
`will-quit`, and then called `app.close()`. The close operation itself requests
quit before disconnecting its inspector. Calling it after native shutdown had
already reached `will-quit` could leave that second request unanswered while
native shutdown waited for the same inspector to disconnect.

All three preserved failures reached this sequence. The first quit evaluation
replied in 76.621, 200.810 and 94.308 ms respectively. The following close-context
operation never replied, stderr reported `Waiting for the debugger to
disconnect...`, and the existing 60000 ms teardown budget expired. The settings
assertions had already completed.

The fixture now calls `app.close()` once as the graceful quit initiator. It still
requires both native process exit and inherited-pipe closure, rejects abnormal
exits during graceful shutdown, and does not treat a missing close response as
proof that the process exited. Explicitly terminated fixtures retain their
existing pipe-draining path.

The sequencing regression fails on the prior helper because close starts after
`will-quit`; it passes with the corrected ordering. Fixture tests also preserve
prevented-quit, process-error, lost-response, abnormal-exit and pipe-lifetime
coverage. No timeout, retry, skip or pixel tolerance changed.

## Native attachment during capture startup

The owner is the host's native window. Parking keeps a page alive but positions
its view outside that window.

A subsequent isolated whole-spec run passed 235/240 cases across twenty
repetitions. Five first cases failed their native attachment check before
capture; its 421 process samples recorded one native app at most, no external
native apps and no CI workers. Machine overlap does not explain these failures.

Focused instrumentation showed an accepted visible presentation followed by a
`hide` notification while the owner still reported `isVisible()=true` and
`isMinimized()=false`. The notification's stack led through the host's hidden
handler to parking. The renderer caches successfully submitted slot geometry;
that geometry had not changed, so it did not submit another placement. This left the native
page parked through the attachment deadline.

The host now checks current owner visibility before handling hide or minimize
notifications. Late notifications cannot park a page in an already visible
window. Real hide and minimize still park it; restore, input rejection and
document-epoch invalidation retain their existing behavior. Two deterministic
late-notification regressions fail on the previous host. The related host and
IPC suites pass 116 tests after the change.

## Final shared-budget validation

Both final whole-spec runs passed all twenty repetitions, including teardown.

| Whole spec | Before the follow-up fix | Final twenty repetitions |
| --- | --- | --- |
| Settings, including graceful teardown | 17/20; three teardown timeouts | 20/20 |
| Native capture | 15/20; 235/240 cases, five attachment failures | 20/20; 240/240 cases |

Capture completed in 310.770 seconds and settings in 420.697 seconds. Both have
zero failures, skips or retries. Whole-spec counts include fixture setup and
teardown.

Both specs use the workspace's `run-with-budget.mjs`, one test worker, zero
retries, background mode, per-fixture isolated homes and dynamic debugging ports.
Neither spec uses port 9222 or native foreground focus.

Capture's final twenty repetitions have 279 process samples: native E2E apps
maximum one, external native apps zero, CI workers zero and sampling errors zero.
The following settings run also passed 20/20, but another job entered the
budget's second default slot during its last two cases. That settings result is
retained, not accepted as isolated validation. The one-slot override controls
the caller's admission choices; it does not prevent a default two-slot caller
from using the second slot.

The final settings run therefore uses two sibling budget jobs: the test driver
and an independent process/lease observer. The driver waits until the observer
owns the other slot before launching. Both leases remain occupied until the
test driver finishes, so other participating jobs queue. They launch only one
native app at a time and do not nest wrappers. Pre-existing unwrapped runners
and active CI workers must also finish before launch; the observer records any
later overlap instead of assuming the budget controls unwrapped commands.

The final settings driver recorded 379 process samples and the independent
observer recorded 380. Both report native E2E apps maximum one, external native
apps zero, CI workers zero and sampling errors zero. The observer recorded no
foreign budget lease during this run. Both budget jobs exited successfully and
released their leases.

Earlier overlapping batches remain preserved. One completed settings batch
passed 20/20. A later complete batch passed settings 20/20 and capture 237/240;
three capture cases failed in setup while waiting for native attachment, before
their capture assertions ran. Its samples recorded up to three native apps and
external apps in 712 of 899 samples. This establishes overlap, not the cause of
those setup failures. Neither batch supplies the final isolation evidence.

With `AVE_VALIDATION_RUNNER` set to the workspace helper's absolute path, the
capture invocation from the repository root was:

```sh
AVE_TEST_TMP_ROOT="$PWD/test-results/vitest-tmp" AVE_VALIDATION_SLOTS=1 \
  node "$AVE_VALIDATION_RUNNER" e2efix-verified-20x -- sh -eu -c '
    bun run test:vitest src/main/browser/__tests__/browser-native-surfaces.test.ts src/ipc/domains/__tests__/browser.test.ts
    bun run build
    node test-results/root-cause-evidence/run-verified-final.mjs
  '
```

The final settings and observer commands run as sibling foreground jobs. Their
retained local drivers coordinate readiness and observer completion:

```sh
AVE_VALIDATION_SLOTS=2 node "$AVE_VALIDATION_RUNNER" e2efix-reserved-settings \
  -- node test-results/root-cause-evidence/run-reserved-job.mjs &
settings_pid=$!
AVE_VALIDATION_SLOTS=2 node "$AVE_VALIDATION_RUNNER" e2efix-reserved-observer \
  -- node test-results/root-cause-evidence/run-reserved-observer.mjs &
observer_pid=$!
wait "$settings_pid"
wait "$observer_pid"
```

Each selected spec uses these unchanged flags, substituting its filename:
`bunx playwright test --config config/playwright.config.ts --project=background
test/e2e/ui/<spec>.spec.ts --repeat-each=20 --workers=1 --retries=0
--reporter=list,json`, with an isolated output directory and JSON report.
The drivers require complete JSON counts and zero failures, skips or retries.

Local evidence is under `test-results/root-cause-evidence/`:

- Teardown: `teardown-before.json`, `teardown-quit-protocol.json`.
- Final capture: `verified-capture.json`, `verified-capture-isolation.json`.
- Final settings: `reserved-settings.json`, `reserved-budget-lease.json`,
  `reserved-isolation-summary.json`, `reserved-observer-summary.json`.
- Earlier overlap: `budgeted-final-results.json`,
  `budgeted-isolation-summary.json`, `verified-settings.json`,
  `verified-isolation-summary.json`.
- Isolated attachment failures: `exclusive-capture.json`;
  `attachment-diagnostics.json` contains focused event/call-stack instrumentation.

These evidence artifacts and local drivers are retained locally and are not
tracked by Git. Temporary diagnostic code was removed before final validation.
The four executable/test source hashes in `verified-source-fingerprint.json`
matched after both final runs.

The follow-up also passed 52 quit, launch and fixture-contract unit tests.
Source typecheck and focused lint passed. The test typecheck's existing-baseline
guard reported 903 errors in 206 files both before and after the host fix
(`../quit-static.log` and `../late-hide-after.log`, relative to the repository
root); this is not a zero-error claim. The successful build preceded the final
capture run. Executable/test source remained unchanged through both final runs.

## Historical colour shift

The scroll-completion fix addresses partially painted capture tiles. It does
**not** explain the historical RGB `(5,166,90)` result instead of `(0,166,90)`.
That trigger and its cause remain undetermined. No pixel tolerance was added or
increased, and the historical result is not classified as an environment error.

Foreground native focus and other operating systems were not tested.
