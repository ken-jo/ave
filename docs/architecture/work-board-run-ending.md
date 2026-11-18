# Work board run endings

Status: Active. This page is the design for how a template run of a board row
ends: which stored state may end it, what counts as evidence, who reads the
delete intents and when, and what a failed delete leaves behind. It goes with
the write guard in [Architecture](./architecture.md#work-board) (the board
write invariant, I1 to I3), which it does not change: the row-id floor, the
values-only evidence scan, `rewriteKeepingBytes` and the backup rules stay as
that section describes them.

## Stored authority

`WorkflowRunStore` (`src/main/workflow-run-store.ts`) owns
`work-board/workflow-runs.json` and in it:

- the row-id floor (I1);
- each run's binding `{runId, itemId, pin, runStartedBy}`, fixed by its first
  write;
- the delete intents `{itemId, runId}`, one per user delete of a row that
  named an unsettled run;
- the unknown markers `unknownDeletes: [{itemId, runId}]`, one per delete step
  whose outcome is not known yet (see [Failure lifecycle](#failure-lifecycle)).
  The key is left out while there are none.

An intent is open only while exactly one readable, unsettled record has its
`runId`, and that record is bound to its `itemId`. A row id that is absent or
reused grants nothing by itself.

## Evidence

Evidence is read from the raw text of `board.json` on disk:

- only non-empty JSON string values count, decoded again while they still hold
  JSON, and compared by exact equality with stored run ids (1 to 256 UTF-16
  units); keys and syntax never count;
- text that still decodes past 16 levels holds every run, so nothing is
  released over it;
- a listed row with the intent's `itemId` holds its intent's release, even when
  no string in it holds the run id;
- so does an entry of the items list that does not validate and has that
  numeric `id`. Such an entry is shown as an invalid card, and deleting that
  card goes through its own intent (below), so a release it holds never wedges.

## One classifier

`classifyRun` (`src/main/run-classification.ts`) is pure and total. It takes
what the run file says of one unsettled run (a snapshot: readable or not, an
open intent, an unknown marker) and what the board file on disk shows of it
(none when that file shows nothing: absent, awaiting review, unparsable or
without an items list), and returns exactly one class:

| Run file | Board on disk | Class |
|---|---|---|
| cannot be read | any | `unreadable` |
| readable | shows nothing | `unreadable` |
| unknown marker for the run | any | `unreadable` |
| open intent | the run id held, a listed row with its id, or an entry with its id that does not validate | `waiting-delete` |
| open intent | none of these | `due-delete` |
| no intent | the row names the run | `live` |
| no intent | no row with its id, or the row holds the run only in its run history | `orphan` |
| no intent | the row neither names nor holds it, or it may have been written over (`unknownBelow`) | `lost` |
| no intent | the row does not validate | `unreadable` |

Rows are read in that order. A run with an open intent or an unknown marker is
never `orphan` or `lost`. A table test enumerates every combination of these
inputs with its expected class.

## Consumers

Every consumer reads the class through the store (`runClasses`) and keeps no
standing rule of its own:

| Consumer | `live` | `due-delete` | `waiting-delete` | `unreadable` | `orphan` | `lost` |
|---|---|---|---|---|---|---|
| boot and live adoption | adopted | cancelled, item removed | kept | kept | cancelled | error, `template-run-lost` |
| `checkRows` after a board write | runs on | stopped, then item removed | runs on | runs on | stopped, then cancelled | ends error |
| a run write whose row is gone | written | stopped, then item removed | held, not written | held, not written | stopped, then cancelled | ends error |
| delete-intent takeover | | cancelled, item removed | | | | |
| reader, start, decide, `clearMissingRun` | reconsider intents and markers first, then act | | | | | |

A start or a decision is refused while a run end is not confirmed, as before.

## One settle point

`WorkflowRunStore.settleRun` is the only write that sets a record's `settled`.
`put`, `update` and retention refuse any change of `settled`, so no other module
can write a terminal status. A structural test checks that.

| Cause | `settled.status` | Check at the boundary |
|---|---|---|
| completed | completed | the row names the run |
| denied | denied | the row names the run |
| failed | error | the row names the run |
| stopped | cancelled | the row names the run |
| unstarted | error | a readable board shows no row naming it |
| item-removed | cancelled | class `due-delete` |
| orphan | cancelled | class `orphan` |
| lost | error | class `lost` |

For the deletion-derived causes (item-removed, orphan, lost), `settleRun`
classifies the run again inside the run-file lock, from the board file read
under the board lock, and refuses a cause the class does not allow; the run
then stays unconfirmed and the next permitted event tries again. The settle
writes the final stage states and `settled` in one write, and in that same
write the run's intent and marker go. Stop, completion and failure never go
through intent logic.

## Failure lifecycle

Each step of a delete ends as `unlanded`, `landed` or `unknown`. An attempted
write is never a confirmation: a write is confirmed by reading the file back.

| Step | Unlanded | Landed | Unknown |
|---|---|---|---|
| intent publication | nothing to undo | go on | read the run file back: intent there, withdraw it; absent, nothing |
| board preparation (guard, copy) | withdraw the intent | | |
| replace, directory sync | withdraw the intent | keep the intent, tell listeners | read the board back; unreadable, store a marker |
| withdrawal | | done | keep the intent; store a marker |

- Withdrawal writes the run file and reads it back; it counts once the intent
  is gone, whatever the write reported.
- An unknown outcome is stored as a marker beside the intents, so it survives a
  restart. When the run file cannot be written either, the store keeps it in
  memory and the run stays held (`unreadable`) until a permitted read
  succeeds; it is never read as unlanded.
- A marker is resolved under the board lock by the next permitted read: the
  board lists a row with that id, so the delete did not land, and the intent
  and marker are withdrawn together; a readable board without it means it
  landed, so only the marker goes and the classifier decides when the intent is
  due; a board that shows nothing keeps the marker.

## Readers and recovery

The permitted events are boot, a reader (list), a start, a decision, adoption
and `clearMissingRun`. Each one reconsiders the open intents and markers;
an adoption that already ran never suppresses this, and nothing waits on a
timer or a restart.

A run file that cannot be read opens an unreadable episode. The first permitted
event that reads it again runs `reconcileInterruptedRuns`, the same function
boot runs, with the core engine's in-flight runs left alone: a dead ordinary
run closes as `error` and becomes runnable, a live execution is untouched, and
refused user writes are not replayed. While the episode is open the list
carries the `work-board-runs-unreadable` notice (en and ko) once, as one
banner rather than per refusal, and recovery clears it.

## Retention and envelopes

- Retention and the workspace sweep prune only records confirmed settled; an
  unconfirmed end keeps its record and workspace.
- Every IPC mutation answers its declared envelope. `decide-stage`,
  `decide-join` and `retry-stage` refuse with `{ok: false, reason: code}`, the
  code being a store refusal code where the store refused.

## Tests

- `run-classification.test.ts`: the classifier table over every input
  combination.
- `run-ending-structure.test.ts`: no module but the run store writes a terminal
  status, and every listed consumer reads the class and ends runs through
  `settleRun`.
- An engine property test drives the real engine through boot adoption, live
  adoption, `checkRows` and run writes over every open-intent state and failure
  window, with its own oracle, and checks each end against the class.
- The delete failure windows, marker resolution, recovery and the notice have
  targeted tests beside the write guard's.
