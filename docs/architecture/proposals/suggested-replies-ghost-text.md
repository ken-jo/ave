# Suggested Replies: Ghost Text and Tab Fill

Status: Implemented. One suggestion per turn, shown as ghost text in the main
chat composer. Code cites this page by section number (§3, §6.1, §6.2, §8, §10);
keep those numbers stable.

## 1. Goal

After an assistant turn ends, the main composer shows one likely next user
input as ghost text. `Tab` fills it into the textarea; the user can edit it or
send it as is. The side chat composer does not show suggestions.

## 2. Decisions

| Topic | Decision |
|---|---|
| Source | The same LLM response carries the suggestion in a trailing `<suggested_replies>` block. No extra model call. |
| Count | Exactly one. The prompt asks for one; the parser keeps only the first well-formed line. There is no alternates chip row. |
| Trigger | The model decides. The prompt asks for a block only when the user has a next action to choose (tool result summaries, follow-up questions, plans, error guidance) and to omit it otherwise. |
| Keys | `Tab` fills, `Escape` dismisses. |

## 3. Display states

- No suggestion, or dismissed: no ghost; the default placeholder shows.
- Suggestion present and the textarea is empty: ghost text plus a "Tab to fill"
  hint (`suggestedRepliesGhost.tabToFill`); the placeholder is blanked.
- The user types one character or more: ghost hides. Clearing the textarea
  brings it back.
- IME composition in progress: ghost hides until composition ends.
- A new turn's suggestion replaces the previous one.

## 4. LLM contract

`src/prompts/system-prompt-builder.ts` adds a static "Suggested Replies" source
(id 9.85) whose text is the i18n key
`be_systemPromptBuilder.suggestedRepliesInstruction`. It asks for:

```
<suggested_replies>
- {text}
</suggested_replies>
```

at the end of the response body, with these rules:

- Only when the user needs to decide the next action; omit for greetings,
  single answers, complete answers, and abnormal terminations.
- Exactly one candidate, in the user's language, 40 to 60 characters
  recommended, 80 maximum (longer lines are dropped).
- No executable command payloads: slash commands, `!` shell prefixes, or
  `$NAME=` environment assignments, including single-token commands.

## 5. Streaming and parsing

All parsing lives in `src/engine/suggested-replies.ts` and is shared by the
three consumers so a tag spelling one accepts cannot leak through another.

- Tag matching tolerates whitespace inside the brackets
  (`< suggested_replies >`), because models drift on exact spelling.
- `createStreamingFilter()` runs per turn in `src/ipc/handlers/chat-stream.ts`.
  `feed()` returns only text that is safe to show: everything before the open
  tag. A suffix that could still grow into the open tag (up to 64 characters)
  is held back across chunks. Once the open tag is seen, the rest of the stream
  is buffered and never emitted. `finish()` returns any held-back plain text
  and the parsed suggestion.
- `parseSuggestedReply()` takes the first non-empty line of the block, strips
  bullet markers, and drops lines over 80 characters. No block, or no valid
  line, means no suggestion. Parse failures are silent.
- `stripSuggestedReplies()` removes closed blocks and a trailing unclosed
  block from complete text. It is applied to the round text in
  `chat-stream.ts`, to persisted assistant text in
  `src/engine/turn/query-loop.ts`, and to provider text in
  `src/engine/turn/provider.ts`, so the block never reaches the session file or
  the next turn's context.
- At turn end `chat-stream.ts` emits the platform event
  `suggestions.updated` with `reply: string | null`.
  `src/api/platform-conversation-legacy-adapter.ts` maps it to the renderer
  stream frame `{ type: "suggested_replies", reply }`.

## 6. Renderer

### 6.1 Store, hook, and ghost overlay

`src/ui/renderer/hooks/use-suggested-replies.ts` owns a module-level store:

- Snapshot shape: `{ text: string | null; isDismissed: boolean }`. An empty
  push resets to a shared empty snapshot so `useSyncExternalStore` skips
  renders when nothing changed.
