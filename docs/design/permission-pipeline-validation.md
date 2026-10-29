# Permission pipeline validation record

Snapshot: 2026-10-30, working tree on `feat/permission-pipeline-v4`. The [approved decision tree](../architecture/permission-decision-tree.md) defines behavior; the [97-site inventory](permission-decision-inventory.md#current-source-reconciliation) records current source ownership and retained boundaries. These results describe the inspected working tree before the final publish gates. They do not certify a release or future CI result.

## Targeted results

| Scope | Observed result | Evidence and limits |
| --- | --- | --- |
| Core decision matrix, native executor, authorization and escalation | 10,589 passed across 5 files | `core-final.log`: pure matrix and boundary cases plus actual executor/authorization paths. Escalation cases use controlled issued evidence; they do not establish native Linux denial attribution. |
| Replay reconstruction, root binding and manager | 52 passed across 4 files | `replay-manager-final.log`: saved invocation references, fresh permission entry, exact input/root identity and manager integration. Persisted references are not stored grants or executable-input copies. |
| Scoped rules and redirect boundaries | 75 passed | `redirect-final.log`: full scoped-rules suite after earlier redirect failures were fixed. A preceding single-case filtered run is not counted as another 75 passes. |
| IPC grants, effect ledger and terminal authorization | 16 passed across 3 files | `consumer-final.log`: egress-grant IPC, host-observed effect ledger and terminal authorization-required behavior. |
| Changed desktop flows | 6 unique cases passed | `ui-e2e.log` initially had 4 passes and 2 navigation-fixture failures. After fixture corrections, `ui-e2e-recheck.log` passed the 2 affected cases and repeated 1 already passing navigation case. The repeated case is counted once. |

These are separate targeted runs. Their totals are not a fresh whole-suite result, and overlapping cases are not additional unique coverage.

## Built-app and visible evidence

The isolated built app was exercised through the desktop test harness and CDP. The captured permissions view shows the owner-away value `0` with its unlimited-wait explanation, a DLP-redacted recent denial and the no-retry reason. The seeded entry has no safely resolvable original invocation, so its rerun control is disabled; this screenshot does not prove the valid persisted-reference rerun path. That path has separate reconstruction and executor tests above. The inspected capture contains no account email.

![Owner-away unlimited setting and recent denial history](evidence/permission-pipeline/owner-away-recently-denied.png)

The screenshot and CDP assertions establish the displayed state in that isolated build. They do not establish production authentication, every native backend or a packaged installer result.

## Remaining gates and decisions

- Final production typecheck: passed (`typecheck-publish-final.log`). The test-type ratchet also held (`test-types-publish-final.log`): inherited diagnostics remain at 232 files / 1,013 errors, with 3 files improved and 12 fully fixed; this is not a clean test compilation.
- Final full app build and isolated CDP launch: passed (`cdp-publish-launch.log`). `cdp-publish-assertions.json` confirms owner-away `0`, zero obsolete interactive selectors and no account email. The screenshot above records the corresponding permissions state.
- Production/push gates after the latest source changes: pending. No future CI or publish result is asserted.
- Native filesystem-denial attribution is supported by the macOS monitor. Installed Linux diagnostic-attempt records are deliberately rejected as escalation authority, so Linux retains the original failure. The owner decision remains pending: accept this limitation or require a trusted Linux supervisor before delivery. Controlled Linux executor cases prove orchestration only.
- Related terminal work [#308](https://github.com/ken-jo/ave/pull/308) remains open in this handoff; this record does not count it as landed verification.
- The external design source has three-way drift relative to the committed contract and implementation. Its proposed surface selectors remain pending owner confirmation; this record does not revise the immutable tree.

## Integration follow-up

The first normal push stopped at the test-type ratchet. Test fixtures and obsolete parent-review expectations were corrected without changing the baseline. The ratchet then held; production types remained clean. The repository's inherited test-type errors are not represented as a clean test compilation.

Further direct-consumer checks exposed and corrected loss of mandatory-floor metadata after an outer approval, swallowed no-approver denials in nested effects, stale rationale eligibility/order assumptions, and cancellation while awaiting a moved hook. Cached shell-egress rules and grants now enter fresh policy evaluation before use; a forced one-connection answer cannot become a standing grant. Concurrent initial project-rule loads share one snapshot rather than manufacturing different policy epochs for identical bytes.

| Additional boundary | Observed focused result |
| --- | --- |
| Child permission and working-directory provenance | 25 passed |
| Automatic pause, caller stop and rationale resume | 27 passed |
| Rationale guards and ordered security suffix | 175 passed; a later 43-case ordering recheck also passed |
| Hook cancellation and managed-child ownership | 49 passed across 6 files |
| Shell-egress policy, grants and phase continuation | 262 passed across 8 files; existing platform skips excluded |
| Network request normalization | 14 passed |
| Concurrent project-rule loading plus affected egress callback | 106 passed; overlaps the egress set above |
| Caught nested no-approver denial and replay | 9 passed; includes earlier replay cases |
| Mode and typed UI fixture consumers | 173 passed across 5 files |
| Parameter binding and shell path evidence | 222 passed across 3 files, including the 162-case shell rules suite; the 162 cases are not added again |
| Final shell-egress boundary reconciliation | 1,125 passing cases across 37 files, deduplicated by latest result per file; overlaps earlier egress checks and is not one fresh combined run |
| Fixed automatic-review UI behavior | 231 passed across 5 files; overlaps earlier mode/UI checks |
| Fixed automatic-review backend behavior | 366 passing cases in the lead backend reconciliation; overlaps earlier manager/judge checks |

These focused results overlap and are not summed. Final normal-push status remains a separate publish gate.

## Latest boundary rechecks

The parent-model and away automatic deciders are retired. The breaker now overlays normal human routing on all automatic decision sources for the rest of the turn, including reads, remembered grants, successful reviewer results and Allow mode. Admission denials and forced floors remain intact. A configured uncovered outside read is an S1 denial under accepted resolution 4; outside sandbox filesystem scope instead reaches the escalated mode/human route before expansion.

| Recheck | Observed result and reporter |
| --- | --- |
| Pure decision and rest-of-turn overlay | 10,797 passed across 2 files; `validation-pipeline-pause-final.log`. Overlaps the earlier core matrix. |
| Outside sandbox scope and exact escalation | 8 passed; `sandbox-scope-final.log`. Controlled executor evidence retains the native Linux limitation above. |
| Retired parent configuration data | 281 passed across 2 files; `retired-parent-flag-data.log`. |
| Checkpoint-backed project-write fixtures | 31 passed; `project-write-fixtures.log`. |
| Executor and approval-memory consumers | 137 passed across 2 files; `executor-and-memory-final.log`; subsequent executor-only recheck passed 119 in `executor-two-targets-final.log`. These overlap and are not added. |
| Broker route and mandatory floors | 10 passed; `validation-broker-route-final.log`. |

Production typecheck and the test-type ratchet passed in the final publish checks described above. The normal push has not yet run. No cross-run aggregate or future CI success is asserted. The Linux owner decision and open terminal work #308 remain unchanged.

## Same-card rule saves and final execution admission

An independently reviewed P1 race is resolved by a synchronous policy-epoch check at final handler admission, after asynchronous route preparation. That check runs without an await before handler entry. The same-card rule-save receipt permits only its authenticated, exact pending decision to cross the expected single policy transition; it does not grant an action or waive later deny/floor/capability checks. Unrelated changes, copied answers, overlapping saves and replay remain rejected.

| Final check | Observed result and scope |
| --- | --- |
| Prefix-save identity and races | 310 passed across 5 files; `prefix-save-final-boundaries.log`: native approval/execution 35, permissions IPC 152, approval gate 110, rule-ceiling provenance 10 and owner-away feedback 3. The actual host command executes once after its own valid save; unrelated policy changes prevent execution. |
| Shell/network wildcard warning consumers | 69 passed across 4 files; `wildcard-warning-renderer.log`. Shell broader-scope warnings and network sandbox-only warnings retain distinct semantics. |
| Late pause and execution races | 30 passed; `late-pause-final.log`. This full affected-file result includes the earlier 2-case host-race filter and overlaps previous pause coverage. |

These groups are not summed with earlier overlapping results. Normal push remains pending; no future CI result is claimed.
