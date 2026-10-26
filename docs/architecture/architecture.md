# Ave Architecture Document

Ave is a comprehensive agent browser; its goals are stated in
[docs/vision/README.md](../vision/README.md). The app is built around one
invariant: the host owns trust, storage, project identity,
and tool execution; plugins and renderer surfaces request capabilities through
explicit contracts.

Korean source history is preserved at
[docs/ko/architecture/architecture.md](../ko/architecture/architecture.md).

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
The [table preview contract](table-document-preview.md) owns request replacement,
container checks, expansion refusals and bounded display windows.
The [page preview contract](page-document-preview.md) adds presentation outlines
and rendered PDF pages through that same lifecycle.
The [agent document tools](agent-document-tools.md) reuse that parser with bounded
model-context selections and policy-checked, session-bound panel requests.

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
its guests' preferences in main: the main window routes plugin, MCP app and
side-browser partitions to their guards (`configureMainWindowWebviewAttach`) and
refuses any other partition. The `build` composite's `check-sandboxed-preloads`
fails when webpack builds a preload the table does not classify, or when a row
has no webpack config or asset copy behind it. It then checks the built file of
each table row: a sandboxed one may require only the modules above, may name
none of the removed globals, and may have no chunks. It does not scan `dist/src`
for other files.

Every surface that copies theme values follows the theme the host renderer has
applied, including a theme updated in place under the same id. Plugin webviews
receive `host.theme.changed` and can query the replay cache through the plugin-only
`getTheme`, whose guard admits plugin frames only. The floating dock never asks.
Main sends it the cached theme when its window opens and forwards each later
`host.theme.changed` on `ave:dock:theme`. MCP app cards build their host context
from the theme already written to `:root` (`appliedBundle` / `appliedRevision`),
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
surface can present the request, the gate denies it for that call. The layer's
separation plan and the consent-surface security analysis live in
[docs/blueprints/headless-relay-separation.md](../blueprints/headless-relay-separation.md);
this section records only the boundary the rest of the host depends on.

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
   live scope and abort active turns that captured the removed root through the
   pre-removal global allow-list so a snapshot tool batch cannot continue.
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
- Foreground turn-end notices stay out of the composer notification area; system
  notifications are reserved for background or non-focused app state.
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
namespace, never in the main chat store. Briefing runs
(`work-board-briefing:<kind>`) are not runs of an item.

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
| `side-chat` | side-chat | side-chat glyph, indented under its conversation | the conversation, then that tile's side-chat tab showing this side chat |

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
chat a file. The sidebar draws the row under that conversation. A side chat
whose conversation is not in the list — a page that did not reach it, a
conversation since deleted — is listed in its own right rather than dropped.

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
is refused there (`session-open-in-pane`). Reopening a pane's chat reads its
history (`ave:sidechat:pane-history`); the chat's New starts the pane afresh
and the pane's close ends it (`ave:sidechat:end-pane-chat`), stopping only
that pane's turn and archiving a closed pane's conversation. A pane that ends
while its conversation is loading sends nothing (`pane-chat-ended`). When an
authorized `browser_tab_close` destroys an agent-owned pane's page, its turn
runs to its end before its pane chat ends. Releasing a borrowed user tab keeps
the page alive.

The browser tools and `terminal_read` called without a tab id act on the bound
tab, and sub-agents inherit it through their hosting session; a bound tab that
is gone, or of the other kind, is an error, never another tab. A click uses
touch input, which the window routes through its one touch sequence
even when sent through the page's own protocol session; so each press runs
alone in its window, a started press always ends, and a press counts only when
its own page reports it and no other page of the window took a touch. A conversation
that is not a pane's acts on the window's active surface, which the side
panel's chat shows as its target chip; its × drops the target until another
terminal or page is shown. The pane chat claims its session's approval cards,
so the window's lane does not draw them again.

## Browser And Terminal Workspace

Chat, browser, and terminal remain simultaneous workspace surfaces. Side/main
placement is presentation state: moving a pane preserves its live browser guest
and both terminal lanes. The [workspace guide](../guides/browser-terminal-workspace.md)
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

Native popups enter the registry only through the validated child-window
callback. They keep the owning window, guarded session, opener relationship,
and sandbox; they can have a tool handle without a renderer tab slot. Popups
start with user permission provenance. Discovery or focus does not inherit the
opener's origin approval or remove sensitive-field restrictions.