- `useSuggestedReplies()` wires one IPC subscription per process
  (`onChatStream`, `suggested_replies` frames) and returns the snapshot. The
  subscription outlives view remounts so a Composer remount mid-turn keeps the
  suggestion. A dev-only HMR dispose tears it down.
- `pushSuggestedReply()` drops any reply matching the command-prefix guard
  (§10) before storing it.
- Dismiss memory: `dismissSuggestedReplies()` sets a latch; later pushes in
  the same turn stay dismissed. `clearDismissedReplies()` (called on send) and
  `acceptSuggestedReply()` release it.
- `resetSuggestedReplies()` clears the store without telemetry when the
  conversation on screen changes (new chat, session load, transcript rewind,
  routine seed). `src/ui/renderer/hooks/use-chat-state.ts` calls it.
- Telemetry counters `shown`, `accepted`, `dismissed`, `ignored` go through
  `src/telemetry/suggested-replies-counter.ts`. `ignored` is recorded when a new
  non-empty suggestion replaces one that was visible and neither accepted nor
  dismissed.

`SuggestedRepliesGhost` in `src/ui/renderer/components/Composer.tsx` renders the
overlay: absolutely positioned over the textarea, `pointer-events-none`,
`aria-hidden`, test id `suggested-replies-ghost`, with a motion-safe fade-in.

### 6.2 Composer integration

`Composer` takes an optional `suggestedReplies` snapshot prop;
`src/ui/renderer/ChatView.tsx` passes `useSuggestedReplies()`.

- Visibility: empty textarea, not composing, text present, not dismissed (§3).
- `Tab` with no modifier, a visible ghost, and an enabled composer: prevent
  default, fill the textarea with the suggestion, call
  `acceptSuggestedReply()`, and move the caret to the end.
- `Escape` with an active suggestion: call `dismissSuggestedReplies()` without
  `preventDefault`, so window-level Escape handlers (turn abort while
  streaming) still run.
- Enter-to-send calls `clearDismissedReplies()` before sending.

## 7. Lifecycle

A suggestion belongs to one assistant turn of one conversation. It is replaced
by the next turn's push (an empty push clears it), consumed by `Tab`, hidden by
`Escape` for the rest of that turn, and dropped when the visible conversation
changes (§6.1). A stale suggestion would otherwise suppress the empty-state
composer layout.

## 8. Edge cases

| Case | Behavior |
|---|---|
| Stream aborts inside the block | Buffered block is discarded; no suggestion. |
| Model lists several candidates | First valid line wins. |
| Unclosed trailing block in final text | Stripped before persistence. |
| Misspaced tag | Matched by the tolerant tag pattern. |
| User typing when a suggestion arrives | Ghost stays hidden until the textarea is empty. |
| IME composition | Ghost hidden during composition. |
| Composer not focused | Ghost stays visible. |

## 9. Enforcing tests

- `src/engine/__tests__/suggested-replies.test.ts` - parser, strip, streaming
  filter (split tags, abort mid-block).
- `src/engine/__tests__/suggested-replies-tag-drift.test.ts` - tolerant tag
  spelling.
- `src/ui/renderer/hooks/__tests__/use-suggested-replies.test.ts` - store,
  dismiss latch, command guard, telemetry.
- `src/ui/renderer/hooks/__tests__/use-chat-state-suggested-replies.test.tsx` -
  reset on conversation change.
- `src/ui/renderer/components/__tests__/Composer.test.tsx` and
  `src/ui/renderer/__tests__/ChatView.test.tsx` - ghost visibility and keys.

## 10. Command-payload guard

Because `Tab` fills the composer and the next `Enter` sends it, a suggestion
must not be an executable host command. Two layers enforce this:

- The prompt forbids command payloads (§4).
- `use-suggested-replies.ts` drops any trimmed reply matching
  `^(?:/\S*|!\S*|\$[A-Za-z_][A-Za-z0-9_]*=)` before it reaches the store. `$`
  is limited to the environment-assignment shape so currency and prose survive.

## Related

- [Architecture: Conversation Loop](../architecture.md#conversation-loop)
- [Composer message queue](../../blueprints/composer-redesign-message-queue.md)
- [Product vision](../../vision/README.md)
