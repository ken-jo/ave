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
- the unknown markers `unknownDeletes`, one per delete step whose outcome is
  not known yet (see [Failure lifecycle](#failure-lifecycle)), each
  `{itemId, runId, op, ownIntent, entrySha}`: `op` is `"row"` for the delete
  of a listed row and `"card"` for the delete of an invalid card, `ownIntent`
  says that delete stored the intent itself, and `entrySha` is the identity of
  the entry it deleted (see [Evidence](#evidence)). The key is left out while
  there are none;
- the held events `heldEvents`, one per engine event of a run that a run write
  could not store while the run's class held it (see
  [Held events](#held-events)). The key is left out while there are none.

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
  card goes through its own intent (below), so a release it holds never wedges;
- an entry's identity, `entrySha`, is computed over its raw stored bytes, in
  the unit this walk reads: the file's bytes decoded as UTF-8, the entry's span
  of that text from its first character to its last (the element of the items
  list exactly as stored, whitespace between elements left out), encoded back
  as UTF-8 and hashed with SHA-256 (hex). It is never computed from a parse or
  a re-serialization. When the entries cannot be read off the text so (a
  top-level key given twice, or a count that differs from the parse), no entry
  has an identity.

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
| no intent | the row does not name the run but holds it in its run history | `orphan` |
| no intent | no listed row with its id but an entry with that id that does not validate; or, the row absent or neither naming nor holding the run, a string value in the file holds the run id; or, the row absent, an entry has no usable id | `unreadable` |
| no intent | no row with its id, at or above `unknownBelow` | `orphan` |
| no intent | the row neither names nor holds it, or there is no row with its id below `unknownBelow` (it may have been written over) | `lost` |

Rows are read in that order. A run with an open intent or an unknown marker is
never `orphan` or `lost`. A table test enumerates every combination of these
inputs with its expected class.

## Consumers

Every adoption candidate that is unsettled reads the class through the store
(`runClasses`), including a run its row names. Held and unreadable candidates
stay unadopted. Other consumers use the same class. A run write may decide by
the row's standing on disk first; it requests an end, which `settleRun` writes.
It reads the class when the row does not name the run:

| Consumer | `live` | `due-delete` | `waiting-delete` | `unreadable` | `orphan` | `lost` |
|---|---|---|---|---|---|---|
| boot and live adoption | adopted | cancelled, item removed | kept | kept | cancelled | error, `template-run-lost` |
| `checkRows` after a board write | runs on | stopped, then item removed | runs on | runs on | stopped, then cancelled | ends error |
| a run write | written | stopped, then item removed | held, not written | held, not written | stopped, then cancelled | ends error |
| delete-intent takeover | | cancelled, item removed | | | | |
| reader, start, decide, `clearMissingRun` | reconsider intents and markers first, then act | | | | | |

A run write that is held keeps its event (see [Held events](#held-events)).
A run write whose board file shows nothing, or whose row's standing on disk
reads unreadable (the no-intent `unreadable` row of the classifier table: an
entry with its id that does not validate, an entry without a usable id, or a
string value elsewhere holding the run id), is refused `board-unread` before
any class is read, whatever the intent. This refusal holds the scheduler event
with the same identity, ordering and revalidation rules as a held row write;
it never faults the run. The host reports `template-runs-board-unread` once per
unreadable-board episode, shown as one localized pause notice while the run
stays unsettled. A successful run write clears the episode and its notice.
Once the board is readable again, the next permitted read revalidates and
replays held events without a restart.
Adoption ends an orphan or a lost run without an event.

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
then stays unconfirmed and the next permitted event tries again. So does an
end whose write throws: whether it landed is not known, so the run ends as a
fault and its end is written again. The settle writes the final stage states
and `settled` in one write, and in that same write the run's intent, marker and
held events go. Stop, completion and failure never go through intent logic.

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
- A marker is resolved under the board lock by the next permitted read, by
  its operation (`markerOutcome`, beside the classifier, pure and total). On a
  readable board:
  - positive absence: no entry of the items list has the marker's `itemId`,
    valid or not, and the evidence walk finds no string value equal to its
    `runId`. The delete landed, whatever its operation; only the marker goes,
    and the classifier decides when the intent is due. The board facts carry
    both observations; an absent item id alone never resolves an ambiguous
    marker while a value still holds its run id;
  - a row op that owns its intent follows the listed-row rule: the board lists
    a row with that id, so the delete did not land, and the intent and marker
    are withdrawn together; otherwise it landed, so only the marker goes;
  - a card op that owns its intent, with an entry whose `entrySha` is the
    marker's still on the board, did not land: the intent and marker are
    withdrawn together;
  - anything else is ambiguous and held, never withdrawn: the marker stays and
    the run stays `unreadable`. That is a card op whose entry is gone while
    another entry with its id remains, or whose entries have no identity; a
    marker whose delete went through another delete's intent (`ownIntent`
    false; the store records none); and a legacy marker of the pair alone, or
    of any other shape, which says neither which operation it was nor which
    entry.

  A board that shows nothing keeps every marker.
- A held row or card stays deletable by the user. That delete publishes a
  fresh intent for the marker's run, owned by it, and the same run-file write
  drops the old marker; from there the new delete's own lifecycle applies.
  Deleting its bound row or card takes this fresh-intent path. If only a run-id
  remnant elsewhere remains, the marker stays held: deleting an unrelated row
  grants no release authority. The user repairs that remnant on disk (or
  restores the bound row or card and deletes it). Once the evidence walk also
  confirms positive absence, the next permitted read drops the marker.
- A production marker always carries its operation; `entrySha` is left out
  only when the entries have no identity. The store's call that records an
  unknown outcome by the pair alone, which only tests make, records a row op
  that owns its intent, without `entrySha`: the listed-row rule never reads it.
- An invalid card's delete takes the same steps through its own intent. For
  the one open run bound to the entry's id, that is the intent of the row's
  delete when one is open, or one the card's delete stores first when the entry
  holds the last string of that run in the file; either way listeners are told.
  Its readback counts it unlanded while the board still holds that entry. Any
  other delete that would take out a run's id stays refused.

## Readers and recovery

The permitted events are boot, a reader (list), a start, a decision, adoption
and `clearMissingRun`; an ordinary row's start and plan decision count too.
Each one reads the delete intents and markers again (the stage engine's
`adopted`), then releases held events and checks for lost stages (see
[Held events](#held-events)); an adoption that already ran never suppresses
this, and nothing waits on a timer or a restart.

A board write refused because the run file cannot be read opens an unreadable
episode (`WorkBoardStore.recoverRuns`). The first permitted event once the file
reads again runs `reconcileInterruptedRuns`, the same function boot runs, with
the rows of the core engine's in-flight items left alone: a dead ordinary run
closes as `error` and becomes runnable, a live execution is untouched, and
refused user writes are not replayed. While the episode is open and the list's
own read of the run file still fails, the list carries the
`work-board-runs-unreadable` notice (en and ko) once, as one banner
(`writesRefused`) rather than per refusal; a list that reads the file again,
and recovery, clear it. A run file that does not parse or holds a key twice
fails the list itself, with its own reason, as before.

## Held events

A scheduler event (a child's link or end, a gate verdict, a refused spawn, a
seal or join outcome, a start, a Stop, a fault) is stored by a run write. When
that write is refused `board-unread`, it holds the event as described above.
When it finds the row not naming the run (`row-gone`, `row-lost`), it reads
the class: a class that ends the run (`due-delete`, `orphan`, `lost`) ends it
as before, and the event goes with that end. Under any other outcome (the
class holds the run, or cannot be read) the event is held: it is retained and
revalidated, never dropped, and the run is not faulted for it. A pre-spawn
workspace write refused while its class holds the run follows this same path:
its `spawn_requested` event retains the stage and attempt, spawns nothing while
held, and retries preparation and the spawn checks once released. A retried or
superseded attempt is dropped before any new preparation.

- Identity: `{run, stage, attempt, kind}`. The stage is the event's stage or
  join, none for a run-wide event; the attempt is the event's own, else the
  attempt the run file shows for that stage when the event is held, else 0 (a
  join has no attempt counter). Held events are stored deduplicated by
  identity and applied idempotently: an event held twice is held once, and a
  replay of one already applied changes nothing. Each in-process replay has
  an effect-attempt token, checked and claimed immediately before each effect
  (including stage and item notifications). Auto-gate evaluation, spawn,
  interrupt, seal, integrate, settle and workspace release all use it. If the
  handle throws before any effect starts, the event stays held. Once an effect
  starts, the event is consumed even if the handle later throws; the throw is
  logged and that event never invokes an effect again. A running stage with
  no remaining child or event still takes the lost path below.
- Storage: `heldEvents` in the run file, each entry the event's run and
  identity (`{itemId, runId, stage, attempt, kind}`); the event itself is kept
  in the engine's memory, since a restart reads back only a Stop's kind
  (Restart). When that write fails, the engine
  keeps the event in memory, fail-closed: it is still held, still keeps its
  stage off the lost path, and is resolved at the next permitted read like a
  stored one. Within a process the engine's memory decides: an event leaves
  memory once applied or dropped, then the file, and a copy left in the file
  is never applied again by that process. The write that ends a run drops its
  held events with its intent and marker.
- Order: a run's events apply in arrival order. While a run holds events,
  each later scheduler event of it is held behind them until the class ends
  the run, so none overtakes an earlier one. A user decision is refused
  (`run_mismatch`) while its run holds events, and while its write cannot be
  stored, as before.
- Stop: a Stop takes effect when it is given: the engine marks the run
  stopping at once, and a Stop whose event is held interrupts the run's live
  children then. So a later Stop wins over an earlier completion still held:
  the completion replays under the Stop, its stage ends `cancelled` with its
  output kept, and the run ends `cancelled` (stopped). A completion applied
  before the Stop stands, and the Stop cancels what is still open.
- Release: each permitted read, after the intents and markers, replays each
  run's held events in order while its class is `live`; under a class that
  ends the run they go with its end, and under any other class they stay
  held. Each replay is first revalidated against the run as stored: an event
  whose run is over, whose stage is not in the run, whose stage moved on to
  another attempt (retried) or out of the state the event was sent from
  (superseded), or whose join is no longer being collected, is dropped with a
  logged reason and never applied to the new attempt. A replay the class holds
  again stops the release there, the rest kept in order.
- Lost path: once the class is `live`, a stage the run file shows `running`
  with no child, none starting, no launch of the run in flight and no held
  event takes the existing lost path: it ends interrupted (failed
  `interrupted`, or `cancelled` while the run winds down), as a stage whose
  child is gone does. Each permitted read checks this after the release, so no
  stage stays running forever. A run that boot kept unadopted (its class held
  it) is taken over by a later permitted read as boot takes one over, once its
  class no longer holds it: adopted once `live` (its stage that was running
  fails `interrupted`), ended once `orphan` or `lost`, without a workspace
  sweep; a failure there is only logged.
- Restart: boot reconciles a parked run before anything else, since nothing
  starts after a restart. Of the held events read back from the run file, a
  Stop still stops its run; every other one is superseded by that reconcile
  and dropped with its reason.

## Retention and envelopes

- Retention and the workspace sweep prune only records confirmed settled; an
  unconfirmed end keeps its record and workspace.
- Every IPC mutation answers its declared envelope. `decide-stage`,
  `decide-join` and `retry-stage` refuse with `{ok: false, reason: code}`, the
  code being a store refusal code where the store refused.

## Tests

- `run-classification.test.ts`: the classifier table over every input
  combination, the marker resolution table over every marker shape and board
  fact, and what each marker shape makes the run file say of its run.
- `run-ending-structure.test.ts`: syntax checks for the settle write and
  consumers, plus runtime rejection of terminal changes through `put`, `update`
  and retention, including computed fields. Named adoption must classify every
  unsettled candidate; a row end request must pass through `settleRun`.
- `run-ending-engine-property.test.ts` (`src/work-board/workflow/__tests__`)
  drives the real engine through boot adoption, live adoption, `checkRows`
  after a board write, a run write and a reader, over every board state, with
  and without an open intent and an unknown marker, and in each failure window
  (an end write that fails, a run file that cannot be read). Its own oracle
  gives the class; it checks each end's cause and status against it, that each
  end comes through `settleRun`, and that each consumer read the class from
  `classifyRun`. Separate cases cover one-shot unreadable writes and unreadable
  or repeated individual records without manufacturing a second child event.
- The delete failure windows, marker resolution, recovery and the notice have
  targeted tests beside the write guard's: a legacy marker is held, and a
  delete from a held row or card resolves it.
- Held events have targeted engine tests: deduplication and idempotent
  replay, arrival order with a later Stop, the drop of an event whose stage
  moved on, the lost path of a running stage with no child once the class is
  `live`, the memory fallback when the run file cannot be written, a decision
  refused while its run holds events, the restart rule, and the adoption of a
  run boot kept once its class is `live`.
