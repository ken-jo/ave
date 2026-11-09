# Ave Architecture Document

Ave is a comprehensive agent browser; its goals are stated in
[docs/vision/README.md](../vision/README.md). The app is built around one
invariant: the host owns trust, storage, project identity,
and tool execution; plugins and renderer surfaces request capabilities through
explicit contracts.

## System Goals

- Keep project context first-class across chat, memory, insights, work board,
  audit, and tool permissions.
- Let the user work from a desktop app without assuming that the process launch
  directory is the project root.
- Make the default workspace project the fallback when the user has not
  explicitly selected a project.
- Route every tool call through the same permission, audit, and execution path
  regardless of whether the tool is builtin, plugin-provided, or MCP-provided.
- Keep UI extension points powerful but bounded by host-owned APIs.
- Preserve deterministic fallbacks for provider, network, or plugin failures.

## Reference Product Hierarchy

Research for host-agent behavior starts with official documentation and current
shipped behavior of comparable coding-agent host products — CLI and desktop
agent hosts whose scope matches Ave's. Those are the primary comparison set for
agent lifecycle, project handling, interaction, and desktop UX. For the browser
and terminal surfaces, the agent browsers and agent terminals named in
[docs/vision/README.md](../vision/README.md) are primary comparisons too. IDE and
workspace products are secondary references: they may inform generic editor,
filesystem, and multi-root conventions, but they do not override host-agent
evidence. Record when a conclusion is an inference rather than a documented
primary-product contract.

## Layer Map

| Layer | Scope | Primary Responsibilities |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| User and desktop shell | Electron windows, tray, titlebar, settings, dialogs | Present the app, collect consent, and keep foreground/background behavior predictable. |
| Renderer app | Chat, Insights, Projects, Work Board, plugin slots | Render state from host APIs, never bypass host policy, and keep app workflows ergonomic. |
| Preload and IPC contracts | `src/preload`, `src/ipc`, shared channel constants | Expose narrow typed APIs from the main process to renderer code. |
| Relay and ingress | Loopback local API and app contract (`src/api`), CLI (`src/cli`), MCP loopback (`src/mcp`), and the main-process transport owners that accept non-renderer requests (`local-api-server.ts`, `conversation-command-port.ts`, the platform and tailnet bridges) | Accept external-origin requests, bind each to a trusted transport actor, and reach host services only through host-owned command entrypoints and the same permission and consent chokepoints as the renderer. These transports are transport-agnostic and hold no Electron runtime import, so the same host services can run under a windowless host process. |
| Host services | conversation loop, memory manager, session store, work board, plugin runtime | Own durable state, project identity, LLM orchestration, plugin lifecycle, and execution policy. |
| Tool execution and governance | Tool registry, executor, permissions, audit, sandbox helpers | Enforce one route for builtin/plugin/MCP tool calls and record decisions. |
| External integrations | LLM providers, MCP servers, marketplace, web auth, local indexers | Connect to outside systems through host-owned adapters and explicit credentials. |

Native image requests use the active transport's count and byte limits. Request
projection and dispatch select the same image set without modifying stored
conversation rows: newly authored input and fresh tool images take priority,
then earlier images fill the remaining budget from newest to oldest. Omitted
history images leave explicit text markers. A fresh tool image that cannot fit
returns a visible delivery error to the model so it can request fewer or smaller
images; a valid tool result cannot silently terminate the conversation because
older images consumed the request budget. Authored image input must fit as a
whole, and malformed image payloads still fail at the boundary.

The [image preparation contract](image-preparation.md) owns local image
decoding, bounded source reads and derived visual copies. `view_image` accepts
smaller output budgets for delivery-error recovery while the active transport
retains ownership of request projection and attachment limits.

## Process Boundaries