Tool `tabId` values are main-issued handles, while embedded chrome identifies
slots with `rendererTabId`. `BrowserTabsApi.stop`, `pause`, and `resume` accept
only embedded renderer IDs. Native popup `pausePopup` and `resumePopup` accept
only main-issued popup handles. These namespaces are not interchangeable, and
the browser workspace library/find/zoom/preview API targets embedded slots only.

Focusing an embedded page uses a main-owned `focus` operation addressed only by its stored
renderer ID. It requires a visible owning window, that window's active embedded
tab, and unchanged guest, document, control generation, and lease across awaits.
Trusted renderer chrome focuses only the connected visible webview. Completion
requires actual native guest focus; keyboard actions independently require
`focusedFrame === mainFrame`. A renderer acknowledgement alone is insufficient.
Popups require their registered native focus callback and observed native focus.

### Typed page actions and browser chrome

Browser tools expose typed snapshot, screenshot, navigation, click, text, and
key operations plus hover, drag, native single-select, targeted scroll, and
picker-only upload. Schemas and execution both validate operands. Page effects
recheck the live document, target reference, recipient, and control generation.
There is no model-facing arbitrary script or generic protocol dispatcher.
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
Viewport screenshots retain pixel/byte bounds. Full-page capture is unavailable:
the embedded renderer can return a correctly sized image with repeated viewport
content, and popup full-page output has not been independently proved. Requests
fail explicitly before capture rather than reporting such an image as complete.
Selection verifies the final native value and rejects unsupported controls.

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

### Separate terminal lanes

`src/shared/terminal-session.ts` identifies each PTY by `tabId`, required
`lane: "manual" | "agent"`, and a host-issued `terminalSessionId`. Input,
resize, output, exit, and block reads carry the same incarnation. A pane unmount
kills neither lane; closing the tab kills both, and the live-PTY cap counts both.

**Manual · host** runs the native host shell with the user's real HOME/profile
and validated initial directory. It neither wraps the shell in the agent
sandbox nor writes integration startup files into the real HOME. Without shell
integration, current directory and command exit status remain unknown rather
than inferred from the initial directory or terminal output.

