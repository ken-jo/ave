# Composer and Message Queue

Status: Implemented. Describes the composer's action row and the mid-turn
message queue as they work today in the main chat and the side chat.

## Composer layout

`src/ui/renderer/components/InputActionBar.tsx` draws two rows around the
textarea (the input box frame is `ComposerFrame` in `Composer.tsx`):

- Action row, inside the box. Leading: the slash/command picker (the persona
  picker is its first submenu), then attach. Trailing: the shortcuts help, then
  a single turn-control button.
- Status row, under the box: context ring, pending approvals, permission mode,
  model, and reasoning level. These describe the session, not the message being
  written, so they sit outside the box.

The turn-control button shows stop only while a turn is running and the draft
is empty; it reverts to send as soon as anything is typed. Stop runs the same
action as `Escape` (see [Interrupt paths](#interrupt-paths)).

`MessageQueuePanel` (`src/ui/renderer/components/MessageQueuePanel.tsx`) is a
card above the composer, aligned with its inset frame in `ChatComposerDock.tsx`
(main chat) and `SideChatView.tsx` (side chat). It renders only when the queue is
non-empty.

### Surface levels

Next-send context and rate-limit notices belong inside the composer's column,
above its frame, with the same width. Context usage from 90% through 100% is a
warning; usage above 100% remains a warning when automatic compaction will run
before the next send. Above 100% with automatic compaction disabled, use the
destructive icon and omit the automatic-compaction promise. Unknown policy also
omits that promise. Side chats estimate their own transcript and draft against
the selected model route's context window and prompt-input cap.

A failed automatic compaction adds a localized notice to the owning transcript,
clears its progress indicator and leaves the current history and chat stream
intact. It never raises a window-wide strip.

Compaction is one transcript unit: an unadorned divider label, quiet secondary
navigation buttons and a collapsible summary body inside one shared frame.
The summary has no separate card border or accent bar. Available navigation
stays visible below the divider label, retaining its behavior and accessible
labels. A successful manual compaction uses the `compact_notice` checkpoint
event rather than adding another result bar. The summary starts collapsed.
The disclosure keeps native keyboard operation, sentence-case text, quiet
surface edges and a focus ring only on keyboard focus. History cards and usage
notices use `chatSurface` with its quiet, flat variant: the composer's
`rounded-xl` radius, `bg-input-bar`, `border-border-subtle`, no shadow, and
`text-xs` base typography. They use the shared motion tokens and reduced-motion rule.

Per-turn change review ("Review latest turn changes") belongs to the stack of
panels above the composer, alongside the queue, expanded task panel and question
panels. It must never sit between the composer frame and its status row.
Task/goal chips remain session metadata; their expanded panels use the upper stack.

## Message queue semantics

The queue is a pool of messages the user typed while a turn was running. It is
not a task list: rows show only their delivery state. Each composer surface owns its
own `MessageQueueStore` (`src/ui/renderer/state/message-queue-store.ts`); the
behavior is wired by `useMessageQueue` (`src/ui/renderer/hooks/use-message-queue.ts`).

Store rules:

- Text only. Attachments are never queued; a busy-turn `Enter` clears pending
  attachments so they do not ride along with a later send.
- Caps: 50 items, 8000 characters per item. `add` and `update` throw past
  either cap and on empty text; the composer keeps its text when `add` fails.
- Items expire 30 minutes after creation or last edit, pruned lazily on read.
- The store is in memory and is cleared when the session changes.
- Item actions in the panel: toggle selection, edit (double-click; empty text
  removes the row), move up/down, send now, remove. Moves preserve selection,
  identity and expiration, and cannot cross a reserved or handed-off row.

`formatQueueInject` turns items into one user message: a single item is sent as
is; two or more are wrapped as a header line (`messageQueueStore.queueInjectHeader`)
followed by a `- item` list. One combined user message avoids consecutive user
turns.

### Busy-turn queueing

While a turn is streaming, `Enter` with non-empty text adds it to the queue
instead of sending. When idle, `Enter` sends directly. Both paths first offer
the text to `interceptSubmit` (used by `/allow` to answer a pending approval);
if it consumes the text, nothing is queued or sent.

### Mid-turn hand-off (brake point)

On each `tool_end` of the current turn, surfaces with a guide channel (the
main chat) hand all pending items to the engine through the guide inject
path:

- Before awaiting acceptance, `reservePending` assigns the current batch a
  request-owned reservation. Reserved rows stay visible with a sending indicator;
  editing, removal, selection changes, reordering and send-now are disabled.
- Acceptance marks only that reservation's rows handed-off. Refusal or error
  releases only the matching reservation; a late reply cannot claim rows in a
  replacement session. Reservation and release preserve identity, order,
  selection and expiration.
- `guidance_injected` clears the delivered rows (`clearDelivered`, containment
  match because the engine may merge several hand-offs into one block).
- `guidance_dropped` returns handed-off rows to pending (`releaseHandedOff`) so
  the end-of-turn drain sends them.
- A refusal (`queue-full`, `too-long`, `no-active-turn`) keeps the items, shows
  one error, and blocks further hand-offs for the rest of that turn. `done` or
  `error` clears the block.
- An in-flight guard prevents a burst of `tool_end` events from sending the
  same items twice.

The side chat has no guide channel; its queue drains only at turn end.

### Turn-end auto-send

On `done` for the current turn, pending (neither reserved nor handed-off) items are removed and
sent as a new turn with `inputOrigin: "queue-auto"`:

- A re-entrancy guard (`queueAutoInflightRef`) ignores further `done` events
  until that send settles. Rows are removed before the send so a second `done`
  finds the queue empty.
- The send is deferred to a microtask so every stream subscriber processes the
  `done` frame before the new turn re-arms the surface's stale-frame guard.
- `isCurrentTurnEvent` (supplied by the side chat) filters frames from a
  superseded turn, so an interrupted turn's trailing `done` cannot drain the
  queue onto the turn that replaced it.
- A `queue-auto` send never interrupts the running turn, skips renderer slash
  command handling (the text reaches the model as plain text), sends no
  attachments, no keyboard intent, and no persona id
  (`src/ui/renderer/hooks/use-send-message.ts`).
- `src/ipc/handlers/chat.ts` accepts `queue-auto` without a user activation
  token (it fires from a stream event, outside a user gesture) and writes an
  audit entry `chat:utterance:queue-auto:start:len=N` so these turns are
  distinguishable from keyboard turns. The origin is listed in
  `ChatSendInputOrigin` and `isChatSendInputOrigin` in `src/shared/chat-origin.ts`.

While an approval is pending the turn cannot reach a brake point or end, so the
panel shows a held-by-approval hint (`messageQueuePanel.heldByApprovalHint`).

### Interrupt paths

All interrupt sends use `inputOrigin: "user-keyboard"` and
`injectHint: "interrupt"`; when a turn is running, the send stops it inside the
same `chatSend` call.

| Gesture | Effect |
|---|---|
| `Escape` in this composer, or the stop button, while streaming | Non-empty queue: take every item and send as one interrupting message. Empty queue: abort only. |
| `Cmd/Ctrl+Enter` in this composer (idle or busy) | Send selected queue items plus the current input as one message; unselected items stay. Empty selection sends the input alone. |
| Row "send now" | Send that one item; others stay. |

`Escape` precedence while streaming: an open blocking surface (dialog or
approval) takes it; otherwise, if any queue item is selected, `Escape` only
clears the selection; otherwise it runs the interrupt above. Keyboard handlers
check that the event target is this surface's own textarea, since several
composers can be mounted at once.

### Other shortcuts

| Key | Behavior |
|---|---|
| `Shift+Enter` | Newline. |
| `Alt+Up/Down` on a queue row | Move the pending item one position, retaining focus and announcing its new position. Unmodified arrows move focus. |
| `Cmd/Ctrl+K` | Main chat only: inject the current text as guidance into the running turn. Errors map to `chatView.guideError*` messages. |

## Enforcing tests

- `src/ui/renderer/state/__tests__/message-queue-store.test.ts` - store rules,
  caps, TTL, `formatQueueInject`.
- `src/ui/renderer/hooks/__tests__/use-message-queue.test.ts` - hand-off,
  drain, interrupt flows.
- `src/ui/renderer/__tests__/ChatView-message-queue.test.tsx` and
  `src/ui/renderer/components/__tests__/MessageQueuePanel.test.tsx` - wiring
  and panel actions.
- `test/e2e/ui/composer-message-queue.spec.ts` - action row, row edit, and
  `queue-auto` turn-end send in the running app.

## Related

- [Suggested replies ghost text](../architecture/proposals/suggested-replies-ghost-text.md)
- [Architecture](../architecture/architecture.md)
- [Product vision](../vision/README.md)
