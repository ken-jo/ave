# Browser And Terminal Workspace

This guide describes shared-tab control and the two terminal lanes. The
[architecture](../architecture/architecture.md#browser-and-terminal-workspace)
and [permission policy](../architecture/permission-policy-design.md#shared-browser-control-and-effects)
define the host contract. The [Korean mirror](../ko/guides/browser-terminal-workspace.md)
covers the same workflow. Native interaction and provider-authentication
validation remain pending; these descriptions do not establish a release or
measured performance improvement.

## Keep the workspace together

Chat, browser, and terminal can stay open together. Use a browser or terminal
pane's header panel toggle to open its chat. Moving a pane between side and main
placement keeps its browser page and both terminal lanes alive. Closing a pane's chat and
closing its actual tab are different actions.

An explicit tab target takes precedence. A pane chat otherwise targets its own
bound surface; an unbound conversation uses the active workspace surface of
the appropriate kind. A missing bound tab fails instead of switching to another
one. Browser tab discovery within a window does not let one conversation take
over another conversation's owned tabs.

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

## Terminal lanes

Use the lane buttons above the terminal to switch between two distinct PTYs
with separate screens and output:

| Lane | Environment and use |
| --- | --- |
| Manual · host | Your native host shell, real HOME, and profile. Type your own commands here. |
| Agent · isolated | A confined companion with a disposable HOME and authenticated shell integration. Approved `terminal_run` commands run here. |

The initial directory, current directory, profile, and authentication state can
differ between lanes. Without shell integration, Manual reports current
directory and command exit status as unknown. It does not pretend that the
initial directory is still current. Agent startup files do not modify your real
HOME, and agent output does not switch focus away from Manual.

Agent can start within the default workspace or an additional project you have
approved. The host resolves project authority and checks canonical containment;
typing a path does not grant access. The entire user HOME cannot become the
Agent write-jail anchor. Manual continues to use ordinary host cwd behavior.

`terminal_run` always uses the target tab's Agent companion. Its approval binds
the exact command, directory, lane, session incarnation, and containment. A
restarted companion or a shell directory change invalidates the old approval.
`terminal_read` without a target lists both lanes. A targeted read requires
`lane` and `terminalSessionId` from that inventory; continuations also identify
the exact tab and block.
The agent never types into Manual or falls back to another tab.

If the required confined backend is unavailable, Manual remains usable and Agent
reports unavailable. The current Windows interactive Agent backend is
unavailable because it cannot attest the required filesystem/process and shell
control contract. Other sandbox features do not establish this capability.

A wait timeout can return while a command is still running. Cancelling the
waiter does not prove the process exited or cleanup completed. Moving or
unmounting the pane keeps both sessions alive; closing the terminal tab kills
both. See [terminal permission checks](../architecture/permission-policy-design.md#commands-typed-into-a-workspace-terminal)
for shell readiness, command text, identity, and cancellation boundaries.