**Agent · isolated** is a distinct companion PTY with a disposable HOME,
authenticated shell integration, and active filesystem/process confinement.
Its initial write-jail directory may be within the default workspace or a
user-approved additional project, as resolved by the host's project authority.
Its domain allowlist starts empty; the live egress proxy obtains attributed
destination approvals for foreground and background descendants. Plugin and
model endpoint grants remain worker-only. Approval scopes, revocation and tab
lifecycle follow the [terminal policy](permission-policy-design.md#commands-typed-into-a-workspace-terminal).
Canonical, segment-aligned containment rejects paths resolving outside those
projects at admission; a renderer cwd does not add a grant. This path check is
separate from the sandbox's actual access enforcement and does not alone prove
safety against later path changes. The whole user HOME remains an invalid jail anchor even
when selected as a project. These Agent restrictions do not redefine Manual's
ordinary host cwd behavior.
`terminal_run` always targets this lane. Approval seals its session incarnation,
directory, exact command, and containment identity; execution rechecks them
before typing. No agent bytes, cancellation, or output can redirect to Manual
or another tab; agent output does not take Manual's focus. A wait timeout means
the command can still be running, and cancellation of a waiter does not prove
process cleanup.

On Linux, an Agent terminal keeps its initial mount namespace until it exits.
Before typing an agent command, the host re-scans against that initial policy
and refuses newly required denies, withdrawn grants or scan failures until the
terminal is reopened. Metadata appearing after that check can still be used
until shell exit, with no time limit. Startup/replay output and terminal tool
results disclose this limitation. Foreground and background work can use new
metadata before the next check; raw input does not run the check. A project
outside the original grant stays unwritable. The [sandbox policy](permission-policy-design.md#preparation-and-native-validation)
explains why prompt markers cannot provide a reliable post-block boundary.

An unavailable confined backend leaves Manual usable and Agent explicitly
unavailable. The current Windows interactive Agent backend cannot attest this
contract and is unavailable; it never falls back to a host PTY. General sandbox
availability and unrelated native backend work are not proof of this lane's
capability.

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
  never inferred from argv. The worker's stdin is the host's liveness pipe — it
  carries no bytes and closes only when the host process is gone — so a
  long-lived worker treats EOF on stdin as the order to exit; that, not the
  shutdown sweep, is what keeps workers from outliving a crashed or killed host.

### Extension alerts and scheduled routines

The [alerts design](../design/plugin-alerts.md) defines the complete alerts
release; partial rollout builds expose only their implemented portions. Extensions
own signal detection and declare localized templates and bounded slots in
`alerts.kinds`. The host owns consent and delivery through `raiseAlert` and
`withdrawAlert`, with no extension-specific delivery branches. A malformed block
grants no kinds. Durable work proposals retain their separate contract.

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

All tool execution flows through the registry and executor:

1. resolve the tool by name and source;
2. validate input schema and resolve the effective category;
3. build permission context from trust origin, project, headless state, and
   policy mode;
4. run hard gates before any reviewer or user prompt;
5. ask the user or reviewer where policy requires it;
6. execute through the controlled adapter;
7. record audit and telemetry output.

The source of a tool changes display and audit metadata; it does not create a
separate policy bypass.

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

A tool call raised by a sub-agent's turn passes through up to three deciders.
Each tier only ever narrows what the next one is asked:

1. **Tier 1 — automatic review.** The permission manager and the reviewer
   classifier decide as they do for any other call. A decision of allow ends
   the chain here; the sub-agent's parent is not consulted and no dock appears.
2. **Tier 2 — parent adjudication.** An `ask` that survives tier 1 and clears
   every host-side precondition is put to a host-composed side turn with no
   tools and one round, run on the *reviewer* model and prompted to stand in
   for the parent (`src/permissions/parent-adjudicator.ts`). "The parent" is
   therefore a role, not a session: the only parent-derived evidence is the
   child's title and a truncated copy of the task the parent wrote when it
   spawned the child — not the parent's model, system prompt, or history. That
   is the ceiling's real basis, and the reason `maxVerdict` stays low. The
   stage runs inside `ApprovalGate.requestAndWait`, after the away-authority
   block and before the pending entry is created, so a parent-answered call
   never reaches a dock.
3. **Tier 3 — the user.** Anything the parent did not settle continues to the
   approval dock as it would have without tier 2 — later than it would have,
   and carrying an outbound `parentEscalation` notice so the dock can tell the
   user that a stage they never saw has already run, and how it ended.

The child blocks on the same `requestAndWait` call for all three tiers; no
suspension or resume is involved, and the parent is never woken, so a busy
parent cannot deadlock its own child.

| Invariant | Where it is enforced | Why |
| --------- | -------------------- | --- |
| The ceiling is applied before the parent is asked | The gate derives every condition itself — request kind and category, mode, remote origin, forced-explicit and one-shot substrates, and the verdict ceiling — and never from the caller's eligibility flag | A parent may only narrow a decision the host was already willing to delegate; a caller that asserts eligibility wrongly widens nothing. |
| A parent answer is allow-once or deny-once, never a rule | `askParent` returns decisions with no `rememberPattern` | A durable rule minted for a user who never saw the request would outlive the call the parent actually judged. |
| No child-authored PROSE reaches the adjudication prompt | The only sentence in the evidence is the parent's spawn task. The child's tool arguments are the unavoidable exception — they are the call being judged — so they are masked and carried under the key `argumentsAuthoredBySubAgent`, beneath a system prompt that names the payload untrusted data rather than instructions | Evidence a child can narrate is evidence a child can use to argue for its own approval. What cannot be withheld is labelled as the requesting party's claim instead of presented as fact. |
| Human-only classes stay human-only | Directory-scope grants, rationale cards and agent-action requests, `meta`-category tools, the `ask_all` mode, remote-controller origins, forced-explicit and bound one-shot substrates, and any ask with no tier-1 verdict never enter tier 2 | These are the cases where the decision is the user's by construction, not a judgement about whether a call serves the child's task. |
| Every failure that leaves a turn to answer ends at the user | Timeout, spent budget, unparseable answer, missing adjudicator, provider error and repeated denial all escalate to the dock; a turn stopped while the parent was thinking ends in a host `deny-once` with no dock at all | A stage that cannot answer must not be able to answer "allow" — and a turn the user stopped must not be readable as anyone's approval. |
| Flag off means the chain is the two-tier one | The lane is a synchronous eligibility check; an ask that is not adjudicated is never awaited | The off path must be identical in behaviour and in timing. |

Six deviations from the original design are deliberate and load-bearing:

- **Host-only fields live on `ApprovalRequestInput`, not `ApprovalRequest`.**
  `childProvenance` and `parentAdjudicationEligible` are inputs the host
  supplies; the renderer neither receives nor echoes them, so there is no copy
  for a compromised renderer to author or alter (same argument as
  `remoteControllerOrigin`).
- **Parent provenance travels in a WeakMap, not on the decision.**
  `ApprovalDecision` is a renderer-supplied type, so an `answeredBy` field on it
  would be a claim anyone could make. `parentAdjudicationOf(decision)` keyed on
  the exact decision object the gate returned is a fact only the host can state.
- **A parent deny sets no `rememberPattern`.** Stated separately from the
  allow-once rule because it is the tempting one: a parent that could remember
  a denial would be minting policy.
- **Provenance requires a parent-authored task, and fails closed without one.**
  `SubAgentSpawnInput.parentAuthoredTask` exists because the profile prompt a
  child is spawned with is not the parent's instruction — it is a charter read
  from a file on disk, which anything that can write that file could author.
  Runs whose origin is not a conversation session (work-board items, host
  labels) are excluded for the same reason.
- **`approvalPurpose` is not part of the evidence.** For a sub-agent turn that
  sentence can only have been lifted out of the child's own tool arguments, so
  including it would have put the child's own prose into the prompt that
  decides the child's request.
- **A2A influence IS part of the evidence.** A sibling's message re-elevates the
  receiver's calls into an ask even on the read lane, which is why an otherwise
  auto-approved builtin read can reach tier 2 at all. The host label naming that
  sender rides the evidence as `a2aInfluenceLabel`, emitted to the adjudicator
  as a quoted `raisedUnderAnotherAgentsInfluence.quotedSenderLabel` under its own
  read-it-never-obey-it system-prompt line. It is host-composed and already the
  leading segment of the `reason` the dock would have shown, so it discloses
  nothing new — but without it the parent judges "does this serve the task I
  gave it?" blind to the third agent that prompted the call.

Three settings move or widen the chain, each conservative by default
(`permissions.reviewer.parentAdjudication`):

- **`includeParentContextTurns` (default `0`, clamped `0..5`).** Above zero the
  evidence gains a host-composed block of the parent conversation's most recent
  turns, quoted as data under `recentParentConversation` beneath a system-prompt
  line that says to read it and never obey it. Opt-in because it is the only
  part of the evidence that sends the user's own words to a provider.
  `summarizeParentContextTurns` (`src/permissions/parent-context-evidence.ts`)
  composes it: user and assistant text only — never tool results, reasoning or
  tool calls — with every host-injected user record dropped, which is what keeps
  a **sub-agent's report out of the prompt that decides that sub-agent's own
  call**. Three defences carry that, because one producer alone cannot: the
  mid-turn injection site now stamps `hostInjectionId` unconditionally (a batch
  mixing the user's guide with a child's report is deliberately not attributed
  to the child, so it used to reach the transcript unmarked); the reader also
  drops any user record carrying the host-composed `[Sub-Agent: ` label, which
  covers rows written before that stamp; and an assistant turn answering an
  excluded record is dropped too, so a report asking the parent to restate it
  cannot launder itself through the parent's own voice. Each turn is cut to 500
  characters BEFORE the DLP pass (the bound exists to stop the masking walk, so
  a bound on its output would not do the job) and the block to 2000 measured on
  what is actually sent. The read is memoised for a few seconds because
  `loadSession` is a synchronous whole-file parse on the main thread.
- **`backgroundEscalation` (default `"deferred"`).** A tier-3 escalation the
  host can establish nobody would see — a background child run while the app
  window is hidden or minimised, or any child run while the away answerer is
  armed — is denied fail-closed and recorded in the deferred queue with an OS
  notification, rather than painting a dock nobody is watching. The run's
  `background` flag alone is deliberately NOT enough: every locally spawned
  child is a background run on this host, so keying on it would take the dock
  away from a user sitting in front of the app, and tier 3 is the tier the
  chain exists to preserve. The entry carries **no `grant`**, so the resolve
  path refuses `"approved"` for it: reviewing it later records an opinion and
  can never become permission for a call whose turn is over. There is no
  timeout that could auto-anything — the denial has already happened. An
  attended window, `"modal"`, an unwired queue, an unreadable attendance signal
  or a failed append each keep the immediate dock. Repeat escalations from the
  same (child run, tool) coalesce onto the first entry — still each denied —
  so a child past its adjudication budget cannot bury the queue.
- **`model` (default `"reviewer"`).** `"parent-session"` runs the side turn on
  the chat provider/model the parent's own loop uses, resolved per ask from the
  same settings that build that loop's provider; unresolvable resolves to
  escalate, never to a fallback model. Zero tools, one round and the strict JSON
  parse are identical either way. It is available in reviewer modes that wire no
  LLM of their own — but NOT in `disabled`, whose classifier returns a
  pass-through LOW for every call: a tier-2 ceiling computed from a verdict that
  assessed nothing is not a ceiling. Cost note: it bills the (usually larger)
  chat model once per adjudicated call, bounded by `maxPerChildRun`.

Tier-2 state is per run. When a child run ends — spawn or resume, completed,
failed or aborted — the runner releases its active-child lease and, as the
lease holder, calls `ApprovalGate.forgetChildRun`, which drops that run's
consecutive-denial streaks and tells every adjudicator the policy can name to
release its `maxPerChildRun` counter. A resume therefore starts from a fresh
budget, as the setting's name promises; the bounded LRU maps remain only as a
backstop. The deferred-escalation coalescing map is not cleared, because its
entries track queue rows that outlive the run. The origin conversation id
handed to the adjudicator is what `"parent-session"` resolves its target from.

The chain end to end — tier-1 auto-approve, tier-2 allow, tier-2 deny, tier-3
escalate — is regression-locked by
`src/tools/__tests__/executor-parent-adjudication.test.ts`; the gate's own
bounds live in `src/permissions/__tests__/parent-adjudication-gate.test.ts`,
and the three settings above in
`src/permissions/__tests__/parent-adjudication-options.test.ts` +
`parent-context-evidence.test.ts`.

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

The one asymmetry that is a _path_ fork rather than a pure input difference is the
foreground reviewer AUTO-APPROVE lane, and it is a direct consequence of the
sanctioned trust-tier split: `PermissionManager.categoryBasedDecision`
short-circuits every low-trust (MCP) invocation with a bare `ask` carrying no
reviewer route, so an MCP tool is categorically excluded from the reviewer
auto-approve lane and escalates straight to the ApprovalGate, while a
medium-trust plugin may enter the lane (the reviewer classifier runs, keyed on
the host-computed `ownerPluginSandboxRoot`) and, on any non-LOW verdict, escalates
to the SAME gate. A low-trust foreign peer is therefore never silently
auto-approved; both sources still converge at the user-facing gate. There is no
MCP analog of the app-only dispatch bypass — external servers declare no
app-visible tools. This whole invariant (deny/gate/audit/effect-ledger convergence plus the
trust-gated lane) is regression-locked by
`src/tools/__tests__/executor-mcp-plugin-parity.test.ts`.

## OS Execution Sandbox And Plugin Workers

The OS execution sandbox is backed by
`@anthropic-ai/sandbox-runtime` (ASRT). The active sandbox capability is
published as `kind: "asrt"` with explicit `confines` dimensions. macOS and
Linux ASRT substrates provide filesystem, process, and network confinement.
Windows srt-win provides filesystem and network confinement but no process
confinement, so shell/process relaxation must remain stricter than filesystem
or network-bearing tool relaxation.

`features.osToolSandbox` defaults to `true` on macOS and Linux and `false` on
Windows. An explicit stored value is preserved. The Windows default remains
gated until its shell confinement lane is ready; plugin confinement alone
does not satisfy that gate. Activation still requires a successful runtime
probe. The host issues one immutable `HostShellExecutionPlan` per invocation;
its `sandboxed` field describes the selected child, including exclusions and
unsandboxed retries, rather than merely repeating the setting. Permission,
reviewer, audit and cache consumers use that plan.

A shell whose plan is not sandboxed (the sandbox is off, unavailable or does
not cover the command, an explicit host request, or the Windows Plan B) runs
without asking only when an exact allow rule for that command — user, project
or This session — matches it: `Bash(<command>)` for bash and
`PowerShell(<command>)` for PowerShell (owner decisions 2026-10-25: the
unsandboxed shell exact-rule requirement, superseding the I3 rule that sent
such shells to the normal rules, and exact PowerShell rules with the same
strictness as Bash). Prefix and tool-wide rules, wildcard rules, remembered
dock grants, allow mode, the reviewer and the judge never stand in for that
rule: everything else asks on the dock. With nobody to ask (a headless or
routine turn) the same exact rule still runs the command — sandbox-off bash,
the Plan B and an explicit host request alike — and without one the call is
denied and audited (I5). Every remaining unsandboxed headless ask, including a
visible floor or unreadable restriction, becomes deny with its reason and layer
preserved. Exact command-rule identity keeps every literal raw word, including
program case, module qualifier, quote style and contents. Only interword
whitespace changes. No head or argument normalization contributes to the exact
key; effect and detection normalization remain separate. Current-format shell
allows carry `shellRuleVersion: 1`; unversioned or wrong-version allows remain
silently inert, while deny and ask rules retain their authority. Reads never
stamp old rows current and there is no migration or new UI/error flow.

Exact allows additionally require the host's
[literal-command proof](permission-policy-design.md#literal-command-proof).
An unsandboxed input over 2,000 characters immediately asks or denies
headless before project loading, parsing, command-rule or floor inspection.
Under the limit, parse or lexer/analysis-budget failure, nonliteral words and ambiguous
raw identity remain unproven. Literal quoting is preserved, so
`git commit -m 'msg'` can be remembered.

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

Character, data or total-token limit failures close Lane B with ask/L6 or
headless deny, or Lane A with modal/L2. No rule, grant, mode or reviewer supplies
an automatic allow. There is no shared work counter, elapsed-time cutoff or
worker timeout in the production decision. Timing checks are regression tests
only. Literal encoded display decoding remains presentation-only.

Remembered approvals saved for unsandboxed shells before this decision stay
silently inert: they are not migrated, the card does not mark them, and they
never authorize a plain shell; Settings still lists and revokes them (owner
decision 2026-10-25).

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
| Network | user-global `Network(<host>[:<port>])` deny rule | the grant of that lifetime (This session / This tab, This project, Always); an edited rule is saved as a `Network(...)` host rule instead |
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
forced modal, a non-read reason prefix, a remote out-of-folder one-shot),
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
wildcards. An allow edited into a wildcard is saved, but it applies only to
sandboxed runs, and the card says so while the rule is edited (the host
repeats it as `wildcard-allow-sandboxed-only`); an unsandboxed command still
needs its exact rule. A compound, irreversible, floor-hitting or
secret-bearing command has no exact rule and offers no remembered allow.

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
  `--disable-userns`. The helper is out of the chain whenever a worker control
  socket is registered, because that turns on `allowAllUnixSockets`. So
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
(`docs/design/plugin-hostapi-protocol.md` §9.8 A2, decision 64). Because
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
call, one per workspace terminal shell (for the life of its tab's shell), and
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
worker socket directory does). On macOS `allowAllUnixSockets` would expose the
shared bridge socket, so while it is set shell and extension identity is
`shared`. The proxy refuses a destination that is a proxy front end's port on
this host, so one invocation cannot hop onto another's listener. The
callback is asked in two phases (part 5 of the patch). The name phase comes
before anything is resolved or routed, so every refusal the name alone
decides (unattributed, a worker off its list, asks off, nobody to ask, a
reserved literal) costs no DNS query and no proxy lookup: the
proxy's lookup is the sandbox's only resolver, and a refused
`<data>.attacker.example` must not reach the zone's server. An interactive
card (or a terminal tab's banner) is shown by name, using the class implied by
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
are shell-origin: a terminal tab's connection never consults them and its
banner offers none. An address literal has no host rule, and a
`Network(...)` rule naming one is refused when it is parsed. An edited
wildcard host allow is saved with the same `wildcard-allow-sandboxed-only`
warning as a wildcard shell allow. The scope values on the wire and on disk are
`once`, `session`, `tab` (a terminal tab's only), `project` and `always`; the earlier `conversation` and
`workspace` names are refused everywhere, except that a version-1 grant file's
`workspace` grants are migrated once: a grant made at its project root becomes
the `project` grant for that root, and one made in a subdirectory of a
repository is dropped (re-keying it on the root would widen it) and recorded as
an `egress-grant-migration` sandbox-audit row, so that host is asked again. The
file is written back as version 2 on the next change. "This session" choices
(network hosts, `Bash(<command>)` rules, exact approvals) end when the
conversation is deleted: deleting a root conversation ends them for it and its
sub-agents, and deleting a sub-agent session ends only that session's own
network hosts, since its rules and approvals belong to the root. A workspace terminal tab (always in
the foreground) reaches a host a grant covers, and otherwise the person is
asked in a banner in that tab, drawn only in, fetched by and answered from
the window that owns the tab, with the same shared decision row (Deny, Allow
once, Allow for this tab, Always allow everywhere; Always deny is shown
disabled, since host rules are shell-origin: a
terminal's Allow once lets that one connection through and is never held;
"This tab" takes the place of "This session" and lasts until the tab's
shell exits, including an exit followed by a respawn; terminals have no
This project, since every tab runs in the app's one default workspace,
which agent shell calls share). Every grant is bound to its origin (`shell` or
`terminal`) and destination network class (`public`, `local` or `unverified`),
for Allow once, session, tab, project and Always scopes. Matching,
listing, use tracking and revocation preserve both fields, so neither another
origin nor another class can reuse it. Settings shows the origin and preserves
the class when revoking. A replan to a
different class requires a fresh warning and decision before connecting.
Project roots are compared after `canonicalizePathForMatch`. The
connection is held while the banner is up and denied after 120 s without an
answer, or at once when the tab closes; connections from one tab to one
destination share one banner row. While no view of the tab is mounted the
ask is drawn on the focused pane's lane instead
(`src/ui/renderer/components/permissions/TerminalEgressBanner.tsx`).
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
and site-local addresses are offered at most This session (a terminal:
This tab), with a local-network warning on the card, and persistent grants
never apply to them. Only the desktop window
answers an egress ask; an answer from any other surface leaves it pending. Session and
tab grants are listed and revocable in Settings too, and revoking a grant closes the
connections it let through that are still open. Each decision, including a
refusal the proxy made before asking, writes an `egress-decision` sandbox audit
row. Where `egressIdentityStrength() === "shared"` (the Windows shared proxy,
or macOS with `allowAllUnixSockets`), both new approvals and reused grants stop
at This session (a terminal: This tab). Persistent grants remain stored
when the channel becomes shared, but cannot authorize it; they apply again
when the channel is strong. Grant lookup filters eligible scopes before
selecting the narrowest match.

`spawnWorker` is the only host primitive that can establish that worker-backed
plugin substrate. macOS and Linux workers use an ASRT-wrapped Unix-domain-socket
control path. Windows workers keep TCP control, but their filesystem access is
scoped through a per-worker holder PID ACL grant using ASRT's Windows
`grantWindowsAcl`/`revokeWindowsAcl` primitives, then the command is wrapped
through srt-win. The holder command must be launched through a pinned System32
binary and its lifecycle is part of the worker's confinement proof: if the
holder exits or errors, the host must revoke grants, unmark the worker, and
terminate the wrapped worker.

### Windows agent shells in Microsoft Execution Containers

By owner decision (2026-10-19, proxy-egress PR 9) a Bash or PowerShell tool
command on Windows runs in its own Microsoft Execution Containers (MXC)
BaseContainer where the host offers one. Ave ships only the MIT-licensed
`wxc-exec.exe` launcher from `@microsoft/mxc-sdk` 1.0.0 at
`<resources>/mxc/<arch>/wxc-exec.exe` (x64, arm64), staged at build time by
`scripts/fetch-mxc.mjs` against `src/permissions/mxc-launcher-pins.json` (the
npm tarball's sha512, each launcher's sha256). Ave does not load the SDK's
JavaScript: its Windows stdio path needs Node 24.21, newer than the Node
Electron bundles. Each command spawns `wxc-exec.exe --config-base64 <request>`
from the launcher's own directory (`mxc-windows.ts`, `mxc-shell-launch.ts`);
no administrator rights or UAC prompt are needed per run or at install.

The package's other binaries are not shipped because Ave never takes their
paths: `winhttp-proxy-shim.exe` is the elevated, UAC-raising proxy fallback of
the AppContainer tier, which MXC refuses for `runtimeConfig.networkProxy` with
egress deny + ingress allow (the only shape Ave sends; boot also requires the
dry run to select `base-container`); `plm.exe` is the elevated tracing helper
behind `telemetry`, which Ave never enables; `wslcsdk.dll` and the daemon and
host-prep binaries serve the WSL-container, Windows Sandbox, isolation-session
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
  not the build number: identity-less loopback proxying needs PSEC 1.1 in MXC
  1.0.0. Any failure leaves the shells on the approved-host route with its
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
  workspace terminal never runs in MXC (it is the user's surface, and MXC ends
  background descendants with the command), and reads only the process-wide
  capability.
- **Filesystem.** The per-command ASRT lists are ranked for MXC
  (`rankMxcFilesystem`): the protected read floor drops grants not under a
  pierce, a write grant under a `denyWrite` path becomes read-only, a deny
  strictly inside a grant becomes an explicit `denied` entry when the path
  exists, and grants that do not exist are dropped. Measured: a more specific
  grant wins over a denied parent, a missing `denied` file path still blocks its
  creation, and a missing `readonly` directory does not block its creation, so
  a `denyWrite` path that does not exist is written as `denied`.
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

Not covered: plugin workers stay on srt-win. MXC's proxy mode forbids direct
egress rules, so the TCP worker control channel cannot reach a container; a
container worker needs a stdio control path or control over its own proxy
port. Windows PowerShell 5.1 and Node inside a container start only in an
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
review is advisory, never a merge gate. Documentation-only mirrors under `docs/ko`
are excluded from naming-process gates because they preserve historical source
text; production paths remain covered.

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
  The stale-copy sweep checks both directory owners and DACLs for the new layout,
  and also accepts the old single-level layout with its original marker checks.
  It deletes only `srt-win.exe` and `owner.json`, then their empty directories,
  without recursion. A sandbox-account ACE found on the temporary root emits
  `srt-win-temp-root-acl-owner-action-required`; the sweep never edits that ACL.
  Any remaining legacy ACE requires owner-approved inspection and repair of the
  exact explicit ACE or its inheritance source, with active holders accounted for.
- **`AVE_HOME` is created by the user, or admitted only on a strict DACL.**
  When `AVE_HOME`, its `secrets` directory, or its `subscription-runtimes`
  directory does not exist yet,
  `ensureAveHomePrivate` in `src/shared/ave-home.ts` has its protecting step
  create it with the user as owner and an owner-only protected DACL, so no
  grant for the token's default owner is left behind. Before it changes an
  existing directory's DACL, the step refuses a link or junction and an owner
  this rule does not accept, and nothing inside a refused directory is
  touched; the permission command then acts on a link itself (`icacls /L`),
  never on its target. An existing `AVE_HOME` the app did not create may be
  owned by `S-1-5-32-544` only when the current token's default owner is
  `S-1-5-32-544`. Its DACL must then be protected and hold exactly one entry,
  the user's own full-control grant, inherited by files and folders and not
  itself inherited; no system principal is granted. The app protects such a
  root, but it does not take ownership of it. `isOwnerOnlyDacl` in
  `src/shared/ave-home.ts` applies this rule. It takes an elevated
  Administrators token as its sign that the default owner is `S-1-5-32-544`.
  On a non-elevated boot, only an existing non-reparse `subscription-runtimes`
  root owned by `S-1-5-32-544` is claimed for the token user before DACL protection,
  with the owner rechecked on the same non-following handle; other foreign owners
  remain refused. A failed claim refuses privacy as `owner-claim-failed`, naming
  the path and advising one elevated run or an owner repair.

Any other owner is refused. A change to any of these rules changes the security
contract for all of them.

## Documentation Language Policy

English is the canonical default for app docs, generated examples, comments,
logs, and user-facing fallback copy. Korean pages under `docs/ko` are kept only
where a reader or a test needs them; the
[documentation index](../README.md#language-policy) states the rule. Runtime Korean
support remains in locale catalogs, intent parsing, and keyword matching where
the app must understand Korean user input.

## Verification Expectations

Architecture changes should normally be verified with:

- targeted tests for the changed contract;
- `bun run typecheck`;
- `bun run check:i18n-catalog` when UI copy or catalogs change;
- `bun run test` for broad cross-cutting changes;
- `git diff --check origin/main...HEAD` for PR-range whitespace checks.
