# Browser And Terminal Workspace

This guide describes shared-tab control, private host terminals, and conversation-owned isolated commands. The
[architecture](../architecture/architecture.md#browser-and-terminal-workspace)
and [permission policy](../architecture/permission-policy-design.md#shared-browser-control-and-effects)
define the host contract. The [Korean guide](../ko/guides/browser-terminal-workspace.md)
has not yet been updated for the terminal ownership changes described here. Native interaction and provider-authentication
validation remain pending; these descriptions do not establish a release or
measured performance improvement.

## Keep the workspace together

Chat, browser, and terminal can stay open together. Use a browser or terminal
pane's header panel toggle to open its chat. Moving a pane between side and main
placement keeps its browser page and host shell alive. Closing a pane's chat and
closing its actual tab are different actions.

For browser tools, an explicit tab target takes precedence. A pane chat otherwise
targets its bound browser; an unbound conversation uses the active browser. A
missing bound tab fails instead of switching to another one. Browser discovery
does not grant another conversation control. Terminal tools follow the
conversation ownership and privacy rules below.

## Share a browser tab

| State | What it means |
| --- | --- |
| Human (`human`) | The tab is under ordinary user control. Agent mutation needs scoped host authority. |
| Agent active (`agent-active`) | The host has granted this conversation control; each action still needs its normal permission checks. |
| Human paused (`human-paused`) | The user took over or pressed Stop. Agent mutation stays paused until explicit Resume. |

1. Ask the pane chat to work with the displayed page, or name a tab from
   `browser_tabs`. The agent can also create a tab; new agent tabs open in the
   background by default.
2. Review any origin approval. An origin identifies the site's scheme, host,
   and port. Permission for the current origin does not approve a different
   popup origin, grant camera access, or create a complete
   browser network firewall.
3. Take over by navigating from browser chrome, pressing Stop, or page input
   recognized as human intervention. Agent mutation stops persistently. Read-only observation can
   continue under normal policy.
4. Press Resume in trusted browser chrome when you want the agent to continue.
   The tool or a later turn cannot resume for you. An action approved before
   takeover must be approved again for the new control generation where needed.

The browser sandbox and context isolation remain enabled in all three states.
Mode changes transfer agent authority; they do not change that browser baseline.

Native mouse events have one attribution limit: a human click that exactly
matches an armed agent click's position, button, and phase at the same time
cannot be distinguished. Other observed input mismatches interrupt the agent.
Use Stop in browser chrome for an explicit takeover independent of this
mouse-event ambiguity.

## Follow agent browsing

A browser panel's compact live strip shows the latest observed agent action,
its safe URL and target description, and recency. Navigation, clicking, typing,
tab changes and download status use the same local observation system as
document previews. Your own browsing does not create activity in this strip.

The strip is read-only. It records no typed values, credential-field
descriptions, cookies, browser storage or arbitrary page contents. Download activity
contains state, without filenames or save locations; the existing native Save
flow still applies. Download attribution requires a current agent command and a
matching navigation or clicked-link destination; unproved button/script and
late downloads are excluded. Click-initiated downloads also require a native
user gesture. Bounded events support the current strip without adding a history
viewer; they stay in memory and clear with the session. See the [observation contract](../architecture/architecture.md#agent-activity-observation)
for attribution, retention and lifecycle details.

When the agent's tab is open in another panel, the second panel shows a small
live picture of that tab instead of a plain notice. It appears only for tabs the
agent is driving, pauses when you take over the tab or the agent is idle for 30
seconds, and stops whenever its panel is hidden. While the page updates, the
last picture stays with an "Updating" label. Pictures are never saved.

## Know which tabs remain

An agent-created tab retains its creator separately from whoever currently
controls it. It remains open after the turn for you to inspect or continue.
An authorized explicit agent close can destroy an owned tab. When the agent
borrows one of your tabs, its close request releases the association and reports
that the tab was retained. Your browser-chrome close always closes the real tab.

Conversation-scoped `browser_tabs` can include the caller's direct child agents'
tabs. That relation is the actual direct parent, not every descendant sharing a window.
Listing a tab does not grant control. An owned tab can be accessed by its creator,
the creator's direct parent, or the creator's direct child, subject to the
current exclusive lease. A sibling, grandchild, or unrelated conversation cannot
inherit that access. Native popups are tracked within the owning window, may
have no ordinary tab card, and keep their own origin approval
and child-window isolation. Closing the owning window releases its resources.

## Page actions and file uploads

The agent can snapshot, capture, navigate, click, type, and press supported keys.
Additional typed tools provide hover, drag between references, native single
selection, and scroll on a referenced target. A snapshot supplies element
references for the agent to use. References belong to the current document;
a stale or unsupported target fails explicitly. Native selection
verifies the final requested value. Screenshots capture the viewport with
pixel/byte limits. Full-page capture is unavailable because complete page pixels
have not been proved reliable; requesting it fails before capture.

| Tool | Operands |
| --- | --- |
| `browser_hover` | `ref` |
| `browser_drag` | `sourceRef`, `targetRef` |
| `browser_select` | `ref`, `value`; native single-select only |
| `browser_scroll` | `ref`, `direction` (`up`, `down`, `left`, `right`), `pixels` |
| `browser_upload` | `ref`; opens the approved native picker |
| `browser_screenshot` | Viewport only; omit `fullPage` or use `false` |

Each accepts an optional `tabId` from `browser_tabs`. Unknown fields are rejected.

Ordinary pointer/range drag requires native press and release receipts. HTML5
drag uses the browser's own intercepted, bounded text payload for guarded
enter/over/drop; a generic mouse-release acknowledgement does not prove a drop.
This path accepts no files or host paths, does not grant upload permission, and
is cancelled if its page or control changes. It has the same simultaneous-click
attribution limit described above. It exposes no arbitrary script or protocol
command to the agent.

The source drag is cancelled and interception is disabled before the destination
receives the drop. If a dispatched drop loses its acknowledgement, inspect the
page before trying again: the effect may already have happened.

For upload, the agent names the current file-input reference with
`browser_upload({tabId?, ref})`. You explicitly allow that one upload and choose
files in the native picker showing the destination. The agent cannot submit a
host file path. Composer attachments do not preapprove a website upload.
Cancelling the picker sends no files. The host also cancels stale destinations
after navigation, takeover, or another document change. Results report nonsecret
file names, counts, sizes, and status; they do not reveal host paths.

The host retains bounded private readonly copies after the upload tool returns,
bound to the selected input/document. Replacement, navigation, guest destruction,
or shutdown release that selection; native validation must still check browser
read behavior across those boundaries. Unknown files left after a crash are not
automatically adopted or deleted. The [upload policy](../architecture/permission-policy-design.md#shared-browser-control-and-effects)
owns file checks, immutable staging, lease identity, and storage limits.

## Ordinary browser controls

Browser chrome provides bookmarks, bounded visit history and its clear action,
find in page, zoom, site capability decisions, download status, and tab-card
previews. Bookmarks and history accept validated HTTP(S) URLs without embedded
credentials. Local download metadata is not automatically exposed to the agent.

Camera, microphone, geolocation, and notifications follow explicit site
decisions or trusted prompts for a verified current main-frame request.
Fullscreen is unavailable until safe exit UI exists; a saved allow cannot
enable it. Unknown capabilities are denied; iframe origins and redirects do not
inherit unrelated grants. Downloads still ask for a location in the native Save
dialog, keep prompt-rate limits, and never open a
saved file automatically.

Only visible cards in a visible window request previews. Hiding or unmounting
the panel stops new scheduling. Late results after hide, navigation, or close
are discarded without entering a cache. The renderer alone caches completed
previews whose cards remain eligible; main retains capture limits and invalidation
state, not preview images. Captures are throttled and bounded per window; previews do not
focus, navigate, or remount a tab. Capture counts and native guest behavior need
runtime evidence before claiming a resource-use improvement.

<a id="terminal-lanes"></a>

## Host terminals and isolated conversation shells

Visible terminals have no lane selector. Each workspace or side-work-panel terminal contains one native
shell. In the side work panel it is labeled **My terminal (host) · No agent
access**; in a workspace pane it is labeled **My terminal (host) · Agent commands
need your approval**. It uses your real HOME,
profile and validated initial directory. Moving or hiding the pane preserves its
shell; closing the terminal tab ends that host shell.

zsh, bash and pwsh use authenticated hooks installed through a temporary
startup directory, without replacing your HOME or modifying your startup files.
The wrapper sources your actual startup files before installing its hooks and
preserves their environment semantics, including the original ZDOTDIR; pwsh
dot-sources your profiles in PowerShell's own order. Other interpreters (Windows
PowerShell, cmd, fish, nu) and integration failures leave the configured user
shell usable, with integration reported as unavailable. pwsh prompts have no
bracketed paste, so the agent cannot type into a pwsh terminal.

The wrapper's first startup step reads the marker nonce into a shell variable
and deletes its file before any of your startup files run, so a startup file or
a loader it starts cannot find the file. Your startup files run in the same
shell, so they can still read that variable; system-wide startup files that the
shell reads before the wrapper (for example `/etc/zshenv`) run before the nonce
exists.

On systems whose global zshrc runs `compinit` (Ubuntu does), that completion
setup runs while the temporary directory is active, so its cache is rebuilt
there for each terminal and discarded when the terminal closes. Startup is
slower than a native shell; your own `~/.zcompdump` is not changed.
Unverified current directory or exit status remains unknown. Host integration
alone never enables agent typing or automatic output access.

For a bash login launch, the wrapper explicitly sources the system profile and
first readable user login profile before hooks using an interactive rc launch.
The shell's read-only `login_shell` flag remains false, and automatic logout-file
semantics are not emulated. This startup compatibility limit does not grant
agent access.

Host scrollback, startup output and your commands remain private. Only your
explicit block-attachment action shares a selected host block as user-provided,
untrusted context. Focus, selection, a pane chat or a tool call does not share
it. Side-work-panel host terminals have no agent read/write access.

<a id="agent-commands-in-your-terminal"></a>

### Agent commands in your terminal

The chat in a workspace terminal's own pane can ask to run a command in that
terminal, only while answering a message you typed in that chat; a routine, a
plugin or app message, or a sub-agent cannot. Once any tool result (a page, a
file, another command's output) has come back in that answer, each further
command shows a fresh card even if you saved a rule for it, and that card
offers no lasting allow. Unless you saved an exact rule for
that command, shell and folder, you decide each command on an approval card that
names the terminal, shell and folder and shows no automatic review; your
permission mode does not approve it for you, and nothing is approved while you
are away or from another device. **Always allow this exact command in this
folder** saves only that exact command in that folder for that shell; **Always
deny** saves a Bash rule that applies everywhere. If you type in the terminal or
move it while the card is open, approving it types nothing.

While the agent types or runs the command, a strip above the terminal shows it
with **Take over** and **Stop** (typing takes over too). Typing anything,
pressing Take over or Stop, moving the terminal to the side panel, closing the
pane's chat binding or the end of that chat turn ends the agent's control
immediately; Stop also interrupts the agent's command once, even if it has not
started yet. After a take-over, clear or run the line and press **Hand back**
before the agent can run its next approved command; if it is refused, the notice
says why. Only the output that arrived while the agent held control returns to
the chat turn that asked for it. A pwsh terminal keeps shell integration, but
the agent cannot type into it, and the terminal says so.

An ordinary conversation owns its own **Agent (isolated)** persistent shell,
with a disposable HOME and existing filesystem/process confinement. Each
admitted command appears inline in that conversation with its command,
directory, status, known exit code and collapsible bounded output, plus an
isolated badge and color band. There is no separate isolated terminal tab or
side-work-panel surface. Shell-tool activity uses the same authenticated
observation path; the display grants no extra execution authority.

`terminal_run` resolves only the invoking conversation's isolated shell.
`terminal_read` inventories and reads only that conversation's existing isolated
shell, including continuations. Neither accepts a host or another conversation's
terminal as a substitute. A terminal-bound pane turn receives an explicit
host-typing-unavailable refusal in this delivery.

Existing one-shot shell tools retain their explicit approved host/outside-sandbox
execution route. Their inline badge reflects the actual execution mode: an
unconfined command shows host execution rather than claiming isolation. Every
persistent conversation PTY remains confined; approving a one-shot host command
does not permit typing into a user's host terminal.

The host admits isolated shells only within authorized workspace projects;
the whole user HOME cannot become the write-jail anchor. Missing confinement
fails closed while your host shell stays usable. The current Windows isolated
interactive backend remains unavailable; host integration does not establish
that capability.

The isolated shell lives until its owning conversation ends. Hiding a pane or
closing a host tab alone does not end it; if the existing tab lifecycle also ends
the pane conversation, conversation teardown releases its shell. A wait timeout
can leave a command running, and cancelling a waiter is not cleanup proof.
The [terminal permission policy](../architecture/permission-policy-design.md#commands-typed-into-a-workspace-terminal)
owns readiness, confinement, output privacy and pending host-control requirements.