Local document previews use a bounded and killable child. Admission covers reading
and parsing; separate startup and parse deadlines cover the child lifecycle.
The [table preview contract](document-previews.md#table-documents) owns request replacement,
container checks, expansion refusals and bounded display windows.
The [page preview contract](document-previews.md#page-documents) adds presentation outlines
and rendered PDF pages through that same lifecycle.
The [agent document tools](agent-document-tools.md) reuse that parser with bounded
model-context selections and policy-checked, session-bound panel requests.
The [XLSX editing contract](xlsx-skill-editing.md) keeps editing in the agent's
ordinary approved sandbox shell. The document panel is a read-only live view;
the host observes and renders, with no document publication API.

### Agent activity observation

One main-process observation daemon owns bounded, session-bound adapter
lifetimes. Its source interface is deliberately separate from its document
rendering engine. Document, browser and terminal adapters share that daemon.
User document, browser and terminal activity is outside the observation
contract. Browser events and terminal history stay in memory and create no
observation files. Document journals retain their existing private process
directories. Neither source becomes transcript content, telemetry,
remote-surface events or provider input.

The [shared schema](../../src/shared/agent-observation.ts) defines canonical
event and acknowledgement shapes; the [daemon](../../src/observation/daemon.ts)
owns delivery. [Browser control](#browser-control-and-tab-lifetime) and the
[permission policy](permission-policy-design.md#shared-browser-control-and-effects)
own command authority and its invalidation.

Every event has `source: "document" | "browser" | "terminal"`,
`actor: "agent"`, host-derived `sessionId`, `target: { id, path }`, monotonically
increasing target-local `seq`, `kind`, `before`, `after`, and `ts` (epoch
milliseconds). Document kinds are `element`, `snapshot`, and `status`.
An element names a cell by sheet name and absolute row/column, a text line
by one-based line number, a paragraph/run by zero-based indices, or a slide
shape by zero-based slide index and shape ID. It carries bounded display
strings in `before`/`after`.
Journal cells are explicitly advisory until reconciliation; native line diffs
and structured document diffs come from a verified save. A snapshot replaces
the bounded rendered table and its recalculation signal, text document, or page
document. A status carries a stable localized code without document contents.
The daemon, not a journal, engine or renderer, supplies actor, session, target
identity, sequence and timestamp.

Browser events reuse that envelope and the private observation channel. An
`action` has `before: null` and bounded metadata in `after`: action, main-issued
tab handle, optional embedded renderer slot, URL, title, and an optional element
description or download state. Browser actions cover navigation, clicks,
typing, tab open/close/switch, downloads, hover, drag, selection, scroll, upload
and supported keys. A browser session has one opaque target identity with
`target.path: "browser"` and required host-derived `target.hostSessionId`.
Document targets retain their existing shape. The hosting identity accompanies
actions and statuses so initial errors or resynchronization can reach the right
panel. The URL is metadata, never a path or authority supplied by a renderer.
Browser statuses report observation errors, delivery resynchronization or
session clearing. These are command receipts, so the
browser adapter needs no document parser or additional rendering engine.

Browser attribution starts only inside the host's model-turn context and an
already authorized tool invocation. Page effects require the exact actor's
active control lease and original live guest; authorized tab switching and
closing may refer to the agent-owned tab's durable identity. A completed close
can describe the original guest after destruction. Failed or cancelled
commands, guest replacement and recognized human takeover supply no successful
action event. Navigation metadata comes from command completion, not general
page navigation or title listeners. User page events are never an observation
source, including in the tab the agent uses. UI/plugin tool origins and
renderer-supplied session metadata cannot create agent provenance. A live
sub-agent routes delivery through its nearest hosted ancestor while events
retain the actual acting session. That validated host binding survives the end
of the child run; session end or loss of window/frame ownership releases it.
Browser live targets end with their acting model turn, even when the conversation
continues. Each new turn retires the prior browser target and its download
listeners before publishing a new target. Turn ownership is tracked independently
of renderer view subscriptions, so releasing a view cannot skip control cleanup.
The existing native input correlation limit still applies: a human click
indistinguishable from an armed agent click cannot
be separately identified. Observation does not strengthen that source proof.

The browser observer retains no typed or selected values, supported-key
operands, cookies, browser storage, arbitrary page text, snapshots or
screenshots. The live preview below is transient display, not retention. Permitted page metadata is limited to the title and bounded
role/name fields from references already available to the agent; it authorizes
no other page-content extraction.
Typing targets omit names as well as values, and credential
field descriptions are redacted. URL metadata omits embedded credentials, query strings
and fragments before entering delivery or retention buffers. Observation
does not copy ordinary browser history or download destinations.

Download admission uses the existing native Save-admitted callback and only an
active command receipt for the exact guest, actor and current control lease.
Recognized takeover, caller cancellation and unrelated guests cannot supply
that receipt. The item's URL chain must also match the approved navigation URL
or resolved clicked-link destination from that command. This expected URL is
ephemeral attribution evidence, not retained event data. Click-initiated
downloads also require the native item's user-gesture flag; explicit navigation
and tab opening need no such flag. Unproved button or script downloads and
downloads arriving after the command are excluded. Only state transitions are
retained: started, completed, cancelled or interrupted.
Filenames, destination paths and file contents are omitted. The original
admitted item may complete after the command. Completion listeners end with
the item, acting model turn, session, owning frame/window or observation runtime. Listener-capacity
overload emits resynchronization without interrupting the native download or
throwing through its Save callback. Observation adds no download approval or
automatic open behavior.

A single window-level layer shows one floating card for each agent-used hidden
browser tab, with its title, child title when available, and activity strip.
The picture uses a fixed 16:9 thumbnail box, about 240×135px, and crops the frame
to its top-left with object-fit cover. Its live badge sits inside the picture.
Below 480px window width the card becomes a favicon/title chip. The padded,
inset bottom-right stack occupies no layout space, reserves visible composer,
approval and question surfaces, and sits below decisions in the canvas stacking
context. Its bounds come from the visible pane body below the actual pane
header and end above measured composer, approval and question rectangles; no
header-height estimate is used. Dragging stays in those measured bounds. The
stack never scrolls: newest tabs retain full pictures, older tabs collapse into
chips, and a +N chip opens the first hidden tab if individual chips cannot fit.
Only full pictures subscribe to live frames.
Click or Enter opens the
original tab through workspace routing, including a retained surface without
an assigned pane; a closed tab does nothing. Delete or × dismisses the card
for its host-issued acting-turn observation binding. Same-turn actions keep it
hidden; actual tab activation or a subsequent turn's first use re-arms it.
Position and dismissal are memory-only; the composer has no browser preview row.
Browser panes hidden by the
group layout and conversation tabs in a closed panel or behind another panel
tab qualify; merely unfocused visible panes do not. It is bound
to the exact main-issued tab handle and observation target of the latest agent
action for that renderer tab, and never falls back to another tab. Main admits
only a tab that the acting session leases or owns, or whose owner's direct
parent it is (the same ownership rule that admits tab switch and close events; a
grandparent or sibling session is refused), that is not paused by the user, and
on which that session ran a command within the last 30 seconds. Recognized user
input, address-bar navigation and Stop pause an agent-owned tab; the agent's own
cross-origin navigation does not. User takeover, user navigation, idleness,
model-turn completion/interruption/error, session end and window or frame loss stop it. It reuses the guest's existing in-
process debugger session through Chromium's screencast: it never attaches a
debugger and opens no remote debugging port. Frames are JPEG, at most 640x400,
including the first compositor frame of a static page, and at most four forwarded per second with one
unrendered frame in flight. Main acknowledges every Chromium frame on receipt,
independently of renderer delivery. The screencast is re-armed on each main-
frame commit and after two seconds without a frame while Chromium reports the
page visible; a hidden page is not re-armed until it is visible again. Only a
frame within 1.5 seconds of a commit is decoded: a uniform one keeps the
previous frame, marked as updating; later uniform frames render. A forwarded
frame the renderer never reports painted stops blocking delivery after two
seconds. Closing the page session rejects pending preview commands, including a
stop in progress, at once with a closed error. A transient empty URL during a
cross-site commit is not a close. Frames use a separate private push channel
beside the observation stream and never enter the daemon, its queues, event
history, transcripts or files. The renderer keeps only the newest frame for a
preview element while that element is shown, intersecting both the window and
its clipping ancestors. Losing that visibility stops the screencast, drops its
frame and releases hidden-guest painting. A mounted panel that is hidden, has
no size, is outside the viewport or sits in a hidden document stops the preview
and drops its frame. Only while an agent-driven picture is shown,
its hidden guest keeps painting with zero opacity, clipping, no pointer events,
and aria-hidden and inert attributes. Otherwise hidden guests use visibility
hidden. Revealing the pane or ending observation restores the normal
attributes. The agent's typing tools already refuse password, card and one-time
code fields, so the preview adds no secret-input display path.

The document adapter starts an exact target, accepts a rendered snapshot and
agent mutation evidence, reconciles a settled save, and disposes all watches,
timers and pending work. A replaceable `DocumentObservationEngine` accepts
already admitted bytes, a format and selection index, and a host-derived session
context. It returns a bounded table, text or page document under cancellation
and releases its session-owned resources when observation ends. The optional
[document conversion engine](document-observation-engine.md) renders page
documents and recalculates temporary workbook copies. Its installation,
verification, offline confinement and warm session queue are separate from
source attribution and the event transport. Engine absence deterministically
selects the existing bounded readers; a format needing the engine reports
`engine-unavailable`. Parse, integrity, confinement and contract errors remain
errors rather than selecting that fallback. Text decoding retains the existing
UTF-8 preview's 2,000,000-byte and 5,000-line ceilings and rejects binary content.

Full default text/code reads can bind observation through the same private
preview read contract and rendered acknowledgement as tables. Selected line
windows, inline snippets and images retain ordinary viewing without observation.
The initial content and digest come from the same admitted bytes. Page documents
use the same admission and acknowledgement path; paragraph/run and slide-shape
diffs come from bounded structured representations of verified before/after
bytes. Rendering a page does not itself create an activity event.
Observed text reads retain only the newest request owner for each actual frame
and canonical path. A late replaced read cannot register or release the newer
view. There are at most 16 current request-owner keys; cancellation still waits
for a filesystem operation already in progress to return.

Scope comes from successful agent `open_document` acknowledgements, bound to
their existing live session/window/main-frame receipt, and exact native
mutation targets known in the current agent turn. Successful native mutations
retain at most 16 exact target identities until that turn ends, even when a
view has not opened yet. No contents are captured for that admission metadata;
watching starts only once a same-session view supplies a rendered baseline.
Turn completion removes this temporary scope, while agent-opened panels retain
their own view lifetime. An ordinary user preview is
only a rendered baseline: it creates no filesystem watch. If an authorized
agent later changes that exact file, it can become an observed target. There
is no workspace enumeration or recursive watch. Target admission requires a
host model-turn context and a successfully authorized tool invocation;
renderer metadata and UI/plugin tool origins cannot create that context.
Watching a parent directory only filters the exact basename so replacement
renames remain observable; it never reads sibling contents.

For an agent document open, the existing tab-selection receipt and a host-accepted
initial rendered-view acknowledgement must both arrive before `open_document`
completes. Either may arrive first; a still-live matching rendered baseline can
satisfy readiness immediately. The original document-open deadline, frame,
session and cancellation guards remain in force. This prevents an immediate
following edit from outrunning baseline admission. Pending agent-open marks
without a parsed view expire within the existing reader startup, parse and busy
retry budgets. Files without a rendered baseline are never watched or read by
the observer merely because a tool named them.

Optional engine preparation verifies the installed payload and starts its
session runtime through the bounded conversion queue under the tool's
cancellation signal. The session instance's readiness probe and required importer
registration complete before the panel request's acknowledgement window starts. Preparation
reads no source document bytes and creates no observation target or filesystem
watch. Native conversion and the existing bounded output reader retain their
own cancellable process budgets.

Filesystem notifications are wakeups, not writer identity. Native mutations
provide their exact intended post-image; the skill provides a tool-bound
journal completion digest. A displayed agent delta requires a matching
pre-image digest rooted in the last acknowledged rendered snapshot and a
matching stable post-image. Consecutive admitted mutations may extend an
unbroken before/after digest chain while a prior snapshot awaits rendering;
they do not advance the rendered comparison baseline. Any gap in that chain
requires reload. Mere temporal overlap with an agent tool is insufficient.
Unattributed or conflicting saves must not be recorded as agent changes.
The adapter debounces notifications for 80 ms, requires two equal descriptor
size/mtime observations 40 ms apart, retries a transient rename for at most
eight settle attempts, and computes the element diff against the last
acknowledged rendered snapshot. A prior user save therefore cannot be folded
into an attributed agent delta.

An agent shell's existing isolated sandbox HOME is its action directory.
`AVE_DOCUMENT_JOURNAL` names only the host-selected
`<HOME>/document-observation/journal.jsonl`; host registration binds this
directory to one admitted tool call, turn and session. The skill appends UTF-8
JSON Lines with version `1`: `begin` has `editId`, canonical `target`, and
`beforeHash`; `cell` has `editId`, `sheet`, A1 `cell`, `before`, and `after`;
`commit` has `editId` and `afterHash`. Hashes are lowercase SHA-256 hex.
The same `begin`/`commit` pair can reconcile an admitted table or page target;
provisional `cell` records apply only to table views. Page paragraph/run and
shape changes come from the verified saved package, never from journal text.
The journal is capped at 2 MiB per invocation, 16 KiB per line, 500 cell
records per edit, and 2,000 display characters per value. The reader reads at
most 64 KiB per poll, retains an incomplete final line until its newline,
and refuses truncation, replacement, links, malformed records and paths
outside the registered action directory. A journal target can match only a
host-known target or an already rendered exact file in that same session;
it creates no general file-read authority.

Journal cells are provisional display data. They never supply document bytes
to the host or authorize a write. A verified save discards the provisional
overlay and renders the actual parsed file, including when journal cell text
disagrees. Failed, cancelled or unverifiable edits clear overlays and require
a reload rather than keeping a draft as file truth. The skill retains its
existing size ceiling, refusal rules, backup and atomic replacement; the host
has no edit IPC, staging publisher, workbook transaction or write token.

Each daemon has at most 16 active targets across document views, browser
sessions and terminal subscriptions, 256 queued events and 1 MiB of queued
metadata per target. A document open at that shared limit answers `busy` and
leaves no view owner behind. It sends
batches of at most 32 events with at most 64 unacknowledged events per target.
Repeated pending document elements coalesce by address; document overload produces a
resynchronization status and a fresh verified snapshot, never an unbounded
replay. Snapshot payloads retain the existing 4 MiB preview cap. Browser
metadata is bounded to 2,048 characters per URL and
256 characters per display string. The browser renderer retains at most 64
events per session to support the current strip, within the same 16-session
limit. This adds no activity-history interface. Delivery overload reports
resynchronization instead of replaying an unbounded history. Browser events
are acknowledged after bounded local consumption and need no document
baseline. Document renderer acknowledgements advance the rendered baseline
only for the matching snapshot sequence; a delivered snapshot is not assumed
rendered. Releasing a view, changing its session, navigating or destroying
its frame, closing or hiding the panel, ending a journal invocation or
shutting down disposes the corresponding capabilities and bounded buffers. A
closed or hidden panel may stay mounted for a retained side chat or browser
tab; its document views keep their sheet, scroll and page position but hold no
subscription, and showing the panel again reads a fresh baseline. No
observation survives a host restart. Ending or clearing a browser session
releases its receipt, download listeners and delivery buffers and clears its
renderer history through a content-free, daemon-sequenced terminal status.
Clear-delivery failure still releases all host buffers and listeners;
session-end and shutdown cleanup report collected failures as an
`AggregateError`. Ending a root conversation also clears its descendants
through the existing session-permission lifetime boundary. Browser
observations stay only in memory; they are not persisted with ordinary browser
bookmarks or history.

The terminal adapter admits shell-tool runs and individual commands in the
conversation-owned isolated PTY only from the host's authorized model-turn invocation
context. Tool arguments, renderer metadata, internal terminal identity and shell markers
cannot create that authority. Terminal admission binds the approved command,
verified directory, session incarnation and exact authenticated command block
immediately before the host presses Enter. Startup, prompts and user commands
are never observed, including commands a user types into an isolated PTY. Any
accepted user input revokes that command's capture and egress binding before
the bytes reach the shell; pending output is discarded. A mismatched command
or directory is a contract error, not a reason to observe another block.
User output must never enter an agent block, so admission has two further
conditions. First, the operating system must show the shell alone on its
terminal before Enter: no child, and no other process with that terminal as
its own, such as an orphaned background job whose parent exited. On macOS the
last check before Enter also refuses any other process holding the terminal
device open, such as one that left the session with `setsid`. The sandboxed
Linux shell is checked through its sandbox process tree and terminal session.
That tree check already refuses an orphan, because the sandbox's init must have
exactly one child. As a second check, the last check before Enter refuses any
other sandbox process that holds the shell's terminal open, matched by device
identity through `/proc/<pid>/fd`. The exempt processes are the shell's own,
identified by their place in the verified chain: the launcher chain from the
spawned process, the outer launcher's bridges, the pty relay and the shell.
Exemption is by pid, so after the scan each exempt pid must still name the
process the snapshot found (same start time, parent and program); a reused or
vanished pid refuses. Any other process with an unreadable descriptor table
also refuses.
Otherwise `terminal_run` refuses with `shell-busy` and nothing is typed.
Every write that reaches the terminal from its view counts as user input.
The one exemption is a write that is exactly one emulator reply to a query
the terminal's own programs sent in their output: device attributes, status,
cursor position, mode reports, colour queries, and focus reports while focus
reporting is on. The reply must match its exact form, answer one outstanding
query, and arrive within 2 seconds of that query, as its own write (xterm.js
sends each reply separately). At most 16 queries are outstanding. A reply shape
alone proves nothing, because the user can type or paste one, and the line
editor runs any keys inside it; a late, unsolicited or batched reply therefore
counts as user input.
Second, once the user has typed into an isolated terminal incarnation, a
process they started may have left the terminal while keeping its egress
credentials, or may later reopen the terminal by path; no process-table
reading can rule that out. Later agent commands in that incarnation are
admitted with `outputAvailability: "withheld-user-input"`. Their entries keep
the command, directory, exit state and duration. They capture no output and
bind no egress. The panel states why.

Terminal events use the same envelope with `source: "terminal"`. A `snapshot`
replaces the session's bounded `commands` list; `status` carries
`observation-error` or `resync-required`. Each command includes its host-issued
identity, turn/tool identity, command line, directory, start time, duration,
running/completed/failed/cancelled/interrupted state, known exit code or `null`,
bounded output tail and truncation flag, chosen sandbox mode and egress
decisions. Terminal commands also carry an internal terminal identity and session incarnation;
for isolated PTYs this identity is not a workspace tab binding.
Commands, directories, output and decision details pass through the existing
credential-redaction rules before retention or delivery. Split output cannot
bypass masking; raw pending fragments are bounded independently of the
redacted display tail. Internal observation contract failures remain visible.
The shared shapes and limits live in
[`agent-observation.ts`](../../src/shared/agent-observation.ts). A terminal
target identifies one conversation's read-only subscription; its `path` is the
non-filesystem label `terminal-activity`. Snapshots and statuses have `before: null`.
Output removes control-string payloads and applies bounded current-line carriage
return and backspace rewrites before masking. Broker-side omissions also set the
truncation flag, even when the supplied suffix fits the local tail.

`TERMINAL_OBSERVATION_LIMITS` bounds retention to 16 sessions, 32 commands per
session, 4,096 output characters and 16 decisions per command, with at most
8,192 pending output characters and an 80 ms delivery coalescing interval.
Completed history is evicted before active work; exhausted active capacity
fails explicitly. A lease may follow its already admitted child or terminal
block beyond the initial tool wait or turn, but cannot admit another command.
Completion follows the actual process or authenticated block exit, not the
tool's foreground-to-background handoff. Replacing an isolated terminal,
ending its owning conversation or shutting down releases the corresponding leases
and buffers. There is no persisted terminal observation history.
Releasing a panel revokes delivery and its queued snapshots; bounded same-session
command history remains available on reopening until eviction or conversation
deletion. User-input revocation leaves an `interrupted` entry containing only
previously redacted output, with an unknown exit code and no later updates.

Shell egress decisions bind the private invocation token to that command.
A terminal token belongs to its whole shell, including earlier background
descendants: decisions captured during an admitted command are explicitly
marked `terminal-session`, not claimed as per-process command causation.
User-input revocation removes that binding before human activity can be
captured, and a terminal token is never bound for an incarnation that has
received user input. The brokered shell transport currently supplies output only on
completion or an existing task read; its commands declare
`outputAvailability: "on-completion"`. Observation neither invents a live
stream nor adds polling that consumes the task's read cursor.
A checked shell execution whose result is released only after repository
revalidation keeps the same quarantine in observation. Its command is admitted
as `on-completion` with held output: output is masked and bounded but enters
no snapshot until the validated result is released. A refused result discards
it, and the entry keeps only command metadata and exit state.

Private observation push and acknowledgement IPC require the same registered
app-window main-frame identity as preview reads: a live registered window,
its actual main frame and default session, rechecked at delivery. Webviews,
plugin partitions, subframes and unregistered contents are refused regardless
of URL. The existing acknowledgement channel also accepts
`{ action: "subscribe-terminal", sessionId }`, checked against the caller's
current conversation/window binding. It returns a host-issued read-only target
identity; the initial and subsequent snapshots use the existing observation
push channel. Rendered/release acknowledgements name that identity, session
and sequence. Renderers ignore older sequences for that target/session;
acknowledgements cannot exceed the latest sequence actually delivered by the
daemon, and repeated older acknowledgements do not move its baseline backward.
No request accepts a document path, script or write payload.
The panel offers no edit affordance or save action. Agent editing retains
the ordinary tool approval path; observation grants no permission and prompts
for no user modification confirmation. Observation adds no confirmation to
any user action.

File/code, table and page viewers share one compact header: format icon, bold
basename, muted monospaced parent path and right-aligned icon-only actions.
The displayed path is workspace-relative when available, otherwise compacted;
it truncates with ellipsis while its title exposes the complete path. Open in
the default application, copy and applicable reload actions have localized
accessible labels. There is no separate path box, file-kind badge or source row.

A single live strip beneath the relevant viewer chrome appears only for
authenticated agent observation activity or its error/resynchronization state.
For documents it reports editing or edited, the latest element change summary
and recency. The current
element has an outline and a small Ave tag; earlier changes retain a faint tint.
These marks use one theme color with light and dark variants. A compact footer
owns format, selected sheet/page or line count, recalculation status and
truncation notices. Idle user-only previews have no live strip. Localized
observation errors occupy that same slot rather than creating additional status rows.
Browser panels use the same compact activity treatment for the latest agent
action, safe URL, element description or download state and recency. User-only
browsing has no observation strip. Closing or switching tabs is an agent event
only when the admitted agent command performs it; user chrome does not emit
activity.
Browser control state and Stop/Resume stay in a persistent toolbar of fixed
height. A compact observation slot of fixed height is reserved from mount and
remains transparent until authenticated activity or errors render the strip.
Control changes and the first observation keep the guest viewport in place
during native input; user-only previews show no agent label or stripe.

Conversation-owned isolated commands render inline with command, directory,
status, known exit code and collapsible bounded output, using an isolated badge
and color band. They reuse the existing authenticated session observation
subscription and rendering contract; there is no separate isolated side-work
surface. Hidden/unmounted conversation views release their subscriptions without
ending the conversation's PTY. Reopening subscribes afresh to bounded same-session
history. Current target/session and sequence checks reject stale events;
observation errors remain visible. Host shells are excluded from this subscription,
including startup, user commands and scrollback. Explicit user-selected host block
attachments are a separate untrusted-context path defined by the
[terminal policy](permission-policy-design.md#commands-typed-into-a-workspace-terminal).

Every open in the OS default application runs one sequence,
`openVerifiedExternalFile` in `src/main/external-open-target.ts`. It walks the
link chain with lstat and readlink only, refusing UNC and device hops before
any realpath. It also refuses a link target with a `..` segment, because the OS
resolves that against physical parents. It then resolves the target, applies the
sensitive-path floor and the allowed-extension list
(`src/shared/preview-external-open.ts`) to both the requested name and the
target, and requires a regular file with no POSIX execute bit. The whole
judgement runs again on a fresh resolution immediately before the open, so the
file that is opened is the one every check judged. Each caller adds only its
own authority:

- `attach.openExternal` serves both the attachment picker or drop path, which
  uses its picker allowlist, and the preview's default-application icon, which
  uses bounded, frame-bound read receipts from successful preview reads that add
  no paths to the attachment allowlist. Both now meet the same allowed-extension
  and execute-bit refusals;
- the folder view's `workspace.openPath` uses project containment: the target
  must lie inside the registered project root it names. It refuses a path with a
  `.` or `..` segment (`invalid-request`) before any lstat or realpath, so the
  checks and the open cannot resolve different files.

Every caller requires the registered main-frame identity, checked again before
the open. The folder view's open also requires a user gesture
(`user-keyboard-required` otherwise). This is a user action: it emits
no agent observation and grants no document write authority.

`folder` is an instance view and a main-surface kind. A folder surface belongs
to one project, is saved in the v2 main layout with its folder and selection,
and is neither an agent tool surface nor movable to a side panel. Its listing
(`workspace.listDir`) hides sensitive entries, links included, and counts them.
It never resolves through a link: a link is outside when its target is a network
or device path, has a `..` segment, leaves the root as spelled (compared without
NFC folding), or passes through another link.

### Host runtime and subprocesses

Host service bootstrap accepts `BootHost` (`src/boot/host-runtime.ts`) for
user-data and resource paths, packaged mode, encryption, network fetches, and
shutdown. Desktop capabilities are optional and required explicitly by
operations that present UI.

The native entrypoint, `src/headless.ts`, runs under standalone Node; its emitted
dependency graph excludes desktop runtime imports. `--exec` and `--set-secret`
construct the ordinary host service graph without a window or renderer; `--serve` keeps
that host available through the authenticated Local API and any explicitly
configured Tailnet surface. Desktop event bridges have no subscription when
their surface is absent. Approval availability is a host capability separate
from the routine `headless` tool-scope flag. A native `--exec` turn carries a
host-issued unattended turn authority that selects the routine policy lane for
that turn alone, so its asks settle as reviewer decisions or structured denials
the model sees; a turn without that authority that still needs explicit consent
ends once with a host-issued `authorization-required` result instead of feeding
a denial back to the model; UI-only HostApi calls fail before consuming proposal
state. The
[native host guide](../guides/native-server.md) owns launcher, profile, key-file,
and Linux artifact instructions.

`createWindowlessHost` owns one service graph, `ConversationSurfaceRuntime`, and
`ConversationCommandPort`. Attached clients share the active main conversation,
command arbitration, and ordered event source. Each transport retains its actor,
authorization, and projection boundary; attaching clients does not create
independent concurrent conversation loops. Configured Tailnet surfaces,
including Web, support bounded canonical replay in memory; Local API event
streams remain live-only. The
[surface protocol](multisurface-conversation-runtime.md) owns these contracts.

The desktop still embeds its own host runtime. Its UI has not been converted
into a detached client of `--serve`; desktop shutdown or fatal host-process
failure ends that embedded runtime. A separately launched native host has its
own process lifetime. Shared command and event contracts do not provide desktop
reattachment or survival of a fatal desktop process failure.

Foreground shell execution shares the output collector, timeout input schema,
and deadline/cancellation owner in `src/tools/shell-tools.ts`. Timer conversion
is owned by `resolveShellTimeoutMs` in `src/shared/tool-timeout-policy.ts`, which
the executor ceiling also references. Cancellation terminates the managed child
tree. An interrupted foreground call settles after requesting that termination
and releasing its output pipe ends, even if a descendant keeps an inherited
pipe open. Ordinary completion still drains stdout and stderr through closure;
sandbox cleanup waits for confirmed root termination. Output display keeps a
bounded prefix. Foreground capture also retains the original stdout/stderr bytes
in observed event order in a session artifact owned by `MemoryManager`.

The native headless workload-broker route keeps the Ave controller, encrypted
provider secret and controller logs on the host. At boot, the host binds an
owner-only Unix socket and capability file to one exact running Docker `main`
container. While that route is active, builtin Bash and the canonical file tools
can reach the task only through the broker; transport, binding, expiry and grant
failures never select a local shell or filesystem path. Normal authorization,
reviewer and audit processing still run before the host issues a one-shot grant.
The broker owns Docker identity revalidation, operation deadlines,
cancellation, cgroup-v2 OOM evidence and terminal cleanup receipts. The
[permission policy](permission-policy-design.md#host-native-workload-broker)
defines the full route and lifecycle contract.

Each foreground capture artifact is limited to 5,000,000 bytes. Retained captures
plus active reservations are limited to 20,000,000 bytes per session. Capture
reserves the full artifact allowance before it starts and releases unused
reservation when it settles; retained files count after reload, so concurrent
captures within the host process cannot overbook the session. Separate processes
concurrently writing the same session are outside this ownership contract.
Small outputs remain in the existing preview without reserving an artifact.

Pending disk buffers are bounded at 262,144 bytes (256 KiB). Backpressure pauses
both child streams until the queue drains. A single excessive chunk, quota
exhaustion, storage failure, or interruption produces an explicit `partial` or
`unavailable` capture; the command pipes continue draining when capture cannot
continue. A capture becomes `complete` only after accepted writes and metadata
publication finish. Partial captures expose only retained content; unavailable
captures have no recoverable artifact. Capture status does not replace the shell
exit code, signal, timeout, cancellation, or process cleanup result.

The host derives private artifact locations from validated session/tool identity
and an opaque capture ID. Reads validate ownership, metadata, and content hashes;
symlink traversal is rejected. Transcript saves retain capture references from
current messages and checkpoints and remove only verified, unreferenced captures.
In-flight captures remain reserved; published captures remain pinned until a
session or checkpoint save commits their reference or their invocation abandons
ownership.
The executor abandons undelivered results and the turn releases captures absent
from its final history. New capture admission sweeps verified orphan artifacts
against persisted session/checkpoint references, including after restart.
Unverifiable orphan payloads remain charged to the quota instead of being deleted.
Artifacts preserve whitespace and CRLF even though the display formatter
normalizes them. Recovery decodes the stored bytes as UTF-8 text and omits an
incomplete trailing code point from a partial capture.

Child environment filtering stays in
[`safe-env.ts`](../../src/tools/safe-env.ts). Plain host shells additionally
retain the operator's configured proxy and bypass settings. Sandbox children
keep the generic filtered baseline and receive proxy changes only from their
wrapper. Background incremental output and structured parser output have
separate contracts.

The shared [shell environment description](../../src/shared/shell-execution-environment.ts)
derives host location, HOME, authentication and OS identity from the execution
plan for the prompt and approval UI. The
[explicit host execution contract](permission-policy-design.md#shell-execution-and-explicit-host-approval)
requires a fresh local desktop approval for foreground `executionMode: "host"`
requests. [Saved-session read policy](permission-policy-design.md#saved-session-reads)
separately admits the configured primary conversation store without granting
writes or access to other protected namespaces.

The Bash tool resolves the same Bash dialect for foreground, background, and
sandbox execution through `src/lib/shell-resolver.ts`; discovery probes use the
generic filtered child environment. Background handles belong to a session and
retain bounded incremental output. The command panel and Ctrl+B can transfer an
eligible running, unsandboxed POSIX shell without executing it again. Its original
deadline and session cleanup remain in force. Sandbox, explicit host-approval,
broker foreground and Windows execution cannot transfer through this path.
Panel actions bind the expected session and window; output snapshots show a bounded
preview without advancing the model's output cursor.
`bash_output.waitMs` is an integer from 0 to
30,000 ms, default 0. Its default `waitFor: "output"` returns on unread/new output
or completion. Opt-in `waitFor: "completion"` keeps waiting through progress
output until the shell ends or that same wait expires. Both return accumulated
unread output and current status, preserve the output cap and session ownership,
and cancel without consuming unread output. Waiting does not extend any command,
tool, or turn deadline; expiry can return a still-running shell. POSIX background
commands own process groups; Windows background commands use the native job
launcher described in `native/windows-job/README.md`. Session disposal and root
exit release those owned descendants. The native job is a lifecycle mechanism,
not a security sandbox.

Shell interpretation starts in [shell-parser.ts](../../src/shared/shell-parser.ts),
which initializes the packaged grammar before synchronous policy consumers are
available. [shell-analysis.ts](../../src/shared/shell-analysis.ts) lowers its
typed syntax into statements, word parts, redirect ownership and original byte
spans. Active continuations and quoted data are distinguished by the grammar's
lexical reader; the executed command bytes are never normalized. The tokenizer
is a conservative risk projection of this same analysis, not another parser or
a source of path authority. Parse, runtime and unsupported-syntax failures do
not return partial permission evidence. The [grammar build contract](../../tools/shell-parser/README.md)
owns pinned inputs, patch removal conditions, resource bounds and retained
runtime memory. There is no command or analysis-result cache.

[shell-execution.ts](../../src/shared/shell-execution.ts) propagates cwd,
bindings and exit-status possibilities through actual statement scopes. Loop
conditions contribute their final state; unknown outcomes retain every possible
branch. Subshells isolate bindings and cwd, while potential filesystem changes
remain shared. Path operands are resolved at their point of use, preserving
literal dollars, percent signs and symlink traversal before parent components.
Patterns, program text and output data have explicit argument roles; unknown
values cannot authorize paths. Pure data arithmetic and default/alternate
parameter values retain their separate value and effect contracts. Heredoc
substitutions are inspected where expansion occurs, and input remains attached
to its actual consumer. A pipe consumed as shell code is explicitly unresolved.
These rules do not validate the internal behavior of another programming
language or relax traversal, sensitive-path, approval or sandbox gates.

Compound output redirects retain their own statement scope: targets are checked
before the body, and failed opens preserve the incoming state. Function redirects
are checked at invocation. Inherited compound input and dynamic descriptors remain
unsupported. Quoted command substitutions prove a single argument, not its value;
nested effects still require inspection. Double-bracket integer comparisons require
proven integer operands because other strings can trigger arithmetic expansions.

[prepared-shell-invocation.ts](../../src/tools/prepared-shell-invocation.ts)
issues a private host handle after the final command and execution plan are
known. It captures the interpreter, immutable argv, cwd, filtered environment
and observed interpreter capabilities once. Policy and native execution use
those same facts, including every public command-bearing input field. For
sandbox execution an inner launcher passes the original command as one `-c`
argument and fixes the prepared environment after wrapper setup. Its HOME and
temporary directory belong to that invocation; this replaces the shared
temporary directory for the inner command without enlarging allowed roots.
Final grants materialize the wrapper without recapturing environment facts.
After command policy accepts the source, its executable lookups are resolved
through the same typed execution analysis and bound to the prepared invocation
before approval. Only precise, non-sensitive executable files from a provable
captured search path receive read access. The wrapper consumes those frozen
paths; it never grants a whole search directory or the real home directory.
This supports runtimes installed beneath the user home without adding write or
network permissions. Runtime dependency directories and private configuration
are not inferred from the executable's location.
One synchronous claim precedes wrapper or spawn effects. A denied preparation
is released, pending wrapper work retains ownership until settlement, and a
spawned child's resources remain until confirmed termination even if the tool
result settles earlier. Background execution retains its existing plan limits
and session cleanup owner.

PowerShell uses [native AST facts](../../src/tools/powershell-ast.ts), not Bash
interpretation. Its literal arguments, parameters and redirects remain distinct.
Function definitions and .NET method invocation are explicitly unsupported:
the previous command-only summary omitted their execution effects. This is a
public compatibility restriction, not a claim that the native shell rejects
them. Supported cmdlet output, exit, timeout and cleanup remain covered through
the public tool in [shell-tools.test.ts](../../src/tools/__tests__/shell-tools.test.ts);
native process stress has a separate lifecycle test boundary. The
[permission contract](permission-policy-design.md) records other explicit
analysis limits and their regression owners.

Text file reads and previews share `readTextFileWindow` in
`src/tools/file-read-core.ts`. Its `content` preserves the source separators
between selected lines and omits the final selected line's separator, so a
returned fragment can be used by the exact edit and patch tools. Both consumers
use that content directly. Logical line offsets, limits, counts and truncation
remain independent of line-ending style; reads stream the file and release the
stream when the requested window is complete. Edits preserve exact matching and
use replacement text as supplied without implicit newline conversion.

External controllers can explicitly retain a headless session after its turn
for later use of its background services. The caller owns eventual release;
normal shutdown still cleans the session and descendants. The
[CLI lifecycle contract](multisurface-conversation-runtime.md) owns the flags,
completion record and signal semantics.

The renderer is a presentation surface. It does not read arbitrary files, mutate
settings directly, or execute tools. It calls preload APIs, which map to IPC
handlers in the main process. The main process validates arguments, resolves
current project context, and dispatches to host services.

Plugin UI code runs inside host-created shells. The host resolves plugin asset
URLs, applies theme tokens, and passes a bridge. Plugin code can request host
operations only through declared capabilities and HostApi methods.

A preload that runs in a sandboxed frame can require only `electron` (with its
`electron/renderer` and `electron/common` subpaths), and since Electron 45 it
runs without `Buffer`, `setImmediate` and `clearImmediate`. The sandboxed frames
are the floating dock window and plugin and MCP app webviews. Anything such a
preload would resolve from disk, such as the dock's plugin shell and preload
URLs, is resolved by main and passed as window arguments. Each preload's file
and sandbox mode come from one table, `src/shared/preload-bundles.json`: windows
spread `preloadPreferences(id)`, sessions register `preloadBundlePath(id)`, and
webpack builds a preload config per row. `test/scripts/preload-sites.test.ts`
reads `src` with the TypeScript compiler. It finds windows by their resolved
Electron type and follows electron through imports, `require` and awaited
dynamic imports. It holds these sites to the table: window `webPreferences`,
`registerPreloadScript`, guest `sandbox` assignments, and `<webview>`s created
in JSX, `createElement`, `document.createElement` with `setAttribute`, HTML
string literals and the HTML sinks `innerHTML`, `outerHTML`,
`insertAdjacentHTML`, `document.write`, `parseFromString`,
`createContextualFragment`, `setHTMLUnsafe` and `dangerouslySetInnerHTML`. In
those sites it refuses what it cannot read: computed keys, spreads whose type
may carry `webPreferences`, non-literal options or `webpreferences` requests, a
window class used as a value, subclassed or passed to `Reflect.construct`, a
dynamic import of electron that is not awaited into a binding, and HTML with an
interpolated tag name or an interpolation that could carry markup. Code that
reaches Electron outside these forms is not checked; the attach guards in main
are what enforce a guest's preferences. Each window that hosts `<webview>`s sets
its guests' preferences in main: the main window routes MCP app and
side-browser partitions to their guards (`configureMainWindowWebviewAttach`) and
refuses any other partition. The `build` composite's `check-sandboxed-preloads`
fails when webpack builds a preload the table does not classify, or when a row
has no webpack config or asset copy behind it. It then checks the built file of
each table row: a sandboxed one may require only the modules above, may name
none of the removed globals, and may have no chunks. It does not scan `dist/src`
for other files.

Every surface that copies theme values follows the theme the host renderer has
applied, including a theme updated in place under the same id. Extension views
receive standard MCP Apps host-context updates, including theme, locale and
`styles.variables`; there is no parallel plugin view theme bridge. Main sends
the floating dock's host chrome a `{ theme, terminalFontFamily }` snapshot on
mount and forwards theme and terminal font changes on `ave:dock:theme`. MCP app views build their host context
from the theme already written to `:root` (`appliedTheme` / `appliedRevision`),
so an app never receives one theme's shell with another theme's tokens. An open
HTML preview is a snapshot: it keeps the theme it was created with, and the next
preview uses the current theme. Its LLM HTML runs in an opaque-origin sandboxed
`iframe srcdoc`, often with scripts disabled. The host cannot restyle that document
by setting variables on the frame or by reaching into it. Live updates would need
a message receiver inside the document, which the scripts-disabled path cannot
run. Reloading the preview would discard the document's state.

MCP servers are treated as external tool providers. Their tools are normalized
into the same registry and are subject to the same permission and audit
requirements as other tools.

The relay and ingress layer serves surfaces other than the renderer: the
loopback local API, the CLI over that API, the MCP loopback, and the paired
platform and tailnet bridges. Each surface binds to a trusted transport actor
and reaches host services only through host-owned command entrypoints; it does
not carry its own project resolution, policy path, or consent surface. These
transports are transport-agnostic and free of Electron runtime imports, which is
what lets the same host services run under a windowless host process rather than
only inside the Electron boot. Consent for an external-origin mutating request
is still resolved at the single `ApprovalGate` chokepoint; when no consent
surface can present the request, the gate denies it for that call. This section
records only the boundary the rest of the host depends on.

## Project Identity

Project identity is not inferred from `process.cwd()`. Ave is a desktop app,
so project scope comes from host-owned app state:

- selected project in the sidebar or project header;
- default workspace project when no explicit project is selected;
- normalized session metadata (`projectRoot`, `projectName`) for persisted
  conversations and insights;
- per-project memory, work-board reports, and token usage aggregation.

The canonical, normalized absolute path is the project identity. A basename is
display text only and must never be used to merge, remove, authorize, or recover
a root. Canonically equal paths deduplicate; different paths with the same
basename remain different projects. Their labels are disambiguated with parent
path context, expanding only as far as necessary to make each label clear. There
is no same-name fallback when a path is absent or stale.

Workspace roots follow one host-owned lifecycle:

1. Validate persisted roots at startup and again before runtime use. A confirmed
   missing path, `ENOTDIR`, or an existing non-directory is pruned. A transient
   access, device, network, or I/O failure is retained and audited for a later
   retry; uncertainty is not treated as deletion.
2. Add or re-add a root only after main-process validation confirms an existing
   directory and the permission store accepts its canonical path. A duplicate
   basename is allowed; a duplicate canonical path is not added twice.
3. Workspace-root lifecycle operations are serialized globally, including
   overlapping parent and descendant roots, so add, remove, and reconciliation
   cannot cross persisted snapshots. Removal shrinks both persistent and live
   scope. Before the settings entry is removed, durably prune routine
   directories and path-scoped grants under that root, then detach project
   metadata from every host-owned conversation namespace. A separately
   registered descendant root is an exclusion boundary and retains its own
   grants and routine scope. Missing cleanup services or any persistence failure
   retain the settings entry (fail closed). After settings persistence, revoke
   live scope in every session, but abort active turns only in the removed
   project, including its side chats and sub-agents. Turns in other projects
   continue even if they held directory grants for the removed root. The preview
   and abort share the project selector. A legitimately unbound side chat or
   standalone routine belongs to no project and continues. An unresolvable
   non-null project root or inconsistent binding is an internal contract error.
4. Preserve conversation transcripts during the mandatory pre-removal metadata
   detachment. Under a metadata lock, clear only `projectRoot` and `projectName`
   from matching sessions, retain every other metadata field and the JSONL
   transcript, then reindex the session search row. A stale metadata write must
   not reattach a root after removal.
5. Project lists are derived only from the current validated root registry.
   Session metadata cannot synthesize a removed project row. Detached and
   intentionally unscoped sessions remain in the ungrouped Chats list; their
   stored identity is never reassigned by basename or silently rewritten to the
   default root. Clearing project metadata currently makes a detached session
   indistinguishable from a conversation that was unscoped from creation. This
   is an Ave implementation choice, not a shared reference-product convention;
   the surveyed agent hosts support transcript preservation but none of them
   automatically reclassify such a session as a general conversation. When an unscoped conversation executes, the host binds that
   turn to the default workspace execution context.

## Conversation Loop

The conversation loop builds the system prompt, session history, project
context, memory context, available tools, and provider configuration for each
turn. It streams model output, collects tool calls, dispatches tool execution,
and commits turn artifacts back to the session store.

The return-here action can restore conversation, native file-tool edits, or
both at a durable user-message boundary. The [code rewind design](../design/code-rewind.md)
owns capture boundaries, restore conflict refusal, storage limits and untracked
effects. Its [latest-turn review contract](../design/code-rewind.md#latest-turn-change-review)
defines recorded change summaries above the composer, a unified Files tree
with responsive side-by-side detail, and existing file-mention references with
host-authorized, bounded context and clickable file previews.

Important rules:

- Explicit project metadata must be attached before a project-scoped new
  session is persisted; a general conversation remains unscoped.
- Tool calls must not execute until the permission manager has resolved the
  decision path.
- A provider round succeeds only after an explicit completion event. EOF after
  text, reasoning, or tool calls remains a stream error. Internal stream deadlines
  and unsolicited provider aborts are errors; caller cancellation remains an
  interruption. An explicitly completed empty response retains its stop reason.
- Stream activity is observed before event mapping, so incremental tool input
  resets the same idle deadline as text or reasoning deltas.
- Text and reasoning deltas preserve their original content, including standalone
  whitespace. Native size bounds and identity checks apply independently of the
  nonblank validation for complete prompts.
- Input estimates count the fields a route replays. Display-only assistant
  thought is excluded; signed reasoning selection is shared by the estimator
  and wire mapper. Before a fallback route is selected, preflight reserves the
  largest complete request projection among configured routes. Local output
  estimates still count generated thought.
- Compaction measures the assembled pending request, including pending
  instructions and the current summary prompt, before and after rewriting
  history. Measurement does not consume an instruction's execution allowance.
- Long histories are compacted through the structured compact path rather than
  silent truncation.
- Manual compaction accepts focus instructions. An optional compaction model
  defaults to the originating conversation's current model and retains its
  authentication route. An explicit selection is scoped to its provider,
  endpoint and preset; switching routes leaves that selection inactive. Summary
  input also respects the selected model's own context budget.
- A round that stops at `end_turn` with reasoning but no visible text and no
  tool call does not end the turn: the loop re-prompts it a bounded number of
  times before returning, because that reasoning states the action the model
  meant to take next.
- Window notices, including foreground turn-end records, enter the bell's session
  history rather than the composer notification area. OS delivery keeps its focus,
  settings and cooldown gates and also records the event in the bell. Approval
  and ask-user requests stay on their cards and never enter the in-app history.
- The main window uses one responsive layout. A wide canvas may show up to
  four conversations; a narrow canvas draws the focused tile while preserving
  the tree, hidden conversations, and the saved maximized choice. Each tile is
  its own conversation loop in the main process,
  addressed by `chatGroupId` on every per-conversation `ave:chat:*` channel;
  the loops share the memory manager and the window-wide idle services. A
  closed tile releases its loop. Width alone never releases a loop.
  `src/shared/shell-geometry.ts` owns window bounds and layout thresholds;
  `use-container-narrow.ts` applies them to independent shell and canvas
  measurements. Panels dock or overlay inside their tile without changing OS
  window bounds. The sidebar's expanded, rail, or hidden choice persists in
  `system.sidebarState`; without a saved choice, the minimum-width window
  starts hidden. Hidden navigation reserves no content width and reopens from
  the title bar. See [responsive geometry](../design/tiled-chat-groups.md#responsive-shell-and-canvas).
- Several main windows may be open ("New Window", `CmdOrCtrl+Shift+N`, or the
  tray). Only a packaged app on its real profile registers itself as the OS
  `ave://` handler; unpackaged, E2E, relocated-`AVE_HOME` and `--user-data-dir`
  launches skip (`src/main/ave-protocol-registration.ts`), so a dev or test run
  cannot take the installed app's deep links. Launching the app again without
  an `ave://` link restores and focuses
  the primary window — or opens a fresh primary when it was closed — instead of
  opening another beside it. `app-state.ts`
  owns the set: broadcasts go to every main window (`getAppWindows`), point-to-
  point sends and dialogs go to the window in use or the sender's window, and
  the first live window is the primary one. Closing the primary while other
  windows are open never reloads or re-roles them: they keep their tiles and
  running turns, the primary conversation keeps running in main with no
  window, and the next window opened (or a relaunch) becomes the primary and
  resumes it. Approval cards and ask-user questions are routed when raised,
  not to a window bound at boot: to the window whose tile shows the asking
  session, else the window in use. A renderer that loads later reads both
  back (`ave:approval:pending`, `ave:ask-user-question:pending`), so a card
  whose window closed re-shows where its session is drawn next. A secondary window's chat group ids
  are scoped to that window in main (`window-<webContentsId>:<id>`), so its
  tiles — its first tile included — are conversations of their own; its
  document carries `?aveWindow=secondary` so it does not resume the primary's
  window-active session. The `MAX_CHAT_GROUPS` ceiling is shared by all
  windows. Closing a window while another is open closes it; only the last one
  follows the close-button preference.
- The chat side panel's browser (`persist:ave-side-browser`,
  `src/main/side-browser-webview.ts`) works like a normal browser: http(s)
  navigation and redirects, popups and OAuth windows (native-framed child
  windows of the owning main window, so they close with it, on the same
  session with no preload, sandboxed, context-isolated, guarded recursively),
  downloads, and a Chromium/Edge user agent so sign-in pages accept it.
  Downloads always go through the native Save dialog (no save path is ever
  preset and nothing opens a saved file); one Save dialog may be pending per
  side browser, and a page origin gets at most 3 download prompts a minute —
  requests beyond either limit are cancelled and logged. Other schemes stay
  blocked. Site capability decisions are separate from agent control and
  origin approval; see [Browser And Terminal Workspace](#browser-and-terminal-workspace).

A long turn uses per-call limits and progress guidance. Each API-backed chat call
is bounded by the route's effective output limit
(`resolveContextWindowForRoute(...).output` in `src/shared/context-budget.ts`): the
requested limit — the vendor block's `outputTokenLimit` when the user set one, else
the host default of 32,000 (`requestedLlmOutputTokenLimit`, source `host-default`) —
clamped to the model's output ceiling, which is what the endpoint's `/models` row
reported, else the model catalog's `limits.output`; an unknown ceiling clamps
nothing. A vendor block stores `outputTokenLimit` only when the user set it, so the
default is never written back. The adapter honours the route's resolved ceiling when
supplied, including an unknown ceiling; other requests meet the eligible catalog
ceiling, which is where purpose-specific limits (finalize, background, memory,
reviewer) meet it. The output that would still fit the remaining context is recorded
in the turn summary (`modelSettings.remainingContextOutputTokens`) and never clamps a
request. Each API-backed turn whose last request uses the primary route records the
catalog `sha256` and the effective window, output, reasoning and prices with their
sources in its turn summary and audit `turn` row. Native serialization may narrow
those limits further (not when the endpoint reported the ceiling, which is sent as resolved);
`modelSettings.requestControls` keeps the serialized output
and thinking controls beside the route's output resolution, and the recorded numeric
reasoning budget matches that serialized value
(`src/shared/run-model-settings.ts`); see `docs/design/model-capability-catalog.md`.
A model's window, price, input modalities and reasoning levels come from the user's
settings, the endpoint's report or the catalog, never from its name. Where none states
them, the window is the 128K host fallback (source `fallback`), the price is unknown,
images are refused and an OpenAI-family request sends no reasoning effort. Host-owned
values live in `src/shared/model-host-policy.ts`: the 32,000 default output, the 128K
fallback, the credible-window ceiling, TPM defaults, and request-control projection. A declared numeric reasoning budget
selects numeric thinking; qualitative-only reasoning selects adaptive thinking.
Unknown entries carry no inferred control. Protocol selection reads reported
controls or catalog reasoning support instead of model-version patterns.
A model that is going away is in one of two tiers (`resolveModelRetirement`,
`src/shared/context-budget.ts`). **Retired:** a public vendor's own complete `/models`
listing on its native host no longer names it (never for local, self-hosted, gateway,
custom-`baseUrl` or Azure routes; a failed or partial listing proves nothing). Only an
id the active catalog knows exactly under the vendor's mapped provider can be judged;
a fine-tune, an account-scoped deployment or a model newer than the snapshot never is. A saved
selection at one sets the `llm.retiredProvider` marker at settings load
(`{ vendor, model, reason: "unlisted" }` beside the removed-vendor string), which
withholds API-key chat and credentials until the user picks — the same flow as a removed
vendor. **Deprecated:** the active catalog marks it `deprecated` where the route
establishes its identity; no marker, chat and credentials keep working, and the window
shows a non-blocking notice. The listing outranks the catalog. Both tiers are hidden from
every picker; the host keeps no retired-name list. See [retired models](../design/model-capability-catalog.md#61-retired-models-slice-7-follow-up-owner-direction-2026-10-13).
Whether a route's model reasons and what it costs may also come from the route's
own `/models` report (`resolveReasoningSupport`; `resolveModelPricing`'s
`endpoint-report` source): the user's named entry, then the report, then the catalog. A
commercial OpenAI-compatible endpoint receives only the reasoning parameter its report
names (`reasoning`, `reasoning_effort` or `include_reasoning`); the self-hosted class keeps
its own switch and budget. See [endpoint reports](../design/model-capability-catalog.md#51-reasoning-an-endpoint-reports-slice-7-follow-up-owner-direction-2026-10-13).
The catalog in force is chosen once per launch (`src/core/model-catalog/bundled.ts`): a
`AVE_MODEL_CATALOG` pin (`bundled`, a cached `<sha256>`, or an absolute file path; a pin
that cannot be honoured fails boot), else the verified refreshed copy in
`<AVE_HOME>/cache/model-catalog/` when it is no older than the bundled snapshot, else
the bundled snapshot. An interactive launch refreshes that cache from
`https://models.dev/api.json` at most daily (`llm.modelCatalogRefresh`, default on; off
under the pin or the managed policy's `modelCatalog.refresh: "off"`), through
`fetchPublicHttpResponse` on the host's single-hop transport, never a plugin path: a
GET omitting session authentication, cookies and user content; redirects are refused,
headers and body share a 15 s deadline, and decompressed body bytes are capped at
16,777,216. The source sees the IP address and ordinary transport headers. Failed
attempts also count toward the daily cadence; publication retains at most five cached
catalogs. A refreshed copy takes effect at the next launch, and any failed refresh keeps
the catalog already in force. See [the refresh contract](../design/model-capability-catalog.md#7-refresh-slice-6).
User-configured thinking budgets apply per API call, including each
call after a tool result; they introduce no cumulative quota for a user turn.
They are non-negative integers capped at the highest fixed preset strictly below
the effective output ceiling. Settings and composer share these presets: low
4,000, medium 8,000, high 16,000, and xhigh 32,000. The default 32,000 output exposes
only low/medium/high and caps thinking at 16,000; xhigh returns at 32,001 output.
If no preset fits, the custom budget is capped at output minus one, with a minimum
of zero. The same resolver normalizes profile loading and settings patches.
Fresh settings use 8,000. Valid custom budgets such as 10,000 or 14,000 stay unchanged until an
explicit preset selection; the UI shows their exact value. If no preset fits,
the existing custom budget and thinking on/off remain available. Retry uses the
user ceiling and restores the prior budget afterward. Raw internal generation
retains its separate protocol contract.

Ordinary oversized text tool results remain verbatim in live memory and the
renderer, and within the artifact storage cap they remain in file-backed session
artifacts. Provider requests receive a bounded head/tail preview with the
original size and `toolUseId`. The builtin
`read_tool_result_chunk` tool reads from an absolute UTF-16 `offset`, returns an
exact `nextOffset`, and can find a literal `query` at or after that offset. Its
shared size contract defaults to 3,000 characters and accepts 500 through 5,000;
changing `maxChars` never changes the requested position. Returned boundaries do
not split Unicode surrogate pairs. Search misses return `found: false` and no
next offset; after a match, `nextOffset` continues after the returned context.

`web_fetch` retains at most 2 MiB of response body bytes in a fixed buffer and
cancels body reads when the tool caller aborts. It extracts readable text only
from declared HTML; other response text keeps its whitespace and markup.
Complete bounded text enters the same history and chunk-recovery path above,
without a producer-side preview cut. If JSON escaping expands the serialized
result beyond `MAX_TOOL_RESULT_ARTIFACT_BYTES`, the tool returns an explicit
size error instead of an unrecoverable partial success. Per-hop network and
approval checks still apply before reading each response.

Foreground shell history and session records retain the bounded display prefix
and a trusted capture reference. The persisted preview ceiling is 16,384 UTF-16
characters, which preserves the 12,000-character shell display plus completion
annotations; the smaller provider head/tail budget applies only to projection. Generic artifact serialization must not replace
the captured bytes with that prefix. Recovery first resolves the current
history's `toolUseId`, then validates the matching capture. Session reload keeps
a bounded preview and validates reference metadata and file ownership without
eagerly loading the artifact. Missing or invalid references are explicitly
unavailable. Provider recovery stubs are projections rather than persisted
preview content. Forking a checkpoint into a different session marks these
session-owned captures unavailable; it does not copy their original files.
Chunk reads and literal
search use the same UTF-16 offset contract and report capture completeness;
reaching the end of retained partial content never means the complete command
output was recovered. Only host execution bookkeeping can attach trusted capture
references. Provider requests keep their existing bounded preview budget.

Smaller purpose-specific limits stay with the internal/background
`generateText` callers that own them. Managed subscription transports retain
their own output-control contract. A provider-reported `max_tokens` completion
uses the existing length-continuation path without a second truncation branch. From
the other side, every `chat.progressNudgeRounds` assistant rounds (and early when
tool errors pile up) the loop sends a wire-only progress notification carrying
the round count, elapsed time and tool call/error totals, with one instruction:
verify a completion claim by actually running something, or change approach. The
cadence counts assistant rounds, not loop iterations — schema-drop retries and
length continuations reuse the iteration without advancing the round — so a
notification always falls on an ordinary round and never on a continuation,
whose request must end with the assistant prefill. It is never written to
history, because its numbers are true only for the round that sent it; the
`progress.nudge` decision is where the cause is recorded instead. `0` turns it
off.

It reaches the wire through the round's single assembly point, alongside the
reasoning-only re-prompt: every host instruction for a round shares ONE appended
user row, because a second consecutive user row is what a chat template
asserting role alternation rejects. The assembly point is also where each
instruction's bookkeeping is spent, so a recorded notification always
corresponds to one the model was actually handed.

Tool-produced images remain tool-result data in stored history. The API adapter
owns their wire representation. A route with text-only tool output sends the
paired tool results first, then derives one visual input with explicit tool
provenance for that result group. A following user or host instruction shares
that row to preserve role alternation. This translation does not create a user
turn, dispatch commands, or grant tool output additional authority. Error status
and attached images are both retained. Request estimates include transmitted
images and exclude images removed by tool-result compaction. Subscription
transports preserve each retained tool image as an indexed native attachment,
with its tool-call identity and error status in the corresponding history row.
Later host instructions do not hide those images. The existing native image
count, byte and MIME bounds remain authoritative; no tool path is reread or
remote image URL fetched by this projection. Original user images retain their
existing newest-user-message scope. Subscription request estimates count the
same retained images sent through the native channel.

## Provider Adapters

The engine exchanges `GenericMessage`, `StreamTurnParams`, and `StreamEvent`
with providers. The common OpenAI provider module connects API-key requests
and Codex subscription requests to this contract. It owns the model-visible
request projection; transport adapters retain their wire formats, credentials,
and native session state. Subscription credentials never become API keys, and
an unavailable connection never silently selects another authentication route.

The [installed CLI subscription runtime](claude-code-subscription-runtime.md)
defines its model selection, billing disclosure and isolated authentication.
It admits only publisher-signed releases at or above a single-sourced minimum
version; a signed release older than the previous install but above that
minimum is accepted by design, because the provider's stable channel trails
its latest release and publishes no revocation list.

API requests retain the existing SDK transport and configured reasoning/output
controls. Subscription requests retain their active native profile and governed
tool handoff. A numeric API thinking budget does not override a native reasoning
profile. In both cases Ave owns the conversation loop, tool execution, approval,
memory, and broadcasts to attached surfaces.

Child-process adapters share `JsonLineReader` for UTF-8 JSONL framing and
`JsonRpcPendingRequests` for request identity, pending promises, and timer
cleanup. Framing limits apply to individual lines, including fragmented lines;
receiving several valid lines in one OS chunk does not make them oversized.
The reader stops after a framing error or owner closure. Each adapter supplies
its existing timeout and error policy, rejects unsupported native host requests,
and owns process shutdown. Native thread, turn, and session state remain in the
protocol adapter rather than in the shared RPC registry.

Transport failure diagnostics may retain the pending request's host-issued
`operation`, validated against the closed `PROVIDER_RPC_OPERATIONS` catalogue.
Only its finite ASCII labels are accepted; request parameters, paths, prompt
text, credentials, and remote operation fields are excluded. This metadata
passes unchanged through the subscription provider and stream collector to the
error trace without selecting retries or changing deadlines. Where the protocol
separates turn-start acknowledgement from terminal notification, the RPC timer
ends at acknowledgement. An RPC whose response completes the prompt retains
the adapter's existing prompt deadline and cancellation grace instead.

The [provider integration design](openai-provider-integration.md) describes
the connection boundaries and extension points.

## Memory

Memory is host-owned and project-aware. User preferences, long-term memories,
and work-board memory are read and written through storage seams, not renderer
filesystem access. Korean natural-language triggers remain supported where they
are part of runtime intent parsing, but default app-generated memory templates
are English.

Memory writes should preserve source provenance and avoid storing secrets,
credentials, raw private data, or unsupported claims.

Memory use is recorded in `memories/usage.jsonl` (`src/memory/memory-usage-log.ts`),
one row per managed memory id with `via`: `injected` (in a turn's context when
a round is assembled for send, before the provider call, so a request that then
fails still counts), `searched` (on the page `memory_search` returned) or `read`
(`memory_read`). Rows
hold ids, session and anchor message ids and a timestamp only, never memory or
user text, and the file is size-capped by dropping its oldest rows. Legacy notes
without a managed id are not recorded. Only builders on the user's memory store
record injection; isolated sub-agent builders, including work-board runs, read
the sub-agent store, so their use appears only as `searched` or `read`.

Managed memories are either global or scoped to one project, and the default
project (identified by its path) is an ordinary project scope: its memories are
not global and do not feed the global long-term overview. Global memories apply
in every project. Saving from the UI always names the target scope.

Each managed memory has an append-only change history (created, updated,
activated, discarded, deleted) that records who acted. Rows keep only a
masked, bounded title and excerpt of the changed text. Deleting a memory
removes that text from its history rows and keeps what happened, who did it,
when, and a digest. If the text cannot be removed, the delete fails. The
history file is size-capped, and a read reports where rotation cut it. A
failed history write never fails the memory change, and later reads of that
memory report its history as incomplete. A crash between the memory write and
its history row leaves no row and no mark.

A memory learned in a conversation records where it came from: the session id
and, when one exists, the id of the user message that opened the turn. It
stores ids only; the quoted text is read from the session when shown, so the
memory store never copies conversation text. The origin comes from host
metadata only, never from model or renderer input, and a direct save from the
memory UI has none.

## Insights

Insights is the default home for calendar-based activity review:

- calendar heatmap for token usage;
- selected-day usage details;
- daily LLM narrative with deterministic fallback;
- starred items for the selected day;
- conversation and project activity summaries.

Daily narratives are generated through host IPC and must fail closed to the
deterministic UI fallback when no provider is configured or generation fails.

## Work Board

The Work Board is a host domain, not only a plugin. It stores items, activity,
reports, and work-flow memory under host-managed storage. Reports default to
English prompts and English seeded examples. Per-project report paths use the
normalized project key.

The work board can still integrate with plugin and subagent flows, but the host
owns storage, approvals, and audit.

Item runs execute as sub-agent sessions whose origin names the item
(`work-board:<itemId>`), so their conversations live in the isolated sub-agent
namespace, never in the main chat store. As soon as the plan child links, the
engine records it as the item's `runSessionId` and emits a `planning` progress
event carrying that id, so a board opened mid-plan can claim the child's tool
approvals. The engine replaces it with the
execute child's id, and emits an `executing` progress event carrying that id,
as soon as the execute child links (before its first round). Each link write
changes only the session id and appends no activity entry. If it fails, the
run settles as an error even when the child finished: a run whose session the
board cannot record is not reported as completed.

While the execute child runs, the local user can steer or stop it
(`ave:work-board:steer-run`, `ave:work-board:cancel-run`). Both are internal,
sender-validated channels from a board window's main frame that require a
consumed keyboard gesture (`CHANNEL_GESTURE: "required"`); a call without one
is refused, not downgraded. The engine resolves the child from its own record
of the item's execute child, never from renderer input. A steer is queued for
the child's next round boundary as host-fenced guidance with no principal and
no sender prefix, so it neither grants the child user-keyboard capabilities nor
raises an other-principal floor; nothing is stored for a later resume.
Acceptance (`ok: true`) means queued, not delivered: if the child's turn ends
before its next round boundary, the steer is dropped and only the audit records
it (`work-board:steer:deferred:<reason>`). The board learns either outcome from
a `runProgress` event carrying only `steer: {messageId, status}`: `delivered`
names the turn that took it, `dropped` names the loop's reason. Such an event
is never the run's phase. A second stop while the first is unwinding is the same stop. A stop
uses the ordinary sub-agent interrupt, and a run the user stopped settles as
`cancelled` (shown as stopped, not as an error). Planning and plan approval
are not steerable or stoppable here. See
[permission-decision-tree.md](./permission-decision-tree.md), S→T and the
"Delegated work" note; the tree is unchanged.

Plan approval is a work approval, not a tool-approval card (owner decision
2026-11-04; [permission-decision-tree.md](./permission-decision-tree.md),
"Work approvals"). When the plan child finishes, the engine stores the plan and
a pending `planApproval` on the item in one write and the run returns
`awaiting_approval`; nothing waits in the approval gate, so there is no timeout,
and a restart keeps the pending plan (boot reconciliation leaves an
`awaiting_approval` run alone only while its plan, run id and pending decision
are whole and the plan hash still matches; anything less becomes `error`).
`ave:work-board:decide-plan` (internal, sender-validated board-window main
frame, `CHANNEL_GESTURE: "required"`) carries the run id, the hash of the plan
the card showed and the decision, never the plan text. The store checks all of
them, and for approve also that the item's title, detail and project still
match the snapshot the plan prompt was built from, so an edit made while the
plan child was still planning leaves the plan stale (`plan_stale`), inside the
board lock, and
writes the decision before anything acts on it: approve moves the run to
`executing` in that write, so a second approval finds nothing pending. Approve
spawns the execute child; request changes (a note is required) re-plans the
same run with the prior plan and the note as host-fenced non-principal
guidance, so the plan child's permissions do not change; reject ends the run
as `denied`. The continuing run broadcasts its own `run-started` (`resumed`)
and `run-finished`. The audit records `work-approval:decided` with the run, the
plan hash prefix and the decision, never the note. Run fields and
`planApproval` are engine-written: `ave:work-board:update` refuses any field
other than title, detail, due date and priority.

Briefing runs
(`work-board-briefing:<kind>`) are not runs of an item.

Work approvals ("확인 필요" in the UI) are work-level decisions, separate from
tool-execution approvals, which stay in the conversation's ApprovalDock.
`ave:work-approvals:list` is a read-only projection over the stores that own
each decision. It covers open work proposals (`unscoped`) and routines needing
attention (`global`). A routine needs attention when plugins are missing, a
held-back plugin id is invalid, or its last run failed and the failure is not
acknowledged. A failure is listed even on a dismissed record (a shutdown routine
stays dismissed after it fails). `ave:routines:ack-failure` clears exactly the
failure the card showed, by its `firedAt`, and returns `routine-failure-stale`
when a newer failure replaced it. A successful or notify-only result is not a
decision and is never listed. Plan approvals (project-scoped) join with WA-1.
Memories save without approval, so they are not a source. The list returns
the requested project's items plus the unscoped and global ones, with a `total`
across every authorized project for the title-bar badge. Titles and summaries
are DLP-masked. Views are built field by field, so
a routine prompt or a proposal task brief never crosses this channel. A missing
source store is a `work-approvals-source-unavailable` result, never a silently
shorter list. Each source store signals after its own write, whichever path made
it (IPC, plugin HostApi, scheduler). The boot step `wireWorkApprovalsChanged`
subscribes to those signals and broadcasts the payload-free
`ave:work-approvals:changed` so windows re-list. Actions stay on each source's
own channel.

## Conversation List

Every conversation the app keeps is listed in the sidebar's conversation tab.
They do not all live in one place: the app runs three separate `MemoryManager`
instances — the main store (`~/.ave/sessions/`), the side-chat store
(`~/.ave/side-chat/`) and the sub-agent store (`~/.ave/subagent/`) — and a
listing of one of them can never see the others.

`ave:chat:sessions` federates them. Its `families` option selects which
conversation families to read; each store is listed by its own manager, every
row is stamped with its family by the one classifier (`sessionFamilyOf`), and
the rows are merged into a single list ordered by `modifiedAt`. A request that
names no family is answered from the main store alone under its `kind` filter,
which is what every caller but the sidebar wants.

| Family | Store | Row | Opens |
| --- | --- | --- | --- |
| `main` | main | chat glyph, the conversation's title | the conversation, in the focused tile |
| `routine` | main (`sessionKind: "routine"`) | routine glyph, the run's title | the run, through the same session-load path the routine panel uses |
| `work-board` | sub-agent (origin names an item) | work glyph, the item's title | the board item, newest run transcript expanded |
| `side-chat` | side-chat | side-chat glyph, nested under its live pane or listed ordinarily | the bound live terminal or page and its pane chat; with no live pane binding, the conversation and its side-chat tab |

A sub-agent session that is not an item's run has no family and is not listed:
it is already reachable inside its parent conversation's sub-agent tab, and a
row beside the conversation would say the same thing twice.

Only a `main` row carries the main store's actions. Every other family is
read-only in the list — open, and nothing else: no rename, archive, pin, delete
or drag, because those act on the main session store and three of the four
families do not live in it. Archived conversations keep their existing
behaviour; archiving hides a row, and a family never did.

A side chat records the conversation it was started beside as its
`originSessionId`, written by the host on the turn that first gives the side
chat a file. The ordinary side-chat row uses that origin when it opens. A side chat whose
conversation is not in the list remains reachable in its own right.

A pane chat is nested beneath its terminal or page row only when its host-recorded
`paneTabId` matches the live surface inventory and the host's current,
window-scoped session binding snapshot. It is excluded from the independent
General and project conversation lists. Creator ownership may place the surface
inside a project; the pane chat still belongs beneath that surface. Closing the
surface ends the live binding and the host archives its chat. The retained row
appears in its ordinary project or General location only under Show archived,
with a localized former-terminal or former-page caption. It remains openable
through the ordinary side-chat route. The archive toggle remains reachable even
when all archived rows belong to projects. Stored pane identity is provenance,
not authority to reopen a closed surface. Starting a new pane chat clears the
previous chat’s pane identity.

Until the first valid host binding snapshot arrives, pane-bound session rows are
omitted. Unarchived pane chats without a matching live surface and binding in
this window are also omitted: the global session list can include chats active
in another window. A window-local absence never establishes that a binding has
ended; the former-chat caption requires the host’s persisted archival state.

A terminal or web pane opens the side chat in its own panel (the header's
panel toggle), beside the page or terminal, as that pane's own conversation.
Each open pane chat has its own conversation loop, made on its first turn and
kept by main per window and pane tab (`paneChatLoops`); the side panel's chat
keeps the app's side loop. Pane chats and the side panel therefore stream at
the same time, and each refuses only a second send on its own loop
(`streaming-active`). There is no cap: a pane loop lives only while its pane
is open, and ends with the pane, its window, or the app. All of them write the
side-chat store. A pane's turn binds its session to the pane's tab
(`browserTabRegistry` bound conversations), and the session's row records the
tab (`paneTabId`), so a restart reopens each restored pane on its conversation
(restored tabs keep their ids). A turn from a conversation's side panel runs
on the side loop in the session its view shows; a conversation a pane holds
is refused there (`session-open-in-pane`). The refusal names its owning pane tab
only in that pane's window; the renderer checks the live tab inventory before
offering Open, independently of the conversation list's current page or filter.
Explicit host refusals are operation notices; unknown execution or transport
failures remain stream errors even before the first stream frame.
Hiding or unmounting a pane chat
does not abort its turn. Its renderer transcript subscription follows the tab's
lifetime; returning to the chat reattaches to that transcript. Reopening a pane's chat reads its
history (`ave:sidechat:pane-history`); the chat's New starts the pane afresh
and the pane's close ends it (`ave:sidechat:end-pane-chat`), stopping only
that pane's turn and archiving a closed pane's conversation. A pane that ends
while its conversation is loading sends nothing (`pane-chat-ended`). When an
authorized `browser_tab_close` destroys an agent-owned pane's page, its turn
runs to its end before its pane chat ends. Releasing a borrowed user tab keeps
the page alive.

Browser tools called without a tab id act on the bound browser
tab, and sub-agents inherit it through their hosting session; a bound tab that
is gone, or of the other kind, is an error, never another tab. A click uses
touch input, which the window routes through its one touch sequence
even when sent through the page's own protocol session; so each press runs
alone in its window, a started press always ends, and a press counts only when
its own page reports it and no other page of the window took a touch. A conversation
that is not a pane's uses the active browser for browser tools. Terminal
read/run authority instead belongs to the invoking conversation's isolated PTY;
a terminal-bound pane turn cannot type into its host shell in this delivery. The pane chat claims its session's approval cards,
so the window's lane does not draw them again.

## Browser And Terminal Workspace

Chat, browser, and terminal remain simultaneous workspace surfaces. Side/main
placement is presentation state: moving a pane preserves its live browser guest
and its one host shell. The [workspace guide](../guides/browser-terminal-workspace.md)
explains the user workflow; [permission policy](permission-policy-design.md#shared-browser-control-and-effects)
owns consent and effect checks. These contracts describe code behavior; native
interaction and provider-authentication validation remain separate evidence.

### Browser control and tab lifetime

The browser sandbox and context isolation are always enabled. Agent authority
is an additional host-owned layer in `src/shared/browser-surface.ts` and
`src/main/browser/browser-tab-registry.ts`; selecting Human mode never removes
the browser sandbox. Origin approval authorizes an operation on a page, not a
complete network firewall for that page.

The registry publishes revisioned state with `human`, `agent-active`, and
`human-paused` modes. Recognized human page input, Stop, and user navigation invalidate
pending agent effects and persistently pause mutation. Read-only observation
still follows normal policy. Only explicit Resume in trusted browser chrome
can restore eligible control; a tool, navigation, or a later turn cannot resume
it. Document and control generations bind actions and approvals, so a stale
approval does not survive pause followed by Resume. Renderers subscribe before
their initial state fetch and ignore older revisions.

Native mouse receipts do not expose an injected-versus-human source bit. Ordinary
pointer/range drag uses host-armed one-shot correlation of the exact live guest,
button, coordinates, click count, down/up phase, and order. Each expectation
expires after one second within a maximum five-second sequence, with one
mouse/wheel watch per owning window. A mismatch pauses mutation. Wheel gestures
must follow a marked native wheel event and the expected begin/update/end
sequence. Keyboard input retains its debugger-source flags.

HTML5 text drag has a separate guarded path because a native renderer may finish
the drag without a raw mouse-up receipt. A generic input acknowledgement is not
proof that release or drop was delivered. The host instead correlates a
browser-originated `dragIntercepted` event with the observed source press and
the same live guest, document, lease, and endpoints. It captures one bounded
text-only payload and reuses that immutable payload for guarded enter/over/drop.
Ordinary pointer/range drag still requires native down and up receipts.

This is bounded correlation, not perfect provenance: a human click at the same
expected coordinates/button/phase during the armed interval is indistinguishable
through the native API. Extra or mismatched observable input still interrupts,
but the host cannot promise that every simultaneous human click wins. Stop and
trusted-chrome navigation remain explicit takeover controls.

Creator identity is durable and distinct from the current control lease. A
lease identifies the actual conversation actor, its direct parent when present,
and an `owned` or `borrowed` lifetime. Window-wide tab discovery grants no
authority over another conversation's tabs. Conversation-scoped `browser_tabs`
can include the caller's direct children; aggregation uses the stored
direct-parent relation, not a recursive hosting-window ancestor. An owned tab authorizes its creator,
the creator's direct parent, or a direct child whose trusted parent is the
creator. This relation is symmetric across one parent/child step; a grandchild,
sibling, or unrelated session cannot inherit that authority. An existing lease
still excludes a different caller. Release revokes only the matching
lease, so a late cleanup cannot release a newer controller.

Agent-created tabs open in the background by default and remain for human
handoff after a turn. An explicit agent close destroys only a creator-owned tab
within that authorized one-step relationship. Closing a borrowed tab
through the tool releases its association and reports that the page was retained.
User chrome close destroys the actual tab; window/app shutdown releases its
resources.

At model-turn end, the host clears that turn's live browser presentation and
returns its idle owned tabs to human control without clearing creator identity,
opener provenance or the retained guest. Human-paused tabs keep their explicit
Resume requirement. Exact-turn held leases retire publicly at once, while a
private settlement fence excludes new actions until the old handler releases;
late release cannot reactivate control. Newer-turn and non-model leases remain
untouched. Subsequent actions still pass the same owner and permission gates.

Agent new-window callbacks queue site admission and tab opening under the
originating command's exact guest and lease. The command awaits that outcome
before releasing control and reports popup errors. Document transitions preserve
that lease lifetime; command failure, takeover, cancellation or lease loss aborts
pending admission before a late grant can be recorded. Adapter cancellation and
the command lifetime both constrain intercepted navigation consent.

Native popups enter the registry only through the validated child-window
callback. They keep the owning window, guarded session, opener relationship,
and sandbox; they can have a tool handle without a renderer tab slot. Popups
start with user permission provenance. Discovery or focus does not inherit the
opener's origin approval or remove sensitive-field restrictions.

Tool `tabId` values are main-issued handles, while embedded chrome identifies
slots with `rendererTabId`. `BrowserTabsApi.stop`, `pause`, and `resume` accept
only embedded renderer IDs. These IDs are distinct from main-issued tool handles,
and the browser workspace library/find/zoom/preview API targets embedded slots only.

Focusing an embedded page uses a main-owned `focus` operation addressed only by its stored
renderer ID. It requires a visible owning window, that window's active embedded
tab, and unchanged guest, document, control generation, and lease across awaits.
Trusted renderer chrome focuses only the connected visible webview. Completion
requires actual native guest focus for visible pages; keyboard actions independently require
`focusedFrame === mainFrame`. Parked agent guests never borrow native focus. Their
renderer-reported display state is distinct from the last-selected surface hint. Before hiding a visible guest, the renderer waits for main to acknowledge parking; main installs keyboard blocking and removes native guest focus before replying. A failed acknowledgement leaves the guest visible. Showing paints the surface before clearing parking. The host
blocks unmarked native keyboard events to parked guests and returns accidental focus to
visible chrome. Page-local focus emulation during an action does not route OS input
to that page, and is released with its action receipt. A null native focused frame
is accepted only after the exact focused node was proved part of the main document;
an actual different focused frame remains refused. A renderer acknowledgement alone is insufficient.
Popups require their registered native focus callback and observed native focus.

Parked input records its exact control lease without capturing a renderer focus
receipt. A protocol touch or field focus can change the native keyboard frame
without changing the embedder active element. Parked input therefore reasserts
the current host frame after those dispatches and awaits renderer acknowledgement
before continuing, while keeping page-local focus emulation. Parked restoration
never calls DOM blur or refocus on an active editor; remembered controls are used only when the body
or no element is active. The native owning window and renderer document must
both hold foreground focus before a handoff, so another app remains foreground.
Main then verifies that native keyboard routing has left that guest while the
window is focused. An embedded child
view can report its root view as focused; keyboard ownership is measured through
the owning host's focused frame, not that shared view bit. Visible embedded input captures
that receipt before borrowing focus. If a previous host control disappears or can
no longer accept focus, restoration tries usable remembered host controls; it
still refuses a replaced or hidden previous guest and preserves deliberate user
focus movement. Painting activity belongs to the physical guest across action
adapter instances. Only its final participant may start the idle grace or restore
the guest's original throttling state.

Managed guest owners share one native destruction subscription. The dispatcher
indexes guest IDs with physical identity guards; each owner has an independent
registration and the last unsubscribe removes the native subscription. Destruction
retires the record before notifying a snapshot of owners, so reentrancy, one
owner's cleanup failure, or an old guest's late cleanup cannot skip another owner
or affect a replacement. Already-destroyed registrations notify immediately;
preview startup releases its returned close disposer before issuing commands or
arming timers if that notification closes it during registration.

Pointer input uses guest-local viewport coordinates. Native node hit testing adds
the measured document scroll offset to that point; host placement is never added.
The exact main-frame subtree and live document lease remain checked before input.
App zoom preserves each guest's independent per-site zoom. Protocol input remains
in guest CSS pixels; native local pointer receipts use guest-zoomed DIP coordinates,
with float32 precision for both the factor and product. Only receipt expectations
are converted, without host zoom or device scale. Zoom must remain unchanged across
pointer confirmation and touch contact; a destroyed guest cannot provide a receipt.

### Typed page actions and browser chrome

Browser tools expose typed snapshot, screenshot, navigation, click, text, and
key operations plus hover, drag, native single-select, targeted scroll, and
picker-only upload. Schemas and execution both validate operands. Page effects
recheck the live document, target reference, recipient, and control generation.
There is no model-facing arbitrary script or generic protocol dispatcher.
Every browser tool result, including host validation and action errors, remains
inside the untrusted browser-content envelope. Diagnostics can interpolate page
titles, accessible names and navigation URLs; a host error is not a trusted-text
exception. String bounds and fence neutralization apply inside that same boundary.
Navigation returns after exposed accessibility content appears or a short bounded
settle, without a loading flag. Snapshot and `browser_read_text` results reserve
20% of the host's inline token budget for transport overhead; their truncation
flag reports omitted content. Text reads prefer exposed main or article content,
exclude child frames and ignored nodes, and use the same page permission gates
as snapshots. They expose no script input.
An explicit snapshot `maxChars` request (500–50,000) retains the full bounded
outline for existing host chunk recovery. Rereading without `delta` recovers
elements omitted from the default inline outline.
HTML5 interception uses only fixed internal `Input.setInterceptDrags`,
`Input.cancelDragging`, and `Input.dispatchDragEvent` operations. Browser-originated payloads remain untrusted;
only bounded approved text MIME data is accepted, with no files or host-path
payloads. Model inputs remain source/target references, never arbitrary protocol
methods or drag data. The source drag is cancelled and interception is confirmed
disabled before destination enter/over/drop. A failed pre-drop teardown sends no
destination drop; an uncertain session is detached and quarantined. Cancellation
after entering the destination cancels its remaining drag state on the original
session. A dispatched drop with a lost acknowledgement is outcome-unknown and
must not be repeated automatically. Cleanup never retargets a replacement guest.
Screenshots retain their pixel/byte bounds and capture deadline. Viewport,
element-reference and region captures crop native viewport readback in document
CSS coordinates; the requested region must be visible. Embedded full-page capture
scrolls and stitches native viewport images at the current viewport width. Fixed
and sticky content remains repeated where it appears in each tile; capture does
not alter or deduplicate that page content. Full-page output preserves its scale
and truncates the bottom at the pixel limit. Output includes dimensions, scale,
`truncated`, and the real page height in `originalHeight`. Tiled captures also
report `captureMethod: "scroll-and-stitch"` and
`stickyHeadersDeduplicated: false` together. Parked agent tabs retain the shared
activity wake ownership before reading layout or capturing.
Preparation, readback and cleanup share one cancellation signal and capture
deadline. Cleanup attempts to restore the original scroll position and clear any
temporary viewport override even on cancellation; a still-pending cleanup retains
guest capture ownership until it settles.
Selection verifies the final native value and rejects unsupported controls.
Native single-select uses a fixed function in an isolated action world on one
host-resolved main-document object, with only the requested option value as data.
It dispatches input/change events without native focus or keyboard input. The action
guard seals the world, resolved object and function, rechecks the document lease,
and verifies the unchanged option set and final accessibility selection. It exposes
no script or object identifier to model callers.

The host distinguishes a document transition from cancellation. A page-input
action can finish through navigation only after a confirmed final input effect
and a typed document-change result. No following input reaches the replacement
document. A navigation request can follow document transitions only while its
original caller, tab, and lease remain valid. Takeover, lease loss, caller
cancellation, or destruction cannot become navigation success. Lease acquisition
keeps the approval generation stable; pause, Resume, and document changes
advance it.

The host-owned browser workspace API uses renderer tab IDs and derives window
ownership from the sender. It provides bookmarks, bounded history, find, zoom,
site decisions, download status, and tab-card previews. Persistent bookmarks,
history, and site decisions use `openFeatureNamespace("browser-workspace")`;
invalid stored state cannot become a permission grant. Download paths and
history are not disclosed by browser tools merely because the UI lists them.
Downloads retain native Save consent and prompt-rate limits, with no auto-open.

Site capability checks bind the current requesting origin and owned guest.
`clipboard-sanitized-write` retains its safe baseline for a known guest. Camera,
microphone, geolocation, and notifications require a verified current main-frame
request and explicit site decisions or trusted prompts. Iframes and redirects
cannot borrow unrelated origin grants; unknown permissions deny. Fullscreen
capability is `false` until safe exit UI exists, so even a stored allow decision
cannot enable it.

Preview work is scheduled only for connected, intersecting cards in a visible
app window. Main owns at most one in-flight capture per window, throttling,
invalidation epochs, and reduced image size; it retains no preview image cache.
`BrowserPreviewScheduler` in the renderer owns the tab/document cache, capped
at 16 entries with reuse for less than ten seconds. Only a completion whose
original card is still eligible enters that cache. Hidden or unmounted panels
stop scheduling; late results after hide, unmount, navigation, or close are
neither displayed nor cached. Preview never claims the live surface slot, focuses or navigates
a tab, or retains a closed guest. Hidden/visible capture counts and actual guest
behavior require runtime validation; this contract is not a measured resource
improvement.

<a id="separate-terminal-lanes"></a>

### Host terminals and conversation shells

PTY termination uses `killPty` in `src/main/terminal/pty-kill.ts`: Windows omits signals, including forced cleanup; POSIX retains the requested signal. Windows termination is single-shot per native agent, including while enumeration is pending. The request guard remains set even after failure because native handles may already have been released. Windows tab close skips the POSIX three-second signal escalation and retains session ownership until exit.

The `node-pty@1.1.0` patch in `patches/node-pty@1.1.0.patch` reads console members before native teardown and sweeps only the returned list. Lookup failure, agent exit without a result, or timeout yields an empty list rather than a cached shell PID. Remove the patch when an upstream release fixes [node-pty#952](https://github.com/microsoft/node-pty/issues/952), including the ordering and failure behavior. Any integrity manifest covering these dependency files must be regenerated when adopting or removing the patch.

Normal Windows app shutdown allows at least six seconds for exit, covering the dependency’s five-second enumeration deadline plus exit cleanup; a longer requested wait is preserved. On deadline expiry, shutdown logs unresolved work and leaves sessions registered for late exit cleanup; the bound does not guarantee native termination. The explicit zero-budget emergency path remains immediate after the outer shutdown deadline is exhausted.

Each visible terminal tab owns one
native host shell, with a host badge/color band. A side-work-panel mount is
labeled **No agent access**; eligible workspace agent commands follow the
[user-owned surface choice](permission-policy-design.md#user-owned-surface-choices). Its real HOME and configured profile remain intact. zsh, bash and
pwsh use nonce-authenticated integration from a per-PTY temporary startup directory
(pwsh: directory and exit status are attested, but agent typing into pwsh is refused
and its mount says so);
unsupported shells or failed integration retain the user's native shell without
claiming current-directory, exit-status or agent-control capabilities that have
not been attested. Host integration never installs the disposable-HOME startup
files into the user's real HOME.

A main-owned registry separately maps each conversation to its confined
persistent PTY. The existing `TerminalSessionRef` fields (internal `tabId`,
`lane` and host-issued `terminalSessionId`) may identify confinement,
egress and authenticated block state; an isolated PTY's opaque terminal identity
is never a workspace-tab or renderer authority. No tab-to-agent-companion binding
remains. Host UI/IPC operates only on host refs; conversation PTYs use main-only
lifecycle operations and authenticated observation rather than raw renderer output.

Isolated commands appear inline in their owning conversation, with command,
directory, running/final status, known exit code and collapsible bounded output.
Conversation teardown awaits isolated-PTY exit and cleanup, including pending
spawn and block registrations. Permission-scope release revokes its egress and
execution authority earlier; a retained retiring completion lets teardown await
the same exit/cleanup even after registry removal. Pane hiding/remount and host-tab close alone do not end
it. If closing a pane also ends its conversation under existing lifecycle policy,
that teardown releases the isolated PTY. Host-tab close always ends its own shell.

Existing one-shot shell tools retain their explicit approved host/outside-sandbox
execution route. Their inline badge reflects the actual execution mode: an
unconfined command shows host execution rather than claiming isolation. Every
persistent conversation PTY remains confined; approving a one-shot host command
does not permit typing into a user's host terminal.

A workspace pane chat bound to its host terminal may run one eligible
command at a time there through `terminal_run`, using the session
[user-owned surface choice](permission-policy-design.md#user-owned-surface-choices). A main-owned control lease per
host incarnation gates every agent byte; user input, Take over, Stop, a purpose
or binding change, or exit revokes it before user bytes reach the shell, and Hand
back needs an empty attested prompt. Only output received under the lease returns,
to the requesting conversation only. The
[host command control](permission-policy-design.md#host-command-control) policy
is canonical for its target, decision, recheck and disclosure rules.

Browser and host-terminal choices use the same three-choice card, independently
keyed by conversation and surface. Missing/dismissed choice means ask; choices
never persist across sessions. Auto reviews logical task/target consistency
only, with normal-card fallback. Global mode and remembered generic grants do
not bypass the choice; headless always denies. Admission, deny rules, genuine
principal/taint floors and credential/payment protections remain enforced. Upload evidence on either user-owned surface always uses a normal human card, bypassing session Allow/Auto and logical review; headless denies.

The [terminal permission policy](permission-policy-design.md#commands-typed-into-a-workspace-terminal)
is canonical for exact command approval, authorized-project containment,
confinement, TTY/nonce readiness, egress and cancellation checks. These isolated
checks remain in force, including the Linux initial-namespace revalidation limit
and fail-closed behavior when the backend is unavailable. Host startup/user output
is private; only explicit user-selected block attachments share host context.
Host terminals annotate a command positively matched to tracked agent-changed
files with a non-blocking inline warning on its own row (a renderer decoration,
never PTY input or buffer text, never over the command text), and show an
agent-changed file count on the header badge. Both open the terminal's 변경 파일
view in its work panel, built from the conversation's change UI. A terminal
pane has one header row, like a conversation pane: a compact host chip, whose
tooltip carries the environment note, the shell-reported directory, block
history and attach-last, the badge, and the same work-panel toggle. Its chat and
changes open in the same docked work panel a conversation pane uses, docked from
the conversation pane's breakpoint up and overlaid below it. The side-work-panel
host terminal has the same single row (its chip also says the agent has no
access) and the same advisory changed-file UI while retaining no agent access.
Successful write provenance uses canonical physical paths and the identity the
writer's own descriptor reported, which alone the diff may read; it is never
permission authority. An attended host terminal takes keyboard focus when it opens
or is activated only if nothing holds focus or focus is on this terminal's own
selected tab, so a composer, an approval card, a tab elsewhere or the terminal's
own controls keep focus. Dynamic indirection and subprocess writes without concrete path evidence
remain explicitly outside complete coverage. The
[changed-file review policy](permission-policy-design.md#agent-changed-file-review)
defines the evidence lifetime and the separate isolated loader write-deny floor.
Side-work-panel host terminals have no agent read/write access.

## Extension Runtime

Extension installation and runtime behavior are governed by manifest declarations,
capability checks, the machine's marketplace policy, and host APIs. Extensions and
every other package kind arrive through git marketplaces (`src/marketplace/`):
the app syncs each source's repository, pins the commit it read, and installs
only the bytes that commit names (release or archive by sha256, or the pinned
tree). A source can also be a local folder: it is read in place through
`FolderFs` (no git command, no download), pinned by a revision over the files
it read, and installed from a copy captured when the install is planned. A
folder is classified and judged by the policy before anything touches it; a
folder on another computer is confirmed once per path, and links that leave
the folder or name another computer are refused unread. Every git remote and download a source names passes one network gate.
The gate applies the machine's policy, then checks the class of each address.
Downloads and git over http(s) connect only to the addresses checked. git over
ssh is checked before git runs, and ssh's own later lookup is not bound. A
proxy is checked at its own address and trusted beyond it. Plain http,
internal-network and this-computer targets are confirmed once per source
address. Metadata and unroutable addresses are always refused. Each
marketplace call runs as one operation under the policy a refresh applied
after it began. Lock order: a marketplace operation comes before any plugin
lifecycle lock. Code that holds plugin locks and calls the marketplace enters
one operation first and takes the plugin locks inside it; installs,
uninstalls and updates of one package also take that package's lock, after
the operation and before any plugin lock. Predecessor removal takes both
packages' locks the same way, and a package lock asked for while a plugin
lock is held fails instead of waiting. A caller takes all its package
locks as one request (`app/keyed-mutex.ts`); the lease it gets lives as long
as its callback, runs work only under packages it holds, and is never
extended; asking again without it fails instead of waiting.

Installed packages update by themselves at boot and once a day, one at a
time and only while no conversation turn, session mutation or session
transition is running (`ConversationActivityCoordinator.onIdle`); an agent
plugin also waits until its MCP calls drain. An update applies automatically
only when its consent fingerprint (authority, MCP servers, hooks, launchers,
and each bundled server's and hook's approval digest over the package
tree, with only the manifest's version string normalized)
equals the baseline the installed version was reviewed with: checked once
against the catalog and again against the staged bytes before anything
activates. A consent change is never applied automatically; it waits for the
user's review. A component approval carries to a new generation only while
its approval digest is unchanged. A `requiredInstalls` update is reviewed by
the policy and leaves any new component unapproved. Nothing a queued update
carries authorizes it: when its turn comes it is judged again, under the
locks, with the policy and switches in force then. The [multi-source git marketplace design](../design/multi-source-git-marketplace.md)
owns those contracts (network targets: its §7.4; automatic updates: §7.3;
local folders: §7.7; refresh, lock order and the policy keys: §12; the update
review: §15.6).

Key boundaries:

- Loopback OAuth callbacks are authenticated by the host before plugin delivery.
  `authRedirect.open()` mints a 256-bit single-use state with the redirect URI;
  exact path and timing-safe state validation are mandatory. Wrong or missing
  state receives a 4xx without consuming the waiter, and rejection logs omit
  query values. A matching provider error is returned as validated error fields.
  Plugins must use PKCE S256 together with that state. Protocol 4 is unreleased;
  this development build rejects older contracts before activation through
  protocol negotiation. Released hosts and published packages still use protocol 3.
  The [protocol contract](../design/plugin-hostapi-protocol.md#331-host-validated-loopback-oauth)
  and [author guide](../guides/plugin-development.md#loopback-oauth-with-pkce) own
  the wire and migration details.
- The complete extension-author TypeScript contract and its JSDoc are Host-owned in
  `src/plugins/public-contract.ts`. `src/plugins/types.ts` re-exports that
  surface and adds Host-private registry/marketplace DTOs. Extension repositories
  vendor the public module and `schemas/plugin-manifest.schema.json` unchanged
  at an app release tag, recorded in `contract/sources.json`. An extension using a
  new contract member sets `requires.minAppVersion` to a supporting app release.
- extension code cannot invent its own identity when calling HostApi;
- installed extension assets are loaded through host-approved URLs;
- extension tools must declare schemas (pure MCP `Tool` objects); per-tool category
  is not a manifest field — the host classifies the effective category per
  invocation;
- natural-language keywords never activate extension scope or preload a Tool.
  Bundled `manifest.skills` contribute instructions, while host-selected extension
  scope and `tool_search` control model-visible Tool discovery;
- extension UI can render in host slots but cannot bypass permission review;
- the text a host renders from a manifest can be localized per entry. A `ui[]`
  entry may carry `locales: { [tag]: { displayName?, title?, description? } }`
  (normalized lower-case BCP-47 tags, 1 to 16; empty entries, blank strings and
  unknown fields are refused). The host resolves against its current UI
  language: the exact tag, then its base language (`pt-br` → `pt`), then the
  entry's own fields, then the plugin id; for the label, `displayName` precedes
  `title` within each language step. The sidebar and its Extensions menu, the
  plugin pane header, the command list, the native app menu and the floating
  dock's slot titles share `src/shared/plugin-view-label.ts` and re-render on a
  language switch. `configSchema` properties (`title`, `description`) and
  `auth` (`label`) accept the same `locales` shape. A host that predates the
  field refuses the manifest as an unknown key: the field requires Ave 0.14.1 or
  later, and an extension declaring any of these `locales` sets
  `requires.minAppVersion` to `0.14.1` or later;
- optional `manifest.onboarding` copy is inert, localized metadata. An extension
  declares one `firstTask` and up to five `highlights`; the host asks each as a
  tile overlay card once and remembers the answer — accept, later, or never — in
  `~/.ave/onboarding/proposals.json`. Accepting performs the declared `action`
  and only that (prefill the visible composer, or move the settings view onto a
  destination written `<tab>` or `<tab>/<section>`, so the reader lands on the
  control rather than on the page that holds it); nothing auto-submits, starts a
  turn, or invokes a tool, and undeclared or unusable extensions produce no
  proposal. The host validates both halves of the path against the tabs and
  sections its build ships and rejects the manifest otherwise;
- no package locks or privileges itself. The manifest's retired
  `installPolicy` and `publisher` are refused at install and ignored, with one
  warning, on an installed manifest. Only the system policy file's
  `marketplaces.requiredInstalls` keeps a package installed: an entry locks the
  package installed from the source it names against uninstall and disable.
  Host secrets beyond an extension's own namespace come only from the app's
  `HOST_SECRET_GRANTS` table, for an official extension installed from the
  artifact its snapshot pins; provider-preset keys are never granted and a
  local development install never qualifies. Each source's
  `policy/revocations.json` disables or uninstalls only that source's installs;
- boot verifies each installed payload's receipt before parsing its manifest.
  Receipt hashing and manifest validation run with bounded concurrency, but
  successful results and failures are projected in registry order. A rejected
  payload never contributes tool/event ownership or dependency capability, and
  an accepted manifest is parsed only once for that boot load.
- extension replacements keep the prior registry row in a strict `pendingUpdate`
  state from the pre-promotion boundary through registry commit. Runtime and
  HostApi trust caches skip pending rows, while uninstall/bundle planners retain
  the full row and its references. Boot clears the marker only after the exact
  receipt snapshot verifies every covered file in the owned extension directory,
  restoring directory bytes before publishing that receipt when a validated
  backup is required. A verified retry preserves the original predecessor and
  grants until its replacement registry commit; unresolved live bytes are
  journaled as cleanup-only ownership and never become a recovery snapshot.
  Recovery backup IDs, names, and parent directories are validated exactly.
  Every obsolete post-commit or superseded directory is retained in the
  non-restorable `pendingCleanup` journal until direct removal or tombstone
  staging succeeds. Direct and bundle uninstall stage the live directory plus
  all recovery/cleanup-owned paths before deleting the row; unresolved recovery
  backups are never handled by the orphan tombstone sweeper.
- managed boot synchronization uses one boot-local promise tail. Recovery
  journals and retirement state are bound first; compatible managed artifacts
  then commit durable bytes, receipt, and registry state without candidate
  publication or execution. Admitting runtime start synchronously seals the
  tail before awaiting it, so later managed commits reject before mutation and
  `startAll` runs exactly once against the final committed snapshot. Renderer
  retry is missing-only: any registry row or owned artifact counts as installed,
  regardless of enabled or runtime-start state. Only a truly structural missing
  repair may use the generic generation lifecycle to activate the new artifact
  before reporting retry success. A failed runtime start remains sealed and is
  never retried or reported as started implicitly.
- an extension artifact may declare extension-owned `skills`, `hooks`, and `mcpServers`
  as `{id,path}` entries. IDs are local to the tuple `(extension id, extension version,
  contribution kind)` and paths are normalized relative to the verified extension
  root. The Host rejects absolute/traversing/ambiguous paths, declaration or
  archive-member collisions, links/devices, missing members, and a Skill
  directory without `SKILL.md`. A contribution-free manifest remains valid.
- declaration and signature are not execution authority. Skills contribute
  instructions only; Hook trust is bound to the exact owner/version/local ID and
  command-policy fingerprint; MCP connection approval is bound to the exact
  owner/version/local ID and static policy fingerprint. Candidate preparation
  for MCP is parse/fingerprint-only and performs no spawn, network, discovery,
  registry write, or extension execution.
  An `mcpServers[].path` descriptor is one JSON object containing a standard
  `stdio` or Streamable HTTP MCP config without `id`, `apiKey`, `sandboxRoot`,
  or `allowPrivateNetworks`; the Host derives a generation-scoped server ID and
  an ephemeral strict governance rule. Exact approval connects it without
  adding it to the user's global `servers.json`. A failed connection is a typed
  degraded projection with zero tools and does not roll back the extension bundle.
- extension code, handlers, materialized Skill bytes, Hook projections, static MCP
  descriptors, and operation policy belong to one immutable active generation.
  Every dispatch first acquires a lease on that generation. Lifecycle transitions
  prepare a hidden candidate, block new leases, durably commit bytes/receipt/
  registry identity, then publish with one non-throwing in-memory pointer
  assignment. Existing predecessor leases may finish; teardown waits for their
  drain and remains journaled/retriable if fallible cleanup fails. A crash before
  the durable commit reconstructs the predecessor; a crash after it reconstructs
  only the committed verified generation.
- renderer-to-plugin method calls are allowlisted by each tool's
  `_meta.ui.visibility`: only app-visible tools (visibility includes `"app"` —
  the union of app-only `["app"]` and dual `["model","app"]`) are
  renderer-invokable;
- an app-only **non-status** tool (visibility exactly `["app"]`) is driven by a
  direct UI activation only and cannot be invoked from an extension-origin
  `ctx.callTool` — give it `"model"` visibility (`["model","app"]`) for governed
  model/plugin invocation (the auth `statusTool` is exempt: status polling skips
  the user-activation gate and runs on an extension-origin chain) (#1556);
- long-lived extension workers are spawned only through HostApi `spawnWorker`;
  filesystem read grants must be declared explicitly as `allowReadPaths` and are
  never inferred from argv. Each worker declares `control`: an `output-only-v1`
  worker reads nothing on stdin, and a `stdio-control-v1` worker reads its frames
  there. Either way stdin is the host's liveness pipe: the host closes it only on
  an orderly stop, otherwise it closes when the host process is gone, so a
  long-lived worker treats EOF on stdin as the order to exit; that, not the
  shutdown sweep, is what keeps workers from outliving a crashed or killed host.

### Extension alerts and scheduled routines

The [alerts design](../design/plugin-alerts.md) defines the complete alerts
release; partial rollout builds expose only their implemented portions. Extensions
own signal detection and declare localized templates and bounded slots in
`alerts.kinds`. The host owns consent and delivery through `raiseAlert`, with no
extension-specific delivery branches. A malformed block grants no kinds.
Extensions cannot submit Work Board proposals or issue separate agent approvals.

The pipeline checks grant, input shape, predecessor, user toggle, open/closed
identity, cooldown and rate before accepting and delivering an alert. A
predecessor from the declared source, or without a source binding, blocks while
loaded, or installed and not revoked; revocation without unloading does not
immediately lift the block. Only accepted alerts consume delivery budgets.
Effective visibility can only decrease: a user-visible alert stages a card,
a summary-only alert delivers a notification cue without a model prompt, and a
silent alert writes audit and an event. OS delivery requires the declaration,
user OS toggle and master switch, respects focus unless bypass is declared,
and never occurs for low priority. One OS cue replaces, rather than duplicates,
an in-app toast.

Identity uses an installation-secret HMAC. Raw keys and slot text are excluded
from audit, events and `alerts/open.json`. The persistent table retains identity
and lifecycle metadata, not rendered cards: after restart an extension must re-raise
an open identity to redraw it, returning `refreshed`. A late renderer can obtain
cards already staged in the current process. Host-only `alert.*` events carry
no slots and reach only the originating extension or a subscriber with an explicit
grant naming it. Reference slots remain in the wrapped prompt footer, never on
the card; OS text is static.

Accepting a card closes its identity and inserts the pending prompt into the
selected conversation with the `plugin-emitted` staged origin. Tool permission
and force-ask gates remain intact. The host-renderer-only alert IPC owns card
closure and staged-card queries. `setupAlerts` runs after marketplace setup and
before boot uninstall-cleanup replay so it observes lifecycle events, and the
service is available before extensions start.

All official kinds are opt-in, including the successors of new-mail and
meeting-summary OS notifications. A new kind first encountered during an update
starts off. A visibility increase disables the kind until the user consents.
Eligible predecessor choices transfer through retained configuration under the
migration rules; the generic settings patch cannot author alert choices.

Unrequested cards — alerts, accepted `triggerConversation` suggestions and
routine cards — land in one dedicated, persistent Suggestions conversation (a
reserved-id `main` session created on demand and named from the catalog by its
id), never in the focused conversation. The user runs a card there or continues
it in a new conversation. Onboarding proposals stay inline. See the overlay
contract.

`triggerConversation` survives for setup suggestions. Extensions declaring alerts
must declare their suggestion sources and receive at most one acceptance per
source per 30 days. The transition exception for extensions without alerts and the
legacy trigger visibility/priority fields end in the next minor release.
From 0.13.0, the host drops an installed manifest's `notificationEvents` field
before strict validation and warns once per extension. It no longer registers
OS notifications from that field. New packages requiring the alerts release or
later are refused by the repository checker when they declare it. See the
[overlay contract](../references/overlay-trigger.md) for sources and delivery.

Scheduled LLM routines with non-empty explicit extension allow-lists use installed
registry rows, including pending updates, to detect missing extensions. With none
installed, the occurrence is skipped with `plugins-missing`; a one-shot remains
pending and a repeating schedule advances without a fabricated result. With
some missing, the routine runs and records the missing IDs as `needsAttention`.
The routine panel shows either state and offers removal. Installed-but-unloaded
extensions are not missing; runtime scope and headless permission gates still decide
which tools may run.

An LLM routine run that does not complete persists `lastFailure` on the routine
record, so a restart keeps it. `kind: "error"` covers a run that threw, with a
`reason` that is DLP-masked, home-path-redacted and then bounded.
`kind: "shutdown-timeout"` covers a shutdown run cut off at quit. Runs can
overlap, so an outcome or acknowledgement for anything but the current
`lastFiredAt` is stale and changes nothing. A later successful run of the
current fire clears the failure, and acknowledging that fire's result marks it
seen. A failed scheduled one-shot is restored from dismissal so it stays
reviewable, but it is not due again. Shutdown routines are never restored,
because they would run at every quit. An unreadable stored `lastFailure` is
dropped with a warning, and the routine itself is kept.

The schedule panel lists routines per project. Every new record carries a
`projectRoot` and a `createdBy`, and the store refuses an add without either:
the renderer passes the active project and records the user, and
`routine_schedule` passes the calling conversation's project, resolved from
its session through whichever live loop holds it (a tile, the side chat or a
pane chat), then its saved metadata (a conversation outside any named project belongs to the default
workspace), and records the agent. It never uses the tool working directory,
which can fall back to the process directory; with no session project it
refuses. Only records stored before projects existed
have no project; they show in every project. The project filter is for display
only. It is not an authorization boundary, and nothing may rely on it to keep
one project's items from another. A user edit (`ROUTINES.update`) changes the
title, prompt, notification text or schedule and passes the same validation as
add, and the IPC handlers refuse wrongly typed fields first. Add refuses an
unknown trigger or execution in both the IPC handler and the store, since a
later read would drop the record; the renderer may also pass only a
well-formed scope and an installed-template source
(`agent-plugin:` or `extension:`). A schedule
"changes" only when it fires at different times: `at` compares as an instant,
no repeat equals a "none" repeat, and a cron schedule is its expression alone
(cron ignores `at`), trimmed with whitespace runs collapsed. Then the old
series' cron minute keys are dropped, and a one-shot is due again and no longer
missed. A re-save that fires at the same times keeps them, so neither a cron
minute nor a fired one-shot can fire twice. Stored records with wrongly typed
text or schedule fields are refused at load. Pause is reversible, unlike dismissal: a
paused item is never due, cannot be run now, and a paused shutdown item does
not run at quit. Resuming does not replay what was paused: a repeating item's
next fire moves past now, and a one-shot whose time passed while paused is
missed. It is not due, the grid shows it as missed, and only 지금 실행 or a new
time runs it. A scheduler pass decides due-ness from a snapshot and then awaits
the extension check, so `markFired` re-checks the item inside the store's file
queue: a paused or dismissed item never fires on any path (scheduler, run-now,
quit), and on a scheduler pass an already-fired one-shot, a missed or a
no-longer-due item does not fire either. `ROUTINES.listOccurrences` serves the day, week and month grids
for a range of at most 43 days. Projected occurrences reuse the scheduler's own
next-fire arithmetic and cron evaluator, so the grid draws only times the
scheduler fires; each item is capped at 200 occurrences. Past runs come from the
item's sessions and `lastFiredAt`, including dismissed items, because a
completed one-shot is dismissed by its own fire. A run is `failed` when
`lastFailure` names it.

## Main-process composition and boot readiness

TypeScript under `src/` must have no static runtime-import strongly
connected components. `bun run check:import-cycles` enforces this in the build
gate while ignoring type-only imports. Shared theme replay state and native
window event listeners therefore live in leaf modules; compatibility barrels
may re-export them but native window construction imports the leaves directly.

Reverse calls from menu and main-window modules into native window actions go
through the native-window coordinator configured once by `main.ts`; the tray
remains the one-way composition owner. Calls before configuration and repeat
configuration are contract errors. Boot uses a staged `BootContext`, then an
exhaustive own-property readiness assertion before `assembleAppServices`; a
missing producer is reported by field name instead of leaking `undefined` into
the running application.

## Current Large-Module Ownership

The remaining high-churn surfaces keep one state owner while delegating focused
implementation units:

| Stable surface | Focused owners |
|------------------------------------------ |------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `engine/turn/query-loop.ts` | owns the round loop plus the meta-tool intercepts (`request_plugin`, `tool_search`) and their cross-agent approval gate — none has a consumer outside it; `tool-scope.ts` and `compaction.ts` own their respective policies |
| `plugins/runtime/index.ts` | the single owner of plugin runtime state, lifecycle mutations, and invocation/query |
| `preload/internal-surface.ts` | stable world builders and first-frame primes; `internal-api-surface.ts` owns the internal renderer API object |
| `data/settings-store.ts` | persistence/service facade over `settings-defaults.ts` and pure normalization in `settings-normalization.ts` |
| `ui/renderer/components/ChatSidePanel.tsx` | panel/tab composition over preview, layout, and workspace components in `chat-side-panel-*.tsx` |

Every implementation unit remains below 1,600 lines. The split does not add a
second state store, runtime alias, IPC channel, or policy path.

## Sub-agent Messaging (A2A)

Sub-agents are in-process child `ConversationLoop`s. Messaging expands the
**communication** graph between them; it never expands the **creation** graph,
which stays hard-stopped at depth 1. Full design detail, decision record and
state-transition table live in
[docs/blueprints/a2a-subagent-messaging.md](../blueprints/a2a-subagent-messaging.md);
this section records only the contract the rest of the host depends on.

**Four messaging edges.** Each is a distinct tool with a distinct authority:

| Edge | Mechanism | Authority |
|---|---|---|
| child → parent | `agent_send(to: <parent>)`, optionally `waitForReply` for a question | a child reports to its own principal |
| child → sibling | `agent_send(to: <siblingChildSessionId>)` | peers under one origin; the receiver never agreed to act on it, so it force-asks |
| parent → child | `agent_guide` — injected live into a running child, or queued in the durable directive mailbox for a suspended one | the parent amends the task it authored |
| parent → suspended child | `agent_spawn(resumeId=…)` continuation instructions | re-hydrates and continues the same child |

`agent_send` is registered model-visible for children only; `agent_guide` is
parent-only and blocklisted out of every child registry. Addresses are always
the host-minted `childSessionId` (`sub-<sha256(origin)[:8]>-<uuid>`) — a profile
name is display text, never an address.

**Wake drain invariant.** A queued child message can start a parent turn when
autonomous wake is enabled. The drain has one invariant: a per-parent dirty
token, spent before dispatch, is the progress guarantee — a wake that consumes
nothing must stop, and every trigger that legitimately owes a delivery must
still reach exactly one wake. Pinned by
`src/engine/__tests__/a2a-wake-drain.test.ts`.

**Mailbox durability.** Both the sibling mailbox and the parent directive
mailbox persist to disk, so a message survives the suspension it was written
across. A directive is only accepted for a child whose resume can still happen
— task state, suspension reason, and both resume-axis counters — because the
mailbox's only delivery path is a resume that would otherwise refuse it. On the
delivery side an entry is acknowledged when the segment that carried it reached
a conclusion, and a terminal child's pending entries are discarded outright.

**Parent rounds are unbounded.** A round budget is a sub-agent concept: the
runner assigns `maxRounds` per child, and hitting it is a `round-cap` budget
suspension carrying a `resumeId`. A parent turn passes no `maxRounds` and runs
`PARENT_UNLIMITED_ROUNDS` — there is no global round constant, so a parent turn
never reaches `round-cap`.

## Tool Governance

The [owner-approved permission decision tree](permission-decision-tree.md) is the sole source of decision order and the action-by-mode matrix. This document specifies evidence, execution boundaries and approval delivery; it does not define a second decision sequence.

All builtin, plugin and MCP tools enter the same normalized decision pipeline. Callers supply evidence and execute the returned outcome; they do not own additional mode matrices. Argument rewriting finishes before authorization, and user script PreToolUse blocks before any target approval. The source affects display/audit, not authority. Remote user equivalence additionally requires a current owner-identity match; the [decision tree](permission-decision-tree.md) owns pairing, existing-binding revalidation and live identity admission.

Builtin approval cards describe the requested action and its subject through one
presentation mapping, checked against actual core and workflow tool registration.
Missing registered descriptors fail coverage; builtin source never reaches the
generic external-tool execution title. Site and egress card precedence and all
approval choices, rules and requirements remain unchanged.

New installs use Default (`strict`). Persisted `default` remains Allow writes; stored IDs do not change. Eligible checkpoint-backed project writes pass in Allow writes/auto/Allow, while Default asks. Ordinary reads remain allowed. Secret reads use mode/rules; secret writes follow file rules. Host credential stores and the process ownership lock remain admission-denied. Exact lexical/canonical identity, all-target checks and checkpoint recovery remain required. Ordinary outside writes use one folder/invocation card. See [Project file writes](permission-policy-design.md#project-file-writes) for eligibility and recovery.

Owner-away cards wait without a timeout by default; optional `permissions.ownerAwayAutoSkipMinutes` denies after N minutes (0 means unlimited). True headless auto requests review first; a required human fallback denies with “Nobody can approve this request; do not retry.” Recently denied replaces deferred approvals with redacted summaries and fresh manually approved reruns. Reruns retain the original session and turn-origin restrictions; the user click supplies only one-time consent. Stored history grants nothing.

Permission-policy file precedence, conservative handling of administrative read
failures, and edit locking follow [Policy Files](permission-policy-design.md#policy-files).

On Windows, sandbox write denies beneath machine roots (`ProgramData`, the
program-files roots and the system directory) are omitted unless a grant
strictly beneath the machine root contains the target: ordinary ACLs already
refuse users writes there. Denies inside writable workspaces remain protected.
A missing deny target can create placeholders and change its parent's DACL,
requiring `WRITE_DAC` on machine-owned directories that ordinary users cannot
change. Read denies are never omitted this way; one the helper cannot stamp
fails sandbox initialization. Write grants equal to or above a machine root are
refused before policy narrowing. Unproven path identities retain the deny. Administrative policy
protection outside grants instead lives at the read boundary:
all administrative section readers share a non-following, handle-based reader.
The file must belong to Administrators or SYSTEM. Its parent must belong to
Administrators, SYSTEM or the trusted installer service. The file's DACL may not
grant another principal write, deletion or ownership/security changes. The parent
may not grant delete-child, deletion or ownership/security changes; add-file
rights, which ProgramData's default inheritance gives Users, cannot replace an
existing file and are allowed. The file and
parent handles reject reparse points, remain pinned against replacement, and
must have matching final parent paths; bytes and security descriptors come from
those same handles. Marketplace reads recheck trust even if file timestamps are
unchanged, because a parent DACL change does not change file timestamps.
Untrusted or malformed policy locks editing and requires approval. Settings
shows the path and cause, and the audit logger records the failure without policy
contents. Other platforms retain their existing read behavior.

### Structured File Transfers

`copy_path({sourcePath, destinationPath})` copies ordinary binary/text files or complete directory trees, including hidden ordinary entries and empty directories. `extract_archive({archivePath, destinationPath})` extracts tar and gzip-compressed tar, detected from content. Both are builtin write tools registered through `createFileTools()` in [file-tools.ts](../../src/tools/file-tools.ts). ZIP extraction and archive creation are unsupported. Shell recursive-copy and archive-mutation denials remain in force; denial guidance describes the supported alternatives and explicitly limits the tar alternative to extraction.

Both endpoint fields enter the existing path checks and write approval. At execution, the file-access gate checks both endpoints and every reached entry. The source does not gain the wider read-only scope. [Permission Policy Design](permission-policy-design.md#structured-file-transfers) owns the admission contract. The destination parent must already exist within admitted scope. The exact destination must be absent, including empty directories and dangling links; the tools neither append a source basename nor overwrite or merge existing content. Overlapping source and destination paths fail before creation.

[guarded-file-transfer.ts](../../src/tools/guarded-file-transfer.ts) owns destination creation, streaming, accounting, cancellation and cleanup. It processes files serially with bounded buffers. [file-transfer-policy.ts](../../src/tools/file-transfer-policy.ts) owns the resource ceilings; callers cannot raise them through tool inputs. Copy does not reuse a search traversal's exclusions or truncation. Unsupported entries, detected source changes, invalid archives and exceeded limits fail the operation. Symlinks, hard links and special files are rejected. [archive-entry-reader.ts](../../src/tools/archive-entry-reader.ts) also rejects unsafe or duplicate effective member paths and unsupported sparse semantics, and requires complete tar framing and gzip validation before success.

Regular tar members expose only their declared payload bytes. The reader consumes
the complete alignment block without treating its trailing bytes as file contents
or requiring those alignment bytes to be zero. Metadata and terminal validation
remain separate from regular member alignment.

Where POSIX mode bits are supported, destination directories use `0700`; files start at `0600` and retain only the owner's executable bit from the source file or archive member mode when applicable. These modes do not establish an ACL-based privacy guarantee on platforms without owner/group/other permission support. Source ownership, group/world permissions, timestamps, ACLs and extended attributes are not copied. The tools do not modify source bytes or metadata, although filesystem reads may update access times. A concurrent source edit is not guaranteed to produce a snapshot.

Exclusive creation establishes ownership at the requested destination. The destination may be partially visible while work is running. A successful [TransferResult](../../src/tools/file-transfer-types.ts) means every supported entry was processed, actual byte accounting passed and all streams and descriptors closed. There is no skipped-entry or partial-success result. This is not an atomic whole-tree publication or a crash-durable transaction.

On failure or cancellation, the core waits for active I/O to settle and removes only unchanged entries recorded in its ownership ledger. It uses non-recursive directory removal and preserves foreign entries or detected replacements. Failure reports `cleanup: "not-created"`, `"removed"` or `"incomplete"`, with bounded residual paths and cleanup errors when needed. The executor's host-only cancellation-settlement opt-in waits for these tools to settle before returning an interruption and preserves that interruption even if a late result reports success. Other tools retain their existing cancellation behavior and ceilings.

Path and identity rechecks detect ordinary creator conflicts and observed replacements; they do not close every race between an ancestor check and a filesystem syscall. A process able to replace live ancestors remains outside this guarantee. An OS syscall that does not return can delay cooperative cancellation, and abrupt host termination can leave an incomplete new destination. Cleanup does not infer authority to remove such residuals later.

### Sub-agent approval chain (three tiers)

Child escalation and other-principal turns follow the forced one-shot floor in the [decision tree](permission-decision-tree.md). Reviewer, parent adjudication, away automation and remembered grants cannot substitute for the user's exact live approval. Without a human, the request denies with no-retry guidance. Parent/child ancestry, session ownership, trusted spawn provenance and turn liveness remain admission and effect checks. The historical three-decider sequence is superseded; the heading is retained for inbound links.

The [approval delivery contract](permission-policy-design.md#approval-delivery-and-execution-binding) specifies registered surfaces, exact-frame answers and one-use consent. A child cannot author its own approval facts or persist a rule. Recently denied is history, never a delayed approval of an ended child turn.

### MCP↔plugin execution parity (invariant)

External MCP-server tools (`source:"mcp"`, `mcp-tool-adapter.ts`) and in-process
plugin loopback tools (`source:"plugin"`, `plugin-tool-from-mcp.ts`) are
registered into the one tool registry and executed through the single
`ToolExecutor` invocation pipeline. `executor.ts` is the stable public barrel;
the implementation delegates preparation/path policy, authorization/rationale,
and execute/finalize to explicit ordered stages. Both sources converge at the
same ordered chokepoints — Layer-1 deny, ApprovalGate, audit, and the effect-ledger shadow —
and the divergences between them are input-only, driven by host-derived
source-identity signals, never a separate code path or policy bypass. An
external MCP server is a lowest-trust foreign peer, so the host assigns it the
`low` trust tier (`trustFromSource`; a first-party plugin is `medium`) and treats
its risk-classification input as untrusted (`category:"network"`); the effect
ledger records a plugin invocation as host-observable but an out-of-process MCP
invocation as `hostObservable:false`; and the identity field is `pluginId` for a
plugin versus `mcpServerId` for an MCP tool.

Read-only MCP tools are allowed by kind. Other MCP tools use the same mode and
reviewer stages as other tool sources: auto invokes the reviewer, low/medium
verdicts allow, and a completed high verdict enters the model choice and single verified resubmission in the [decision tree](permission-decision-tree.md). Errors and aborts require a normal approval card.
Plugin invocations still require their own effect permissions and one-use
operation grants; neither bypasses a tool ask rule. Both sources converge on
the active recipient’s approval gate and retain their audit/effect-ledger
identities. This boundary is covered by
`src/tools/__tests__/executor-mcp-plugin-parity.test.ts`.

## OS Execution Sandbox And Plugin Workers

The OS execution sandbox is backed by
`@anthropic-ai/sandbox-runtime` (ASRT). The active sandbox capability is
published as `kind: "asrt"` with explicit `confines` dimensions. macOS and
Linux ASRT substrates provide filesystem, process, and network confinement.
Windows srt-win provides filesystem and network confinement but no process
confinement, so shell/process relaxation must remain stricter than filesystem
or network-bearing tool relaxation.

`features.osToolSandbox` defaults to `true` on macOS, Linux and Windows.
An explicit stored value is preserved. Windows requests container-backed shell
confinement by default; plugin confinement remains independently opt-in.
Activation still requires a successful runtime
probe. The host issues one immutable `HostShellExecutionPlan` per invocation;
its `sandboxed` field describes the selected child, including exclusions and
unsandboxed retries, rather than merely repeating the setting. Permission,
reviewer, audit and cache consumers use that plan.
The boot sandbox gate decision precedes every stdio MCP server spawn and every
plugin start, enforced by the boot-order test (`bootstrap-integration.test.ts`)
and the `StdioTransport` guard that refuses a spawn while the gate is undecided.

A shell whose plan is not sandboxed, including explicit host execution or escalation, uses the ordinary mode/human decision in the [decision tree](permission-decision-tree.md). Host state wins even when read-only evidence exists. Normal cards may save prefix rules. Such execution and command-text upload signals are not forced floors; protected-path mutations, critical delete, escape and other-principal turns still are. Upload hints use ordinary mode handling, while actual sandboxed connections pass the egress proxy's destination policy. Non-sandboxed Allow can execute wrapped or opaque uploads. Deny rules remain authoritative.

Exact shell-rule identity preserves literal raw words, including case, module qualifier and quoting; normalization for detection does not change that identity. Versioned rule matching and literal analysis supply evidence rather than a separate exact-only host-shell policy.



Visible literal code, including interpreter options and delegated commands, is
eligible for exact rules. File, stdin and network indirection are accepted
limits, not separately detected blockers; a saved `make` or `python script.py`
invocation does not fix the code it will later execute. The one execution-form
exception is a recognized PowerShell launcher word anywhere in the whole
command, including lexical words inside literal quoted command strings.
Once a recognized launcher word is seen, every later token must pass a
positive character proof after shell quote removal: every code point is a
Unicode letter, number, punctuation, symbol, or U+0020 ASCII space. Other
separators, controls, combining marks and unassigned code points are unproven;
Hangul letters remain literal. Only validated tokens receive the deliberate
e-prefix overmatch: remove leading `-`, `/`, U+2013/U+2014/U+2015 and
lowercase; an e-leading result is unproven, including `ExecutionPolicy`.
No argument-binder whitespace emulation is used. The check never stops at
`-File`, `--`, pipelines, sequences or quoted separators, requires no
operand, and uses no wrapper list or recursive dialect parser. Module/basename,
executable-extension and case normalization are detection-only; raw keys remain
unchanged.
The sole launcher list is `pwsh`, `pwsh-preview`, `powershell`,
`powershell_ise` and their `.exe` forms.

For sandboxed commands the sandbox is the boundary. Normal analysis input is
bounded at 8,000 characters. Bash heredoc bodies have a separate aggregate
64 KiB data allowance only when every original heredoc delimiter is quoted and
retained floor classification finds no known code-consuming receiver. Known
consumers, including through retained wrapper/subshell/pipeline views, keep
full-body inspection and the 8,000-character cap. The executable envelope also
stays within 8,000 characters. Body extent comes from the original source:
no body is deleted, no remaining text is reparsed as proof, and no separate
line-continuation reader is used. Eligible bodies stay original source slices;
the lexer scans only for terminator lines, not general code/floor inspection. One unquoted delimiter cancels
every body's data allowance; all text after the first heredoc operator's line
then receives normal literal checks under the normal cap. Plain unquoted
bodies without expansion remain eligible within that cap. Ambiguous syntax
fails closed. Literal `cat`/`tee -a` data writes remain eligible;
unknown-program stdin remains an accepted limit. No new name list or Lane B
carrier gate is introduced. Complete Lane B input remains capped at 2,000.

Each request obtains one lexical representation from the original grammar and
performs literal proof once. Structural views, command facts, stored-rule
parses and canonical-path inspection results are reused within the request;
successful analysis is not cached across requests.

The grammar enforces one global 400-record `MAX_SHELL_ANALYSIS_TOKENS` limit
for executable word/value records across the complete command, including nested
commands, assignment values, empty assignments and declaration heads. The
counter never resets at simple-command boundaries. Eligible quoted body data
is not ordinary word/launcher/proof input and contributes no executable-token
records. Operators and separators are bounded by source length; the parser
refuses over-limit input before expensive result serialization. General
structural parsing retains its existing safety limits.

Character, data and token limits bound analysis and produce refusal/unproven evidence. They do not create a separate mode matrix; admission failures and execution preparation failures remain terminal, while permission routing follows the [decision tree](permission-decision-tree.md). Literal display decoding never grants authority.



Every approval card — shell (bash, PowerShell, the Plan B, an explicit host
request), network, an exact tool approval, a folder grant, a one-shot request
— draws one shared decision row (owner decision 2026-10-25, unified approval
card): **Deny ▾ | Allow for session ▾ | Allow once**. The Deny dropdown holds
Always deny; the allow dropdown holds Allow for session, Always allow in this
project and Always allow everywhere. A dropdown item selects its choice, the
button beside it then names and commits it, and an **Edit rule** button
appears above the row for a choice whose rule can be edited (wildcards
allowed). Each approval type maps the six choices onto its own store:

| Card | Always deny | Allow for session / in this project / everywhere |
|---|---|---|
| Shell | user-global deny rule (`Bash(...)` / `PowerShell(...)`) | session, project or user-global allow rule, the host-derived exact rule unless edited |
| Network | user-global `Network(<host>[:<port>])` deny rule | the grant of that lifetime (This session / while the isolated shell runs, This project, Always); an edited rule is saved as a `Network(...)` host rule instead |
| Exact tool approval | exact deny of this tool and input (edited in Settings) | exact approval for the conversation (answers `allow-session`), for the project folder, or everywhere (a user-global approval, owner decision 2026-10-25) |
| Folder access | exact deny of this request (edited in Settings) | **Always allow this folder** = the parent-folder grant; session and project are not offered |
| One-shot request | not offered | not offered |

An exact tool approval is stored with one of three scopes: `session` (the
root conversation), `persistent` (bound to the project folder's
working-directory identity) and `global` (no folder; it applies in every
project). Any deny beats any allow, whatever their scopes: an exact deny,
project or global, refuses the request even where a conversation, project or
global allow exists. Among allows the conversation is consulted first, then
the project, then the global entry; since each of them allows, a project
entry neither narrows nor widens a global one. Settings → Permissions lists
global entries as "Everywhere" and revokes them like the others. Where the
host will not record an exact decision for a request (a layer-1/2 ask, a
forced modal or a non-read reason prefix),
the gate says so on the request (`exactRecordAllowed: false`) and the card
shows Always deny disabled with the one-shot reason instead of offering a
choice the host refuses with `one-shot-not-recordable`.

Choices a request does not offer stay visible in the dropdowns, disabled with
the reason. No card sends the gate's tool-wide `deny-always`: Always deny is
saved as a rule or an exact deny and the request is denied once. The renderer
sends only `{ action, scope }` plus, when the person edited it, `pattern`
(`userApprovalRecord` `rule`). The host checks an edited rule against the
card's own rule grammar and requires it to decide this very request; an
invalid or non-matching rule fails with a named error (`invalid-rule`,
`rule-does-not-match`, `rule-required`, `scope-not-offered`,
`not-request-owner`) and the request stays pending. Deny rules may be
wildcards. A saved exact or prefix allow rule lets matching commands run without
asking, including host-shell runs outside the sandbox. The card explains the
rule scope while editing. A forced one-shot request never offers remembered allow.

The [builtin shell sandbox policy](permission-policy-design.md#os-shell-sandbox-policy)
defines writes within project and temporary roots, mandatory control-file
write denies for repository configuration, hooks and pointers, bounded nested
repository discovery, broad reads subject to existing protections, domain approval
through the local egress proxy, and denied Unix sockets. Inactive shell
confinement remains visible in the chat header and Settings through a
persistent reason-bearing status. Workspace terminals, plugin network and
worker control channels retain their own contracts.

Write-policy preparation can remove a broad root's grant when bounded
repository discovery cannot complete. Independently scanned narrower roots,
including the working directory and private temporary directory, keep their
own grants; removing an ambient temporary-root grant does not deny those
children. The linked policy owns discovery and serialized-policy limits.
The existing tool result and terminal output report why access was narrowed,
which roots lost their grants and which roots remain writable.

Existing repository metadata permits index/ref updates, commits, branches and
stashes. macOS blocks new `.git` entries and requires the existing approved
host route. Linux deny-mounts existing Git controls only, preserving missing
routing records as absent, and re-scans nested controls before each command.
After confirmed exit it atomically quarantines newly appeared controls,
new or replaced marker entries, new submodule/private-worktree stores,
newly materialized pre-resolved stores and reserved bare-layout entries within
discovery coverage and the final effective write grants. Inaccessible control
subtrees are excluded; a whole-entry move that would include protected state
fails visibly instead. New routing or directory links cannot authorize cleanup
targets. The entries remain recoverable, and existing result and terminal
output show their original paths and restore locations. Rename failures report an
error without deleting entries. Every Ave-owned Git process carries one shared
hardening policy. Linux invocations hold overlapping canonical write roots
until quarantine succeeds. The current Ave-owned user-project Git query defers
without spawning or caching its temporary answer while a hold is active;
cleanup failure retains the hold for the host process's lifetime. Future
user-workspace Git callers must use the same availability check. Holds compare
checkout-root paths; a non-overlapping sibling checkout can still read a shared
external gitdir or commondir. This ordering is not durable across crashes and
does not control Git already running or
external editor and user-terminal processes. New controls remain usable during
the invocation by such processes; these temporal and failed-cleanup risks are
defined by the
[same policy](permission-policy-design.md#os-shell-sandbox-policy).

Two ASRT 0.0.80 rules shape what a confined command can do:

- Linux: a sandboxed command cannot create a user namespace or a mount
  namespace of its own. The seccomp helper refuses those calls. Where the
  helper is not in the chain, bubblewrap 0.8 or later is passed
  `--disable-userns`. The helper is out of the chain whenever a plugin's own
  socket directory is registered, because that turns on `allowAllUnixSockets`. So
  anything that sandboxes itself that way fails inside Ave's sandbox:
  Chromium's or Electron's namespace sandbox, rootless podman or buildah, a
  nested bubblewrap, `unshare -U`. Plugin workers are not affected, because
  they run as Node through `ELECTRON_RUN_AS_NODE` and start no Chromium
  sandbox. Ave does not set `allowNestedUserNamespaces`. The wrap hardener
  (`linux-sandbox-wrap.ts`) accepts only the bubblewrap options its arity table
  lists. `linux-sandbox-wrap.test.ts` fails when the installed wrapper gains an
  option the table does not list.
- Windows: ASRT ranks the filesystem lists in JavaScript before `srt-win` sees
  them. A write grant at or beneath a `denyWrite` path is handed to `srt-win`
  as a read grant, and a grant at or beneath a `credentials.files` entry is
  dropped. So a workspace or plugin root under one of Ave's write-floor paths
  is read-only on Windows too, as it already is on macOS and Linux.
  `windows-sandbox-logic.test.ts` pins this ranking. The NSIS drift guard
  covers only the `srt-win` Rust sources.

Session, per-command, worker, holder, plugin and bundled-process grants enter
through one filesystem policy admission function. On Windows its order is
**pin → check pinned → hand off pinned**. Handles resolve every existing
component. A grant follows supported links one hop at a time (at most 40) and
checks the resolved target; evidence refuses any reparse point. Ancestor handles
exclude write and delete sharing while final paths and file identities are read.
Machine-root checks, control-file deny derivation and private-helper overlap
checks consume the pinned canonical result. Policy composition retains those
literal grant objects; it never resolves an admitted grant again. Composed deny
rows follow the separate deny projection, preserving unprovable identities and
patterns without applying the grant pin or plain-path grammar. The manager receives
the same pinned grant objects alongside those deny rows, while
the direct ACL API receives string arrays whose reads validate the same component
identities. This validation runs in production as well as isolated tests.
Each composition expands leading `~` and supported profile environment references
once; stored settings retain the original diagnostic spelling.
Thus `~/x` protects the controls inside the actual home subtree on every platform,
and a Windows whole-home grant cannot evade a refusal by using `~` or `%USERPROFILE%`.

All four filesystem lists use that admission function. On POSIX, expansion that
introduces `*`, `?`, `[` or `]` is refused with `filesystem-expansion-glob`:
the runtime has no glob escape syntax, so expanded data cannot become a pattern.
Braces remain ordinary characters. Windows machine-root writes are refused at
this entry before narrowing or any native account lookup, including held grants.
The Windows grant grammar checks intermediate components and expansion prefixes.
Composed denies retain the deny projection's spelling and identity rules.

On Windows, grant lists are expanded once before runtime handoff; a new glob match created afterward receives no allow ACE from this wrap. Grant junctions and symlinks are followed, and the resolved target must pass every grant check (owner decision 2026-10-26, #253). By design, a grant target's own ACL is not checked: owner and DACL rules apply to policy evidence and private homes, not to arbitrary grant targets. Evidence refuses links and fails closed. Every pinned grant literal and canonical target must be a plain drive path: `X:\` followed by components that are not empty, `.` or `..`, do not end in a dot or space, and contain no control character, none of `<>:"/|?*%~`, and no reserved device name. UNC, device and `\\?\` grant forms are refused. The runtime normalizes each grant entry again, so its result must exactly match a checked spelling, with no case folding, before any existence check. A missing grant is dropped. A swap before pinning is resolved and checked like any other link; a replacement between pinning, policy checks and native handoff is refused by the retained identities. After the final identity validation, the native string API can still follow a later swap. Closing that native residual requires calls that consume held handles.

On Windows, only each deny target's own DACL is checked, so a child with its own broad allow beneath a private directory is not detected, as for write denies. Preceding deny ACEs are ignored, so a target can conservatively be classified as readable even when it is not. Evidence is tied to object identity and re-proven by a no-follow stat at each use; in-place ACL changes on the same object are not detected.
On Windows, an absent deny target outside every write grant is not stamped, while one a write grant can reach is still materialized and stamped so the sandbox cannot create it; machine-root rows retained by the policy filter remain eligible for stamping regardless of absence. Before adding a worker write grant, raw session and earlier-wrap denies plus the pending policy identify every overlapping obligation, including machine read rows and targets created after omission. An overlapping deny glob refuses the grant because a DACL cannot protect future matches. Native target DACLs determine existing deny strength; stamping unions that strength with the obligations so reusing the session holder cannot downgrade its earlier read protection. After stamping, even if it throws, native DACLs must show the sandbox SID's expected deny mask, subtree inheritance for directories, and parent delete-child protection. A missing or unverifiable target refuses the grant, as does any stamp failure; successful stamping alone proves nothing. Grant failures revoke only the grant holder. Worker release leaves session denies until teardown; placeholders remain. These are point-in-time checks: concurrent path or DACL changes and protected descendant DACLs remain limitations. An omitted target created outside write grants while a command is running is not denied until the next wrap or worker/session re-initialization.

Grant proof uses the shipped path helper's synchronous handle-based DACL mode.
It pins non-reparse path components and reads target and parent descriptors
from those handles. Only leading explicit deny ACEs count; inherited denies or
denies after an allow supply no proof. Obligation capture through native grant
and publication contains no await. An obligation revision and session/seal
check guard the effect boundary; asynchronous wraps recheck their captured
session and seal immediately before entering the native wrapper. Reset
invalidates admission before its first await.

A failed native deny verification seals the session against further wraps and
worker grants until reset. Confinement stays marked active so callers cannot
fall back to host execution. Previously issued commands are not revoked by this
check.

Isolation between plugins is a macOS and Linux property. There every wrap of
plugin-owned code — plugin child, delegated worker, bundled hook, bundled MCP
stdio server — refuses the plugin roots (`<AVE_HOME>/plugins`,
`<AVE_HOME>/agent-plugin-data`, `<AVE_HOME>/packages/agent-plugin`) and
re-allows only its own directories (`PerCommandFilesystem.denyPluginsRoot`).
On Windows every confined process, every plugin included, runs as the one
`srt-sandbox` account: the sandbox confines plugins against the host as
configured, not against each other. A plugin child and a delegated worker each
reach their own directories through a holder-PID ACL grant held for that
process's lifetime, and while it is held every confined process reaches them
too. Because `srt-win` stamps that ACE on whatever a path resolves to, junctions
followed, a grant names an outermost envelope root and never a path below one
that the plugin could re-point, containment is asked on the canonical,
case-folded form admission uses, and a chosen directory inside `data/` is
folded into `data/` (decision 66). A hard link the sandbox account could
already write attributes of inherits a grant on `data/`; one to a file it can
only read cannot be created (measured, decision 66). By owner decision (2026-10-10) third-party plugins run on Windows on those
terms, an accepted risk pending an ASRT per-plugin identity
(`docs/history/plugin-hostapi-protocol-migration.md` §9.8 A2, decision 64). Because
srt-win relays no stdin and delivers none of the spawn's environment, an `entry`
plugin child there runs under `cmd.exe` with `ELECTRON_RUN_AS_NODE` on the
command line, its environment in one argument and Node's symlink-preserving
flags, and speaks to the host over one loopback connection that both ends
authenticate, each proving it holds a nonce the child announced on stdout with a
proof bound to that connection (same document, §2.3, §2.4). A plugin worker, a bundled
hook and an MCP stdio server run through that same launch as a stdio relay: the
host sends the program, its arguments, its environment and its directory over
the authenticated connection, and the relay starts it with a real stdin fed from
the connection, its stdout and stderr carried by srt-win, and exits with its
code; each holds its own holder-PID grant for its lifetime. Nothing third-party
reaches the `cmd.exe` line, a batch file (`.cmd`/`.bat`, or a bare name such as
`npx` that only one answers) is refused with the reason, and a Windows sandboxed spawn that names neither the
relay nor `cmd.exe` is refused, because srt-win's PowerShell launch loses stdin,
environment and exit code alike.

A plugin root holds two state directories. `data/` is the plugin's own: its
confined child writes there. `storage/` beside it is host-only: the HostApi
`storage` surface and the webview bridge's `ui-storage/` operate there on the
plugin's behalf, and no confined process may write it on any platform — the
envelope derivation refuses a write grant that names it, lies inside it or
contains it, and the Windows holder grant is held to the same rule
(`writeGrantsReachingHostStorage`). A storage operation checks containment and
then issues a path-based syscall, and no platform offers a no-follow rule for
every component of every such call, so only a directory the child cannot write
keeps that syscall where the check looked. `plugin-storage-layout.ts` owns the
path; promotion and recovery carry `storage/` with `data/`. Storage written
before the directory existed is copied out of `data/` once at boot, before any
confined process runs, never through a link, and only keys at depth 2 or less
of 8 MiB or less (`migratePluginHostStorage`;
`docs/design/plugin-hostapi-protocol.md` decision 65).

Plugin read-relaxation is narrower than the host-shell capability. The
foreground plugin effect-boundary may replace a pre-exec ask only when
`hostClassifiesRisk` is enabled and
`isActiveSandboxFilesystemContainedForPluginEffects(tool)` returns true for
that exact tool. A process-global "sandbox active" signal is not sufficient.
The plugin effect provider requires a host-owned `Tool.workerId` and a matching
`pluginId/workerId` that the main process currently tracks as ASRT-wrapped.
Ordinary in-process plugin tools, degraded hosts, and sandbox-off hosts keep
the known-safe pre-exec ask path.

Every ASRT wrap carries an egress token as its `commandId`
(`src/permissions/egress-invocations.ts`): one per Bash or PowerShell tool
call, one per isolated conversation shell (for that PTY's lifetime), and
one per confined plugin process — plugin child, worker, bundled hook, bundled
MCP stdio server. The token is 16 random bytes, maps to its owner only while
the process lives, and is never written down. ASRT records each proxy refusal
under it; the deny monitor (`src/permissions/egress-deny-monitor.ts`),
subscribed at boot before the proxy starts, turns each
`deny network-outbound` (or `http-request`, `socks-tunnel`) line into one
sandbox audit row with an `egress_attempted, blocked: true` event and the
owner's identity, or `unattributed` for a key no live invocation holds. A
proxy deny line of an unexpected shape (ASRT's `malformed host` refusals keep
whatever host the process sent) still becomes a row, with the remainder as its
host, no port and the reason `unparsed deny line`. Host, method, URL and
reason are DLP-masked, since the confined process chooses them; rows are
neither sampled nor dropped, so their volume is bounded only by the refused
process's connection rate and lifetime. The shell tools append ASRT's
`<sandbox_violations>` block to their output so the model reads why a host
failed, and Settings → Permissions → Network lists the last 24 hours of
refusals from that audit channel.

The token is a label; what identifies an invocation to the policy is the
channel its connections arrive on (`src/permissions/egress-identity.ts`). On
macOS and Linux every wrap first opens its own proxy front end
(`SandboxManager.openInvocationListener`, part 3 of the carried 0.0.80 bun
patch): a loopback port that the wrap's Seatbelt profile alone may reach, or a
socket path bound into that wrap's bwrap in place of the shared bridge socket.
A connection that arrives there reaches the ask callback with
`identity: "listener"`, and the callback (`src/permissions/egress-ask.ts`)
denies anything that did not, so a token read off another process opens
nothing. On Linux every lane socket and every proxy backend socket lives in
one private 0700 directory, and each wrap mounts a tmpfs over that directory
and binds back only its own lane socket, so no wrap can see another's socket
even when `allowAllUnixSockets` lifts the AF_UNIX block (as registering a
plugin socket directory does). On macOS `allowAllUnixSockets` would expose the
shared bridge socket, so while it is set shell and extension identity is
`shared`. The proxy refuses a destination that is a proxy front end's port on
this host, so one invocation cannot hop onto another's listener. The
callback is asked in two phases (part 5 of the patch). The name phase comes
before anything is resolved or routed, so every refusal the name alone
decides (unattributed, a worker off its list, asks off, nobody to ask, a
reserved literal) costs no DNS query and no proxy lookup: the
proxy's lookup is the sandbox's only resolver, and a refused
`<data>.attacker.example` must not reach the zone's server. An interactive
approval card is shown by name, using the class implied by
the literal address or local-network name, otherwise provisionally `public`.
Its answer is held, not granted; grants are matched by origin and network class
in both phases. Only after that provisional allow is the destination name
resolved once, and refused when any address is
loopback, reserved or this host's; the resolved phase sees the addresses, an
answer given on a card for one class (say public) becomes a grant only when
the destination turned out to be that class (otherwise the card is shown
again with what it is), and the connection is pinned to them (a direct dial does not
resolve again; through an upstream HTTP(S) proxy the CONNECT names the
address, trying each in turn, not the name), so DNS rebinding cannot move it
afterwards. A name this host cannot resolve (owner decision 2026-10-19), and
a plain-HTTP request by name through an upstream (its absolute-form target
names the host, which the upstream resolves, so it cannot be pinned), is
refused without an upstream; through a remote upstream it is forwarded by name and the callback
is told `resolution: "upstream"`, which Ave treats as `unverified` (at most
This session, a card note that the proxy decides the address,
persistent grants ignored); through an upstream on this host (loopback,
`localhost`-style names, or one of this host's addresses, e.g. cntlm or px)
it is refused with a reason, unless the trusted `upstreamProxy.resolvesNames`
setting gives that upstream the remote treatment, which accepts the residual
risk that the local proxy resolves the name to this host after the check.

Where the upstream comes from (owner decision 2026-10-20) is the main-owned
`upstreamProxy` setting (Settings → Permissions → OS Tool Sandbox; written
only through the permissions `upstreamProxySet` channel, refused by
`settings:update`, absent from the renderer snapshot; manual credentials in
the secret store, bound to the proxy's scheme, canonical host and effective
port: sent only to it, and removed, with a notice, when any of those changes).
An explicitly written port is preserved before URL normalization; only an
omitted port defaults to 1080 for HTTP or 443 for HTTPS. A scheme-less proxy
URL means HTTP. "Use system settings" (the default) takes the app
process's own `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY` (either case,
lowercase first) when any is set, and otherwise the OS configuration through
Chromium's `session.resolveProxy` (macOS system settings, Windows
WinINET/WinHTTP, Linux environment/GNOME/KDE, PAC and WPAD); "Manual" is a
URL plus a bypass list; "Off" is direct. `NO_PROXY` and the manual bypass list
follow [current curl master `lib/proxy.c`](https://github.com/curl/curl/blob/master/lib/proxy.c):
comma-separated domains, IP literals and CIDR ranges, with optional spaces or tabs
around entries. Spaces alone do not separate entries. Older versions differ:
[curl 8.7.1 `lib/noproxy.c`](https://github.com/curl/curl/blob/curl-8_7_1/lib/noproxy.c)
accepts space-separated entries and has different IPv6 CIDR matching, including
`/0` and prefixes that end within a byte. A bare domain or
one leading dot matches the domain and its subdomains; `*.` has no wildcard
meaning. Only the raw complete value `*`, without surrounding whitespace,
bypasses everything, not a `*` token in a longer list. Entries do not support
`host:port`; IPv6 entries are unbracketed.
This host's own destinations remain direct under the separate local-routing
policy. Because a PAC script can answer
differently per destination and with a fallback list, the carried patch's
part 4 replaces ASRT's single static `parentProxy` with a route hook
(`SandboxManager.setParentProxyRouter`, implemented in
`src/permissions/upstream-proxy.ts`): asked once per destination decision
with the canonical host, port and scheme, after the name phase and before
the resolved phase; every
answered route is judged as above (a pinned name goes as its vetted literal,
an unresolvable name skips direct routes and untrusted proxies on this host,
a route naming one of the proxy's own listeners is dropped and every proxy
socket is checked against them), and the connection tries the kept routes in
order, handing over only on a connection failure: every upstream HTTP response
is final, including non-2xx. A non-2xx CONNECT answer refuses with
"upstream proxy refused the connection (HTTP <status>)"; a plain-HTTP response
is relayed unchanged except 407. Neither another address on the same route
nor a later proxy or DIRECT retries an HTTP response. A 407 refuses with
"upstream proxy requires authentication" (Basic
credentials from a `user:pass@` URL are sent; NTLM/Kerberos need a local
helper such as cntlm or px plus the `resolvesNames` opt-in, which covers a
proxy named in Settings or the environment and never one a PAC or WPAD answer
names, since that answer is network input). `resolveProxy` runs at most four
evaluations at once. SOCKS entries
are skipped with an `egress-route` audit row (ASRT has no SOCKS client); an
answer with nothing usable refuses, never falls back to direct. Answers are
cached per (scheme, host, port) for 45 s (Electron has no proxy-change
event); an upstream proxy settings write advances the routing generation, clears the cache
and closes every open sandbox connection (`closeAllInvocationConnections`,
direct ones included). Pending approval, DNS and route decisions capture that
generation and check it immediately before any direct or upstream dial,
including after asynchronous proxy preparation. A stale attempt replans its
routes under the current generation; an allowed decision is reused only for
the same destination class, and a changed class is asked again. A denial
remains final, and repeated configuration churn fails closed. Changes apply
without a restart and no tunnel outlives the setting that routed it.
Sandboxed processes see only Ave's per-invocation proxy in their
environment, never the upstream or its credentials. An ended
invocation's macOS port stays bound, refusing connections, for 30 minutes,
longer while its process group still runs, and its number is never reused. A wrap with `network.allowLocalBinding` is
refused, and Ave never sets it. The macOS profile also denies process-info on other processes and
the `kern.procargs` sysctls, and each non-PTY wrap starts in its own session
(node-pty already starts one), so a sandboxed process cannot read another
process's environment.
Every rule of the macOS profile folds the `subpath` and `literal` filters that
share a parent directory into one regex for that parent. The regex matches the
same paths, and sandbox-exec, which compiles the profile on every wrap, compiles
it several times faster.

To regenerate `patches/@anthropic-ai%2Fsandbox-runtime@0.0.80.patch`, save its
explanatory preamble (everything before the first `diff --git`) and run
`bun patch @anthropic-ai/sandbox-runtime@0.0.80`. Edit the installed package's
`dist`, save a copy outside the checkout for comparison, then run
`bun patch --commit node_modules/@anthropic-ai/sandbox-runtime`. Restore the
updated preamble ahead of the generated diff and run `bun install --lockfile-only`
to refresh or verify lockfile metadata for the final patch. In a disposable
clean checkout with the revised manifest, lockfile and patch, run
`bun install --frozen-lockfile`, then
`diff -r <saved-dist> node_modules/@anthropic-ai/sandbox-runtime/dist`;
no differences prove the patch reproduces the edited distribution.

ASRT runs non-strict with an empty `allowedDomains`, so the callback decides
every connection: a plugin worker reaches its own extension's declared
domains and the configured model endpoints, nothing else, and is never asked;
a Bash or PowerShell call reaches a host a grant covers, and otherwise
the person is asked on the approval dock with the shared decision row (owner
decisions 2026-10-25, five-choice network card and unified approval card):
Deny, Always deny (a user-global `Network(...)` deny rule), Allow once,
Allow for session (in memory; it ends when the conversation is deleted or the
app quits), Always allow in this project (persisted, keyed by the project root
of the call's working directory: the repository root when one is found, the
same root a project `Bash(...)` rule applies to) and Always allow everywhere
(persisted, global). `Network(<host>[:<port>])` host rules (a leading `*.`
matches subdomains) are consulted before grants: a deny rule refuses the
connection, an allow rule admits a public destination, and an ask rule skips
the grants. A host rule keeps the grant invariants: an allow rule decides a
connection only for a lifetime that request offers (a user rule where Always
is offered, a project rule where This project is, a session rule where This
session is), so a shared or session-strength connection identity is never
admitted by a persistent rule; deny and ask rules apply everywhere. Host rules
are shell-origin: an isolated terminal's connection never consults them and its
banner offers none. An address literal has no host rule, and a
`Network(...)` rule naming one is refused when it is parsed. An edited
wildcard host allow is saved with the same `wildcard-allow-sandboxed-only`
warning as a wildcard shell allow. The scope values on the wire and on disk are
`once`, `session`, `tab` (the retained internal terminal-lifetime scope), `project` and `always`; the earlier `conversation` and
`workspace` names are refused everywhere, except that a version-1 grant file's
`workspace` grants are migrated once: a grant made at its project root becomes
the `project` grant for that root, and one made in a subdirectory of a
repository is dropped (re-keying it on the root would widen it) and recorded as
an `egress-grant-migration` sandbox-audit row, so that host is asked again. The
file is written back as version 2 on the next change. "This session" choices
(network hosts, `Bash(<command>)` rules, exact approvals) end when the
conversation is deleted: deleting a root conversation ends them for it and its
sub-agents, and deleting a sub-agent session ends only that session's own
network hosts, since its rules and approvals belong to the root. A conversation's
isolated persistent PTY retains the terminal-origin egress approval path and
terminal-lifetime grants, keyed by its internal terminal identity rather than a
workspace host tab. Existing destination eligibility, one-connection allow-once
semantics and revocation apply. The legacy serialized `tab` scope ends with
that isolated shell; it is not host-tab read/write authority. The
[terminal policy](permission-policy-design.md#commands-typed-into-a-workspace-terminal)
owns the conversation lifecycle and private-host boundary. Every grant is bound to its origin (`shell` or
`terminal`) and destination network class (`public`, `local` or `unverified`),
for Allow once, session, tab, project and Always scopes. Matching,
listing, use tracking and revocation preserve both fields, so neither another
origin nor another class can reuse it. Settings shows the origin and preserves
the class when revoking. A replan to a
different class requires a fresh warning and decision before connecting.
Project roots are compared after `canonicalizePathForMatch`. The
connection is held while its approval card is pending and denied after 120 s
without an answer, or at once when the isolated PTY is released. Requests from
one internal terminal to one destination share the existing approval entry.
A main-owned terminal-to-conversation alias routes confined conversation egress
to the existing approval cards and follows that session's current attachment;
there is no separate host-terminal banner or dock filtering. The user's native
host shell gains no egress interception from this route.
`src/permissions/egress-grants.ts` holds the grants, the persistent ones in
`<AVE_HOME>/permissions/shell-egress-hosts.json`, revocable in Settings →
Permissions → Network. Stored grants without `network` match only
`public`; a valid recorded class is honored and an invalid explicit class is
rejected. Only `public` destinations are eligible for persistent grants
(Always allow in this project and Always allow everywhere); recording a class
does not extend that eligibility.
A background call nobody can answer, asks turned off
(`features.shellEgressAsk`), or an unreadable grant file is a refusal.
Destinations are classed by `egressDestinationNetwork()` on the host and every
address it resolved to, most restrictive first: link-local, cloud metadata,
unspecified, multicast and broadcast addresses are refused without asking;
loopback, `localhost`/`*.localhost`, local-network names (`*.local`,
`*.localdomain`, `*.home.arpa`, `*.internal`, `*.lan`), RFC1918, CGNAT, ULA
and site-local addresses are offered at most This session (a conversation's
isolated shell: while that shell runs), with a local-network warning on the card, and persistent grants
never apply to them. Only the desktop window
answers an egress ask; an answer from any other surface leaves it pending. Session and
tab grants are listed and revocable in Settings too, and revoking a grant closes the
connections it let through that are still open. Each decision, including a
refusal the proxy made before asking, writes an `egress-decision` sandbox audit
row. DNS, route-lookup, and connection failures return 502; timeouts return
504. They keep the connection closed and write an attributed `egress-failure`
row with the failure kind and response status, without a denial decision.
Policy refusals remain 403. Where `egressIdentityStrength() === "shared"` (the Windows shared proxy,
or macOS with `allowAllUnixSockets`), both new approvals and reused grants stop
at This session (a conversation's isolated shell: while that shell runs). Persistent grants remain stored
when the channel becomes shared, but cannot authorize it; they apply again
when the channel is strong. Grant lookup filters eligible scopes before
selecting the narrowest match.

`spawnWorker` is the only host primitive that can establish that worker-backed
plugin substrate. Workers on every platform talk to their plugin over their own
stdio (worker stdio control v1 or output-only, host protocol 5); none gets a socket
or a port. On Windows their filesystem access is
scoped through a per-worker holder PID ACL grant using ASRT's Windows
`grantWindowsAcl`/`revokeWindowsAcl` primitives, then the command is wrapped
through srt-win. The holder command must be launched through a pinned System32
binary and its lifecycle is part of the worker's confinement proof: if the
holder exits or errors, the host must revoke grants, unmark the worker, and
terminate the wrapped worker.

### Windows agent shells in Microsoft Execution Containers

By owner decision (2026-10-19, proxy-egress PR 9) a Bash or PowerShell tool
command on Windows runs in its own Microsoft Execution Containers (MXC)
BaseContainer where the host offers one. The shell path uses the MIT-licensed
`wxc-exec.exe` launcher from `@microsoft/mxc-sdk` 1.0.1 at
`<resources>/mxc/<arch>/wxc-exec.exe` (x64, arm64), staged at build time by
`scripts/fetch-mxc.mjs` against `src/permissions/mxc-launcher-pins.json` (the
npm tarball's sha512, each launcher's sha256). The extension process primitive
runs SDK operations in a dedicated supervisor under the packaged executable's
Node mode with `ELECTRON_RUN_AS_NODE=1`; the Electron RunAsNode fuse must remain
explicitly enabled in packaging configuration. The pinned packager reads this fuse
configuration globally. Only `runAsNode: true` is set, matching the runtime default;
every other fuse remains inherited, including newer unnamed fuse slots. The
packager applies fuse changes immediately before signing; the macOS path still
signs before notarization. A regression applies the installed fuse writer to a
copy of the pristine runtime fuse wire and requires every fuse value to remain
equal to its default. This global setting changes neither signing nor notarization
order on other platforms. Existing holders
are not routed to this primitive yet. SDK JS,
FFI addon and architecture-specific DLLs live under `app.asar.unpacked`.
Installed-byte pins cover SDK `dist` JavaScript, the FFI ESM entry chain and CJS
entries, locked nested `semver` JavaScript, PTY JavaScript/prebuilds, and the selected
bootstrap addon. Import-condition resolution must match those pinned roots; tests
record the static SDK spawn/probe import graph without executing native code.
This does not claim coverage of arbitrary computed dynamic imports.

Package manifests use the required semantic pins for `name`, `version`, `main`, `exports`, `type` and `imports`, including field absence and condition declaration order; descriptive/build metadata may be removed by packaging. Their raw source hashes remain archive/staging audit inputs. Every JavaScript, addon, DLL and executable entry still requires its exact SHA-256. The locked nested semver tree is copied explicitly through Windows extra resources into its pinned unpacked path because dependency collection can hoist it. PTY `.pdb` files are a declared debug-symbol category, excluded from runtime pins and packages because they are not loaded; no executable hash is skipped. The `node-addon-api` tree used to build PTY prebuilds is a declared `build-only-headers` category, excluded explicitly from package files and runtime pins at both its installed nested path and its hoisted root path. PTY runtime JavaScript loads prebuilt addons and does not import those headers or their build tools; before-pack verification does not require unused header bytes.

Empty `node-pty/.bun-tag-<16 lowercase hex digits>` patch-install markers are declared package-manager bookkeeping and are removed before packaged inventory verification. Nonempty or malformed markers remain unexpected payloads and fail verification.

Before-pack source verification also requires the original package-manifest byte hashes; semantic verification applies to normalized packaged manifests. `bun run update:mxc-pins` regenerates file hashes, semantic manifest fields and both native architectures deterministically from installed sources. `bun run check:mxc-pins` (`node scripts/update-mxc-pins.mjs --check`) fails on drift without rewriting pins. Missing optional target addons are staged from their separately verified archives into temporary sources and cleaned up; `--no-download` requires all sources locally. Archive, launcher and license trust anchors remain explicit review inputs. The required `build-and-test` CI job checks the generated pins and runs `check:mxc-packaging` for x64 and arm64, sharing a lock-keyed Windows runtime ZIP cache. The Windows permission job also runs both packaging targets with a cached runtime download, so the native-host collector path is covered. Successful packaging checks delete their owned temporary trees, failures retain and report the exact path. Strict packaged inventory checks include the FFI, PTY and nested semver trees; unknown scripts, manifests, binaries and redirects fail closed. Retained source/declaration/license allowances are scoped by path and extension. Unused PTY local build/source directories and non-target prebuilds are declared packaging exclusions; unknown selected-target files remain available for rejection.

The packaging regression uses the production dependency declarations and installed dependency graph, with production build configuration and the same locked dependency collector. A reduced graph with added root dependencies is insufficient: hoisting can keep a nested build dependency in that graph while moving it to the root in the application graph. The installed collector reproduces this relocation on macOS too; it is not established as an operating-system-specific omission. The check requires an installed nested PTY header tree before collection and its absence, including the hoisted root copy, in the assembled payload. Diagnostic-only entry/output, unsigned packaging and the focused SDK finalizer do not replace the full application hook or execute native code.

The nested runtime-pin audit has two results: `node-pty/node_modules/node-addon-api` is build-only and excluded, while `@microsoft/mxc-sdk/node_modules/semver` is required at runtime and copied through explicit extra resources before exact resolution, semantic manifest and byte verification. There are no nested `node_modules` pins under `koffi`; its selected optional addon is staged at its pinned top-level package path. Installation-only nested command shims are pruned as described below.

The installed SDK inventory rejects unknown files. Its allowed archive extras
are declarations/source maps, README/license text, generated native declarations,
provenance metadata and the explicit unused backend filename set in the integrity
verifier. Nested runtime dependency files are checked against their pins; the
locked semver package additionally permits its LICENSE, README and `range.bnf`.
Named semver command shims under nested `.bin` are installation-only extras;
symlinks must target the pinned command, and packaging excludes/prunes that
directory. Unused native backends are removed before packaging.
Before any native require the supervisor verifies these pins and the
whole selected native directories plus the packaged executable/runtime DLL inventory,
then loads only the verified bootstrap addon. The inventory is recorded after
assembly and signing, and all non-system loaded modules must match it or the SDK pins.
That trusted addon immediately restricts this process's DLL search to system
and verified native directories before SDK import or native container loading.
Every enumerated module is audited; only the selected-first diagnostic list is bounded, with
`nativeModuleCount` and `nativeModulesTruncated` recording omitted paths. A large
valid snapshot does not disable the process.
Loaded paths and allowlist paths, including the actual system directory, are
realpath-resolved and normalized identically before admission. Only pinned files
or modules under that system directory are admitted. WinSxS and injected EDR/IME
modules elsewhere fail closed with `MxcIntegrityError`; signatures alone do not
authorize them. This compatibility policy remains native-unverified. Startup
refuses loader overrides, tamper and unexpected modules without a backend retry.
The trust model allows user-owned installation
contents and does not protect against the same user racing replacement after
verification. The current per-machine installer setting is unchanged and is not
required by this trust premise. See [the bootstrap and lifetime contract](../design/windows-extensions-mxc.md#placement-and-dll-loading).
A private inherited key/liveness pipe and direction-authenticated bounded frames
connect main and supervisor; EOF starts teardown even while control input is blocked.
Startup cancellation sends a stop frame while retaining liveness through native
process observation, so cancellation cannot imitate owner loss and release the
process pin before duplication. A failed stop-frame send closes liveness for
EOF-driven teardown. After readiness has confirmed observation, disposal closes
liveness immediately to interrupt a backpressured control reader. Forced
termination waits for the cleanup deadline.
The supervisor explicitly clears inheritance on fd 3 as well as all three control
standard handles, resolving fd 3 through the running runtime’s `uv_get_osfhandle`
export; unavailable protection is a capability error. The supervisor retains a
non-inherited kill-on-close job without breakaway permission before SDK spawn.
Terminal receipts follow stream drain, native wait and disposal. After spawn resolves, the supervisor retains a non-inheritable query/synchronize process handle and sends its PID and handle in an authenticated `native-created` receipt. Main acknowledges only after its synchronous lifecycle observer can duplicate the process object; the supervisor retains its handle through that acknowledgement, including during cancellation. The packaged diagnostic main retains its duplicate until the external controller has checked the object and can independently observe terminal signaling. No lifetime job handle is duplicated. Missing acknowledgements remain bounded by owner-EOF teardown and its cleanup watchdog. Missing receipts,
crashes or cleanup deadlines after possible native creation remain failures with
unverified termination. Authenticated failures before native creation preserve
integrity, capability-unavailable, contract or supervisor-lost error types.
The packaged diagnostic entry requires the explicit build-time flag
`AVE_MXC_VERIFICATION_BUILD=1`; normal builds omit it and remove stale diagnostic
output, and every platform’s packaging hook checks the build record and files.
Actual packaged imports, DLL paths and job/PSEC descendant cleanup require native
verification on x64 and arm64 before readiness or holder activation. Each shell
command spawns `wxc-exec.exe --config-base64 <request>`
from the launcher's own directory (`mxc-windows.ts`, `mxc-shell-launch.ts`);
no administrator rights or UAC prompt are needed per run. Installation follows
the existing per-machine installer configuration.

The SDK payload includes pinned `mxc_ffi.dll` and `wslcsdk.dll`; packaged native
loading must establish the dynamic dependency inventory on each architecture.
The remaining backend executables are excluded because Ave never takes their
paths: `winhttp-proxy-shim.exe` is the elevated, UAC-raising proxy fallback of
the AppContainer tier, which MXC refuses for `runtimeConfig.networkProxy` with
egress deny + ingress allow (the only shape Ave sends; boot also requires the
dry run to select `base-container`); `plm.exe` is the elevated tracing helper
behind `telemetry`, which Ave never enables; the daemon and host-prep binaries
serve the WSL-container, Windows Sandbox, isolation-session
and AppContainer+DACL backends. Every PR 9 measurement ran the launcher alone
in its directory.

- **Detection.** On the boot path the launcher's sha256 must match the pin,
  `--probe` must report the `base-container` tier, and `--dry-run` of a request
  shaped like a real one (loopback proxy, default-deny egress, no DACL
  fallback) must pass. ASRT then starts as if MXC were available, and MXC is
  `checking`: after boot, off the critical path, System32 Windows PowerShell
  5.1 must start (`exit 0`) in a real container of that shape (reduced
  caller-owned environment, proxy mode; a cold start can take tens of
  seconds). Until it settles, shells take the approved-host route and Settings
  says the check is running; when it passes the record switches to MXC, unless
  something re-recorded it meanwhile. Detection reads what the launcher does,
  not the build number: MXC 1.0.1 no longer requires PSEC 1.1 for an
  identity-less loopback proxy (the launcher queries host support and the
  directions depend on the Windows build), so the exact request must still
  validate and start. Any failure
  leaves the shells on the approved-host route with its
  reason in Settings (a proxy-only boot keeps its proxy). A PowerShell start that
  fails with `STATUS_DLL_INIT_FAILED` (`0xC0000142`), which a non-interactive
  session such as SSH causes, is reported as `unverified-session`, not as MXC.
- **Integrity.** Detection hashes the launcher at boot, and the first command
  hashes it again before its launch; that result is cached for the process. A
  mismatch at boot leaves the shells off MXC (`launcher-mismatch`); at launch
  it fails the command closed. This assumes the per-machine installer
  (`nsis.perMachine`): the file lives where only administrators can write, so
  the signed-in user cannot swap it after the check. A source checkout's
  `resources/` is user-writable; that is a developer setup.
- **Boot plan** (`windows-sandbox-plan.ts`). MXC and srt-win are independent.
  With MXC, shells run in containers whether or not srt-win is installed;
  without srt-win, ASRT starts as the proxy only (`windows.externalConfinement`,
  patch part 3, which also skips the srt-win dependency check `initialize()`
  runs first), the process-wide capability confines nothing, and extensions
  run unconfined with a boot warning. Measured on a host without srt-win: the
  patched proxy starts, an srt-win wrap is refused, a container reaches an
  allowed host through its listener and the proxy, and a refused host is
  recorded under that invocation's token only. Without MXC, shells keep the
  approved host route. Without either, the gate degrades as before. The
  persistent conversation PTY never runs in MXC (its background descendants
  outlive individual commands), and reads only the process-wide
  capability.
- **Filesystem.** The per-command ASRT lists are ranked for MXC
  (`rankMxcFilesystem`): the protected read floor drops grants not under a
  pierce, a write grant under a `denyWrite` path becomes read-only, a deny
  strictly inside a grant becomes an explicit `denied` entry when the path
  exists, and grants that do not exist are dropped. Measured: a more specific
  grant wins over a denied parent, a missing `denied` file path still blocks its
  creation, and a missing `readonly` directory does not block its creation, so
  a `denyWrite` path that does not exist is written as `denied`.
  Missing nested denies are raised to the first missing component strictly
  inside a writable grant; raising onto a grant root or outside all writable
  grants fails closed. The shell cannot create that missing directory during
  this spawn. Denies are recomputed each spawn, restoring precise entries once
  it exists; an approved file tool can still create the directory.
- **Policy transport.** Requests that exceed the inline command-line budget
  use a random 128-bit named pipe served by the existing path-kind helper.
  The helper has two host-only roles: path classification/facts and policy
  delivery. Both use the same packaged-resource resolver, never PATH lookup.
  Policy bytes arrive over private stdin. The pipe's protected descriptor
  grants access only to the current user; the pipe rejects remote clients,
  and its first instance must be new. Four instances fill the fixed instance limit
  before readiness, leaving listeners available during PID binding and the
  launcher's back-to-back opens. Each connection's kernel-reported PID must
  match the spawned launcher, whose process handle remains open during
  delivery. Impostors receive no policy and consume none of the two reads;
  the authenticated-read budget is atomic across all instances.
  Message-type instances retain byte-read mode and send a zero-length message
  after the payload drains, giving read-to-end clients a clean EOF without
  closing an instance handle. A discard-read loop over duplex access waits for
  the client to close before disconnect; client writes are discarded and cannot change policy bytes.
  The delivery deadline and process teardown also bound blocked I/O and
  clients that never close. All four handles remain reserved until teardown.
  Spawn failure, owner EOF, release and the bounded delivery deadline close
  the server; teardown waits for helper close, and delivery failure also
  terminates a bound launcher.
- **Outbound connections and identity.** Each command gets its own loopback
  proxy listener (`egress-invocation-listener.ts`). The container's only
  outbound connection path is that port: MXC's per-container WFP filter, with
  `egress.default: "deny"` and `hostLoopback: "allow"`. The listener forwards
  to ASRT's proxy and stamps the command's egress token on every request it
  forwards, replacing any `Proxy-Authorization` the client sent, so refusals
  are attributed to the command that made them. It refuses loopback and
  unspecified destinations in any numeric spelling, IPv4-mapped and
  IPv4-compatible IPv6 included. Measured on Windows 11 26H2 (build 26300): a
  container reached its own port, and could not reach another command's port,
  another loopback listener, `localhost` or an external address directly
  (`1.1.1.1:443`, `8.8.8.8:53`); a forged identity was replaced by the
  listener's; a container could not terminate a host process of the same user;
  and when its process timeout fires or `wxc-exec.exe` is killed, every process
  in the container ends with it. Shell egress identity is therefore
  `kernel-channel`; extension identity stays `shared`.
  `egressGrantScopesFor` applies `maxEgressGrantScope` (`kernel-channel` →
  `always`, `shared` → `conversation`) to both approval choices and grant
  reuse. Origin and destination class further limit the scopes; terminal
  tabs and extensions keep their own policy.
- **DNS is not confined.** Name resolution goes through the host's DNS client
  service, outside the container's WFP filter: inside a container
  `example.com` resolved and an unknown name came back NXDOMAIN (measured), so
  the query left the host. A command can therefore carry data out to an
  external authoritative DNS server by looking up names it chooses under a
  domain that server answers for, without touching the proxy: an exfiltration
  channel the proxy never sees. Settings says so.
- **Inbound.** Proxy mode requires `ingress.default: "allow"`, which grants
  the container `privateNetworkClientServer`, and MXC documents that its proxy
  mapping does not complete the host-loopback ingress contract. Measured with
  Windows Firewall on and its default inbound action: a container could bind a
  listener, and no connection reached it from the host's loopback, LAN, WSL or
  Tailscale addresses, from another machine, or from another container. That
  rests on the firewall's default inbound block, not on Ave's request.
- **UI.** Containers run with `ui.disable: false` (PowerShell 5.1 does not
  start without Win32k), clipboard `none` and input injection off. A contained
  process can still open windows on the user's desktop and so could draw a
  fake dialog; MXC's docs call this "not the lockdown the schema's default
  implies". A window from a shell command is not trusted UI.
- **Shells.** PowerShell runs as System32 Windows PowerShell 5.1 with
  `-EncodedCommand`. Git Bash cannot start in a container: MSYS2 is denied the
  named-object directory it creates at startup (`0xC0000022`, in every
  session), so a sandboxed Bash command is refused with guidance to use the
  PowerShell tool or an approved host run, and the shell-environment prompt
  tells the model the same. Inside a container `cmd.exe` answers "Access is
  denied" for an unquoted absolute program path (`C:\Windows\System32\whoami.exe`,
  any casing) while the quoted path and a bare name found on `PATH` run
  (measured); the PowerShell launch quotes its path and is started by the
  launcher itself, not by `cmd.exe`. .NET Framework's `Invoke-WebRequest`
  ignores the injected `HTTP(S)_PROXY` variables and fails closed.
- **Settings.** Permissions shows the substrate chosen for shells and
  extensions, the MXC unavailable reason with the Windows build, the Bash
  limit, the DNS channel, and that extensions share one proxy identity.
- **Extension disclosure (row 6).** The Permissions card renders the
  extension state from `SandboxWindowsSubstrateInfo.extensionPlan`, never from
  `extensions` alone: `checking` and `rejected` say starts are refused and that
  nothing runs unconfined; `fallback` names srt-win 0.0.80 under one shared
  account and its reason; `unavailable` and `off` say extensions are not
  confined. Every closed reason maps to a catalog key. A ready MXC plan is
  described as a selection, not proof that a process runs contained (a
  plugin's Doctor card shows its own `windows-mxc` confinement, labelled
  "Windows container (MXC)"). Only that selection lists what a container does
  not hide or block: egress only through the holder's own proxy endpoint, whose
  owner Windows does not verify (D2); loopback requested in both directions,
  inbound left to Windows Firewall, DNS through the host resolver; untrusted
  windows with clipboard and input injection off (D3); ancestor
  query/enumerate grants that expose names and metadata, cascading into nested
  folders, including profile and `AVE_HOME` sibling names and other plugin IDs
  (peer-measured `descendantEnumeration: visible`); the effective temp in the
  AppContainer profile under the staging home; DLL search from cwd/PATH and
  holder-writable folders that the host does not harden; Bash hooks refused in
  a container (D4); `NODE_OPTIONS`/`NODE_PATH` configurations refused; and the
  binary MCP reviewer marker that does not name the backend. The chat input's
  sandbox badge adds an extension warning when extension confinement was
  requested and the plan is not `ready`, even while shells are healthy; it
  shows nothing for a ready or unrequested plan. Holder and lifecycle refusals
  (`executable-not-admissible`, `holder-workspace-busy`, `bash-incompatible`,
  `holder-environment-refused`, `holder-quarantined`,
  `worker-transport-unsupported`, `native-entry-required`,
  `extension-readiness-refused`, `plugin-child-termination-unverified`,
  `plugin-lifecycle-quarantined`, and the hook's `hook-settle-deadline` and
  `hook-termination-unverified`) are localized on the host and end with their
  stable code. Hook denies and MCP rows carry that text. A plugin's Doctor
  detail carries it when the refusal is raised by the factory that admits and
  spawns the child (`native-entry-required`, `worker-transport-unsupported`,
  `extension-readiness-refused`, `plugin-child-termination-unverified`); other
  factory and start errors keep the generic Doctor text, since a start failure
  is a child RPC error and may carry paths. A quarantined MCP server's row
  (`McpServerState.containedQuarantined`) says reconnect is blocked until Ave
  restarts. A quarantined plugin's card (`lifecycleQuarantined`) says it cannot
  restart until Ave restarts, and adds that its contained process keeps the
  folder access it started with only when `grantsRetained` is true, i.e. a
  quarantined sandbox grant incarnation is still registered (stop, drain and
  startup quarantines hold no quarantined grant incarnation). A folder removal whose revocation did not
  finish (`cleanupPending`) reports that as status text, never a confirmation,
  because the user performed the removal. The MCP tab re-reads server state
  when the window regains focus or becomes visible.

Not covered: plugin workers stay on srt-win. MXC's proxy mode forbids direct
egress rules, so a loopback worker channel cannot reach a container; host
protocol 5 gives workers stdio control instead, and the container worker adapter
follows it. Windows PowerShell 5.1 and Node inside a container start only in an
interactive session: in the SSH session-0 window station both fail with
`0xC0000142`, which detection reports as `unverified-session`. An
interactive-session probe (2026-10-16) ran both with `ui.disable: false`, which
the containers use. The PR 9 measurements ran `cmd.exe`, `curl.exe` and a
native probe from session 0 through the same request builder and listener;
the PowerShell 5.1 launch itself awaits an interactive-session run (owner
checklist in PR #22).

## Security And Audit

Security-sensitive areas are intentionally centralized:

- `src/permissions` for policy and approval decisions;
- `src/audit` for durable audit records;
- `src/ipc` and `src/preload` for process boundary contracts;
- `src/boot` for startup wiring and policy initialization;
- tool executor and sandbox helpers for runtime enforcement.

Changes spanning these areas merit proportionate cross-cutting review. That
review is advisory, never a merge gate.

### Windows object ownership

An elevated Windows token usually has `BUILTIN\Administrators` (`S-1-5-32-544`)
as its default owner, so a file or directory the app creates is owned by that
group rather than by the user. Admission (`assertCodexLocations` in
`src/main/codex-executable-location.ts`) treats owners in two ways:

1. **Inside a private root, every component must be owned by the current
   user.** A private root is a directory admitted as `private-directory`: the
   subscription runtime directories, and the `executable-`, `artifact-` and
   `probe-` directories and copies made in them. Ownership there is
   established only through `claimPrivateOwnership`, and through
   `createPrivateObjects`, `createPrivateDirectories`,
   `createPrivateDirectory` and `createPrivateTempDirectory`, which create
   objects and then claim them. A claim asks the resident ACL host to read
   each owner on the path object itself, without following a reparse point:
   - an object the user already owns is kept, without asking for
     `WRITE_OWNER`;
   - an object owned by `S-1-5-32-544` is given to the user, on a handle that
     re-reads the owner before it sets it. For a non-reparse directory, that
     same write sets a protected owner-only DACL with inheritable full control;
     files and reparse points use an ownership-only write;
   - an object with any other owner refuses its request, and nothing in that
     request changes. A claim is sent in requests of at most 128 paths and
     24,576 characters of JSON-encoded paths. When it spans several requests,
     the ones already answered keep the owners they set. A refusal still fails
     the whole claim.
   The reply must then show the user as every object's owner. When a claim
   fails, a creating helper removes what it made. The ephemeral `executable-`,
   `artifact-` and `probe-` directories are created and claimed per run. The
   ten persistent `subscription-runtimes` directories are claimed every time
   the subscription service starts. One that an earlier elevated run left
   owned by `S-1-5-32-544` becomes the user's again; one owned by another
   account refuses start and is left as it is.
2. **Outside a private root, the owner must be the current user or a trusted
   system principal.** This covers a private root's ancestors (among them
   `AVE_HOME` and `subscription-runtimes`, which admission does not claim) and an executable's location. The trusted principals are SYSTEM
   (`S-1-5-18`), `S-1-5-32-544` and TrustedInstaller. Admission also accepts
   the sandbox principals and capability SIDs it identifies. This does not
   depend on the token's default owner. Write access there is judged by the
   access entries, not by the owner.

Two other places create or protect owner-sensitive objects themselves, each
with its own owner rule:

- **The Windows sandbox helper copy is created with its final security
  descriptor.** `prepareSrtWinExecutable` in
  `src/permissions/srt-win-integrity.ts` picks a random, unpublished
  `%TEMP%/ave-srt-win-<random>/bin/srt-win.exe` path. One PowerShell step creates
  both directories with the token user as owner and a protected DACL: full control for the user,
  read and execute for SYSTEM, `S-1-5-32-544` and `S-1-5-32-545`. Anything
  already at either directory path, a link included, refuses creation. The empty image and
  the owner marker are then created new inside `bin`, each with its own
  descriptor, and each owner is read on the handle that created the file. No
  step changes the owner or DACL of an object that already exists. The image's
  bytes are written only after that step. If it fails, the step removes what it
  made; a later failure removes the copy without following a link.
  The write-deny target is `bin`, so its parent's inheritable delete-child deny
  lands on the private outer directory, never `%TEMP%`. Grants inside or writable
  grants covering that outer directory are refused. Session reset or holder
  release removes the deny when its final hold ends. A dead holder leaves its
  ACE until a later native ACL operation prunes its tracked hold.
  The session reset spawns this copy to revoke and restore the session's ACEs.
  The quit sequences (`runAppShutdownCleanup` on a clean, failed or timed-out
  quit, and `runIncompleteBootShutdown`) await `releaseAsrtSandboxForExit` after
  their confined children are down and before the host closes. The release
  follows srt-win's own outcome (carried ASRT patch part 12). It fails when
  srt-win did not run, exited non-zero (srt-win leaves a path it could not
  release out of its JSON), or answered a status outside its `AceRelease` set.
  The quit is then `failed` and the runtime keeps the session for a retry.
  `revoked`, `stillHeld`, `downgraded`, `relocated` and `noRow` are completed
  releases, as are `restored` and `alreadyOriginal`. `mismatch` and `missing`
  mean srt-win already dropped the holder row, so a retry would change nothing. They do not fail the quit; Ave logs
  their counts per step, without paths. A mismatched object's ACE is left as
  it was, so a deny there stays fail-closed, and the next boot's ACL recovery
  handles leftovers.
  A plugin or worker grant release is judged by the same status sets and exit
  code. An unconfirmed one seals the session against further confinement until
  the quit reset (in practice, until restart); confined children already
  running are not stopped.
  The copy's `exit` handler, registered at import and so run before the
  runtime's own, removes the copy only after a successful release.
  Otherwise it keeps the copy and writes one line to stderr, since the file log
  is closed by then. The runtime's `exit` handler then retries the release with
  the copy still present, the next boot's sweep removes the copy, and ACL
  recovery remains the fallback for a crash.
  That recovery runs as `srt-win acl recover --json` (carried ASRT patch part
  13) at the next initialize that starts an srt-win session. It does not run
  on the Windows proxy-only path (`windows.externalConfinement`), which sets
  up no session ACLs. Every srt-win acl command runs the same recovery, so
  when another live Ave process's acl command recovered first, this run
  reports 0. The counts went to that process instead, and they reach its log
  only when its own initialize recover found them. Ave logs the counts,
  without paths, at INFO when it pruned a dead holder or revoked an ACE. It also warns when a previous
  session's ACEs had to be revoked, so a crash leftover is visible without
  `SRT_DEBUG`.
  Some exits skip the quit sequences and rely on that `exit` handler path:
  `--plugin-smoke` ends with `app.exit()`, and a desktop GUI boot failure quits
  before services exist, where `before-quit` returns early.
  Signals: the headless host claims SIGINT and SIGTERM
  (`claimAsrtSignalRelease`) before the runtime initializes, so the runtime
  registers no signal reset and the host's handler runs the quit sequence.
  While that cleanup runs, the host keeps a listener that only reports
  "shutdown already in progress", so a repeated signal cannot end the process
  before the release; without a listener the process would end with no `exit`
  event at all.
  In the desktop app the runtime's own signal handler still resets it as soon
  as the signal arrives, before children are drained. Any later reset, including
  the one in a quit sequence, finds no ACL session left to release.
  The stale-copy sweep checks both directory owners and DACLs for the new layout,
  and also accepts the old single-level layout with its original marker checks.
  It deletes only `srt-win.exe` and `owner.json`, then their empty directories,
  without recursion. A sandbox-account ACE found on the temporary root emits
  `srt-win-temp-root-acl-owner-action-required`; the sweep never edits that ACL.
  Any remaining legacy ACE requires owner-approved inspection and repair of the
  exact explicit ACE or its inheritance source, with active holders accounted for.
- **Private storage boundaries are protected at creation.**
  On Windows, boot creates `AVE_HOME` and the `secrets`,
  `subscription-runtimes`, `keys`, `certs`, `config` and `runtime` boundaries with
  `O:<user>D:P(A;OICI;FA;;;<user>)`, using `NtCreateFile` with
  `OBJ_DONT_REPARSE` relative to a pinned directory handle.
  - `runtime` holds uv, the Python installs, the venvs and the uv cache.
    Repair never copies into it: a nonconforming `runtime` is set aside
    for deletion and created empty, and its contents are rebuilt from the
    plugin lockfiles when a plugin next needs them. Until a rebuild
    succeeds, the plugin reports "Python runtime rebuild needed" and does
    not start. There is no offline fallback to older contents.
  - No sandbox grant names `runtime` itself, so a grant entry left by a
    crash never lands on the boundary's own DACL. The sandbox account
    crosses the owner-only boundary through bypass-traverse.
    - A bundled program inside `runtime` (an MCP server or hook) is granted
      read on the children it needs: `runtime\uv`, or its env root's
      `venv` and `python`.
    - A plugin's `hostDirectory: ["runtime"]` declaration grants read on
      `runtime/python-envs` and `runtime/uv`, and the workers it delegates
      map onto those roots.
    - A writer that would create a runtime child (uv materialization,
      Python setup, a plugin child's envelope) first checks that boot's
      boundary is present and, on Windows, owner-only. It never recreates
      a moved one; a restart does.
  - Off Windows, boot sets `config` and `runtime` to 0700 on every start,
    through a no-follow handle.
  The helper is the first creator of the home. A plain `mkdir` would leave an
  inherited DACL, which the helper's create-or-open keeps and RootSafe refuses.
  Mutation and repair happen only under the host-instance lock.
  Every process start runs `createAveHomeIfAbsent` in `ensureWorkspaceCwd`, its
  first home write, before the lock. If the home is missing, that step only
  creates it, with the owner-only descriptor, then reads RootSafe back.
  It does no repair and no runtime-root claim, and it seals nothing.
  An existing home spawns nothing. If the create fails, the start writes nothing
  under AVE_HOME. It anchors cwd, which is the default workspace root, in a fresh
  empty `ave-workspace-*` directory under the OS temp directory. That is never the
  temp root itself and never AVE_HOME. mkdtemp inherits what the temp directory
  grants, so the start verifies the directory with the same private-temp check
  as the scratch directory (`verifyPrivateTempDir`): a real directory, not a
  link, owned by this account and, off Windows, closed to other accounts. On
  Windows that check relies on the per-user temp DACL, as the scratch directory
  does. If the check fails, the start refuses with a configuration error and
  never runs with a foreign-writable workspace. On exit the directory is removed
  only while it is still empty, never recursively. Boot then degrades as for any
  home failure.
  `bootstrap()`, under the lock, runs the full protection and seals the result.
  RootSafe, OwnerOnly, the extra-principal list and the configuration read
  verification evaluate allow entries only. A deny entry never grants access,
  so it cannot let another principal in. srt-win confines its sandbox account
  with them: at init it stamps an inheritable FILE_DELETE_CHILD deny on the
  home root (the parent of each denied home path) and a deny on each denied
  path, `config` among them, and removes them at quit. Ave never names such an
  entry in its `/remove` guidance. It does not rewrite one away from a root, an
  owner-only boundary or the workspace: the narrow root repair below refuses a
  root with an explicit deny, Repair leaves an owner-only boundary as it is, and
  the workspace rewrite keeps an inherited deny. A boundary Repair recreates, or
  a runtime root it claims from Administrators, starts as `D:P` owner-only.
  Under the lock, a root is repaired only in one narrow shape: the shape a plain
  mkdir under a profile left before homes were created this way. The repair sets
  `D:P(A;OICI;FA;;;<user>)` on the pinned home handle and verifies it through the
  unchanged RootSafe and OwnerOnly checks. Every one of these must hold:
  - the root is owned by the token user (an Administrators-owned root never
    qualifies, even elevated)
  - it is not a link
  - its DACL is unprotected
  - every non-owner entry is inherited, and is for SYSTEM or Administrators
    (an inherited Users, Authenticated Users, Everyone, CREATOR OWNER, domain
    group or other-user entry is refused)
  - the user has an entry
  The root repair writes only the root's own DACL, with
  NtSetSecurityObject, which reaches no child. SetSecurityInfo, used before,
  also propagated into existing children. In native run 4 that propagation
  turned the workspace's stale inherited SYSTEM and Administrators entries
  into explicit ones, before any other writer ran. Existing children keep
  their stale inherited SYSTEM, Administrators and user entries. Ave leaves
  them: only those two principals can remain, and they hold backup and
  take-ownership rights over the volume anyway. A tree walk would cost boot
  time in proportion to the home's size. The boundary subdirectories are
  protected and checked on every boot by Repair and OwnerOnly. The one
  exception is `workspace`: the cwd, the default workspace root and the
  in-project auto-write scope.
  Every boot whose root passes RootSafe checks the workspace on a no-reparse
  handle, whether or not that boot repaired the root. The workspace is the
  process's own cwd, so the handle is opened for READ_CONTROL, WRITE_DAC,
  read-attributes and SYNCHRONIZE with full sharing. A request that could
  include DELETE is a sharing violation against the cwd handle. A
  workspace that cannot be opened is reported as a diagnostic, never
  treated as clean. If its inherited allow
  entries are anything other than the single user entry a protected root
  passes down, Ave rewrites only that directory's own DACL: its explicit
  entries and inherited denies in order, then that entry. It then reads the result back.
  Because the check runs on every boot, a boot whose rewrite failed is
  retried. That boot was refused with no repairs, and the root may already
  be `D:P` owner-only. The same holds when the request times out.
  A link, a protected DACL, a foreign owner, or a workspace that cannot be
  opened or read is left as it is. A write that fails, or a read-back that
  does not match, refuses the boot.
  After protection, the workspace's own entries are read. An explicit or
  inherited allow that grants write to any principal other than the user,
  SYSTEM or Administrators is a workspace extra principal. The boot is
  refused, and Settings names the principal and shows `icacls
  "<workspace>" /remove *<sid>` for each explicit one. The command does not
  drop the workspace's inheritance. A foreign read-only entry is reported
  as a diagnostic only.
  Any other root is refused. Settings then shows the exact `icacls` command. It
  drops inheritance, then removes every grant and deny of each explicit extra
  principal (`/remove *<sid>`).
  The boundary list is checked against the sensitive-path table. The first
  protected boot commits `config` with defaults, never with root content: root
  settings, policy and secrets are unverified, so only the closed restriction
  fields (`permissions.blockReadsOutsideWorkingDirectories` and `managed` when
  `true`) carry into the default documents, and secrets never do. The commit
  stages each absent document inside the protected directory, writes a fresh
  `config/.ave-config-sources.json` (`{}`) and a fresh home content trust
  manifest, then flushes and atomically renames `config/.ave-config-migrated`.
  Root files are then moved aside. Both path owners use the root until commit.
  The holder of the shared host-instance lock migrates, whether desktop or
  headless. Execution-mode and child processes without that lock only resolve
  the current on-disk layout.
  A refused home is never migrated, and its root is not trusted. If an
  earlier verified boot committed `config/`, the refused boot keeps reading
  and writing there. Each access verifies `config/`'s own protected
  owner-only DACL, never the root's, so the committed policy still applies,
  and boot reaches the privacy refusal and its fix command. Before this,
  reading the root found nothing and the configuration error stopped boot
  (native run 4). A marker with invalid content is refused. A home that
  never committed `config/` stays root-only. The first read in a run
  decides the location, and the run keeps it, so a marker that appears
  later in a refused home never moves its configuration.
  On a refused boot every authority store outside a verified boundary reads
  as absent: root `permissions.json`, `permissions/user-approvals.json`,
  `permissions/project-rules`, `permissions/shell-egress-hosts.json` and
  `permissions/reviewer-cache.jsonl` whatever the committed state, and the
  root settings, policy and secrets of a home that never committed `config/`.
  The reviewer cache then lives in memory only.
  Only a closed restriction overlay applies from those unverified bytes:
  the `deny` rules of `permissions.json` and of project rules, and
  `requireExplicitApproval`, `managed` and
  `permissions.blockReadsOutsideWorkingDirectories` when they are `true`.
  Allow and ask rules, saved approvals, the stored mode and every other
  field are ignored, and bytes that do not parse apply nothing. Writes to
  those stores are refused with `AveHomeConfigurationRefusedWriteError`
  ("fix the folder permissions first"), so nothing rewrites a user's file
  from its absent view. The boot continues to the refusal notice. Every
  approval card is marked `homeFolderRefused`: a remembered allow (exact,
  rule, folder or network grant) applies once with a localized notice. A
  durable mode switch or reviewer choice applies for the session with a
  notice. A deny-always is not saved; a legacy-pattern deny lasts the
  session in memory. A workspace-root removal whose grant prune is refused
  stays pending. Extension installs and updates (plugins, MCP servers,
  skills, agents, commands, boot installs, the managed git runtime) are
  refused while the home is refused. On POSIX a home that is not a directory
  owned by the user, is group- or other-writable, or sits under an ancestor
  owned by another account or writable by others (a root-owned sticky
  ancestor such as `/tmp` is allowed; ancestors include every folder holding
  a symbolic link on the way, followed link by link) is refused with the `posix-root-unsafe`
  category before any mode is changed; Settings names `chmod go-w` as the fix.
  No process caches the configuration location. Every read and write inspects
  `config/` and its marker without following links. Windows read certificates key
  the home root's RootSafe and protected `config` OwnerOnly checks on each object's
  volume serial, file ID and ChangeTime. These predicates inspect no ancestor
  DACL. Every path ancestor is keyed by volume serial and file ID, without its
  ChangeTime: unrelated child-entry writes must not invalidate verification.
  Every read checks directory-entry reparse state and directory shape along the
  path. Cold native verification returns identities from its actual handles,
  which must equal observations before and after verification. An ancestor swap
  refuses the read; a DACL timestamp change requires full verification. Stable
  reads spawn no process. POSIX directory verification retains device/inode checks.
  Configuration ownership comes only from the live shared host-instance lock;
  other processes start read-only and receive `AveHomeConfigurationNotOwnerError`
  with "Ave is running; close it or use the app" on mutation. Existing host routes retain
  their permission gates. Execution-mode secret provisioning is refused and
  non-owner boot skips secret migrations. There is no configuration file lock,
  process-start identity or stale-record recovery. Owner mutations share an
  in-process FIFO queue, verify boundaries and resolve their destination inside
  that queue. Within this scope, synchronous atomic staging creates and renames
  check the previous certificate immediately before their syscall and re-key only
  the affected directory's ChangeTime immediately afterward, without yielding.
  A certificate already stale before the syscall is verified again from fresh
  DACL facts, as a read would: a root's ChangeTime also moves when an entry is
  created in it (a first boot creates its folders after the first configuration
  read) or when srt-win stamps its deny. The write proceeds only when that
  verification passes on the same certified objects.
  A changed identity, ancestor or other boundary refuses re-keying. Async callback
  completion never re-keys a certificate. Foreign changes after the immediate
  observation still force verification. A concurrent same-account DACL change
  inside the syscall-to-observation window remains a residual race: that account
  already controls these protected objects; other accounts lack WRITE_DAC.
  Synchronous owner migration completes before services start.
  `AVE_HOME` is used exactly as supplied, even when its basename is `config`.
  Readers reject reparse entries, compare file identity before/open/after,
  require a regular file of at most 4 MiB and check stable timestamps and bytes.
  A vanished file triggers one fresh resolution; persistent absence after an
  observed file or commit raises `AveHomeConfigurationUntrustedError`.
  A commit writes only absent documents. A `config/` without its marker that
  already holds a document other than the exact default the commit would write
  (a repaired or hand-restored folder) requires recovery: nothing is written or
  committed, the boot treats the home as refused with the reason `recovery`
  ("Configuration requires recovery"), and the user moves `config/` aside and
  restarts. A linked, unreadable or invalid root source carries nothing and is
  reported. A malformed regular marker can be removed for retry only inside a
  verified protected directory. The source record is empty, so protected-boot
  cleanup moves every regular root file to `<name>.post-migration-<UTC timestamp>`;
  a diagnostic and a system boot notice name the preserved copy. Cleanup never
  merges root data into committed configuration.
  Home content trust. Other inputs in the home that change what Ave runs or
  allows load only when vouched for by `config/.ave-trust-manifest.json`, read on
  the verified `config/` boundary: `{version:1, state, entries}` where `state` is
  `fresh`, `bootstrapped:false` or `bootstrapped:true` and each entry key (home
  relative, `/`-separated, lower-cased on Windows) holds `current` and at most
  one `pendingWrite` SHA-256. Covered inputs are `permissions.json` and the
  `permissions/` stores, `mcp/servers.json`, `governance/mcp-policy.json`,
  `plugins/registry.json` and every `plugins/.cache/*/install-receipt.json`, the
  plugin contribution and agent-plugin trust approvals, `skill-approvals.json`,
  `routine/routines.json`, the marketplace sources, states and snapshots,
  `packages/ledger.json` and `packages/mcp-installs.json`, `AGENTS.md`,
  `agents.custom.md`, `user-preferences.md`, `memories/MEMORY.md`, and each
  first-level entry of `skills/`, `agents/` and `commands/` (a file hashed as
  `sha256("ave-file-v1\n" + sha256(bytes))`, or a tree hashed as
  `sha256("ave-tree-v1\n" + sorted "<path>\0<sha256>\n")`, so the two kinds never
  share a digest; names that differ only in case on Windows are refused). An
  empty file with no entry (what a file lock creates before the first write)
  reads as absent. Marketplace MCP package files under `mcp/<name>/server/` are
  checked before every stdio launch against the tree digest of the verified
  archive held by their install record; a mismatch, a link, or any other entry
  in `mcp/<name>/` besides `server` and the host's `sandbox` refuses the launch.
  `runtime/` has no entry: it is a protected boundary, and the boundary itself
  is the protection by design. A loader
  parses exactly the one no-follow buffer it hashed. An absent, unreadable or
  mismatching manifest or entry means untrusted, and untrusted reads as absent
  apart from the closed restriction overlay above (marketplace revocations also
  still apply). A link anywhere below the home, a POSIX file owned by another
  account, or Windows owner or allow-ACE evidence of another principal (`SY` and
  `BA` excepted) on the item or on a folder between the home and it withdraws
  trust; evidence never grants it, and it is read again whenever the review is
  served. The boot evaluates
  the manifest once right after the commit, collapses each `pendingWrite` that
  matches the file into `current` and drops the rest. While any input is
  pending, shells and extension workers are confined for that boot (the
  `home-trust-pending` sandbox signal) and Settings shows the review: each row
  gives its reason, a masked summary (MCP program names and URL hosts, receipt
  `pluginId@version`, permission mode and allow patterns; never arguments,
  environment, headers or URL credentials), and Approve or Remove. Approve
  records the hash the card rendered; Remove deletes the item without following
  links after a confirmation, through handles that never follow a link (the
  boundary's own `Delete` on Windows, O_NOFOLLOW-pinned directories on POSIX).
  An item directory that is itself a link is a remove-only row. "Approve all"
  is offered only for a `bootstrapped:false` manifest with clean evidence and
  without `oneByOne: true`, which the commit writes when a moved `config/` sits
  among the root's siblings and the boot writes when the manifest bytes do not
  parse. A committed `config/` with no manifest (a home from an earlier Ave)
  gets `bootstrapped:false` without it. The card says extensions run isolated only when a
  confinement backend runs them. Approved items load after a restart. A
  marketplace ledger or skill-approval view opened while pending sweeps and
  grants nothing and re-reads the file before its next use; a pruned snapshot
  forgets its entry. Writes go
  through one guard on the atomic-file helpers: only the host-instance lock
  owner writes a covered input (others get `AveHomeConfigurationNotOwnerError`),
  a pending item is never rewritten from its absent view
  (`AveHomeConfigurationRefusedWriteError`, reason `pending`), and each write
  records its `pendingWrite` before and its `current` after, or clears the
  intent on failure; overlapping writes to one key settle on whichever of
  their bytes landed last. Writes inside a tree item are not recorded and leave the
  item pending. Per-entry no-follow cleanup
  preserves links and reports failures for retry. Interactive boot trust failures show a
  localized native error with the cause, path and recovery instructions before exit.
  Feature storage asserts that boundaries already
  exist and never creates them on Windows.
  Boot reads each boundary's own descriptor on a pinned no-reparse handle.
  The owner must be the user, or `S-1-5-32-544` under an elevated token;
  its protected DACL must hold exactly one explicit user FullControl ACE
  with object and container inheritance. A conforming boundary is never
  rewritten, and its children are never inspected. Traverse bypass does
  not grant access through a child's own protected DACL, so a foreign
  read grant on the root cannot open a boundary.
  The root retains its protected user FullControl rule. A foreign root
  allow contained in `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE`
  (`0x1200a9`, including SYNCHRONIZE) that applies to the root alone (no
  object or container inheritance) emits a diagnostic without disabling
  confinement; that is the traversal case. An inheritable foreign entry of
  any rights would flow into every unprotected child (workspace, logs,
  extension data), so it is an extra principal. The refusal names it and the
  `icacls` command removes it. Any write, delete, WRITE_DAC, WRITE_OWNER or
  other wider right refuses confinement before boundary repair.
  A nonconforming boundary is renamed to `<name>.unprotected-recovery`,
  replaced with a freshly protected directory, and copied without carrying
  its ACLs or read-only attributes. Links and junctions are skipped and logged.
  Copy destinations are created exclusively. A fresh repair directory receives
  a flushed marker before any copied content. On retry, the marker is checked
  through the pinned handle; the partial live directory is renamed aside and
  copying restarts in a fresh protected directory. Unmarked partial directories
  are retained with a diagnostic. The pending aside remains authoritative.
  Once copying and verification finish, the aside is renamed to
  `<name>.unprotected-complete` before deletion. A completed aside beside a
  protected live directory needs deletion only; an aside without a live
  directory is renamed back and repaired again. The deleter opens entries
  relative to pinned handles and removes reparse entries themselves, including
  read-only entries when extended deletion is supported. Cleanup never changes
  attributes; an undeletable aside is retained with its path in a warning while
  the protected live directory remains usable. Other failed repair steps refuse
  confinement and name the boundary and step.
  Each successful repair emits one localized system notification recommending
  sign-out and sign-in because credentials may have been readable. Headless
  hosts log the notice without desktop delivery. A flushed pending-notice marker
  precedes aside deletion and survives restart until the notification service
  accepts desktop delivery; failed or headless delivery keeps the marker.

Any other owner is refused. A change to any of these rules changes the security
contract for all of them.

## Documentation Language Policy

English is the canonical default for app docs, generated examples, comments,
logs, and user-facing fallback copy. Runtime Korean support remains in locale
catalogs, intent parsing, and keyword matching where the app must understand
Korean user input.

## Verification Expectations

Architecture changes should normally be verified with:

- targeted tests for the changed contract;
- `bun run typecheck`;
- `bun run check:i18n-catalog` when UI copy or catalogs change;
- `bun run test` for broad cross-cutting changes;
- `git diff --check origin/main...HEAD` for PR-range whitespace checks.
