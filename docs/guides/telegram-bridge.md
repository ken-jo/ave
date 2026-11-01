# Telegram bridge

The Telegram bridge lets one Telegram private DM reach one active Ave
conversation. It is off until an owner turns it on, and it is intentionally
separate from the loopback `/v1` API, A2A, and Tailnet services.

It is configured in `Settings → Connections → Remote surfaces`, receives
updates over an outbound long poll (`getUpdates`), opens no port and no public
endpoint, and pairs through a one-time code sent to the bot. (An earlier
environment-configured webhook deployment mode was removed; the desktop
connection is the only lane.)

## Desktop connection

The desktop path exists because a webhook deployment's own safety
requirement — that a proxy's forwarding lifecycle be coupled to the bridge
lifecycle — cannot be enforced by an app with a Disconnect button. Polling
opens no listener, so there is no fixed port whose forwarding can outlive the
bridge.

### What connecting means

Connecting is an egress decision, and a broader one than the webhook path's.

- Ave stores the BotFather token in this machine's encrypted credential
  store. On a machine with no usable encrypted store, connecting is refused
  rather than falling back to plain text.
- While connected, Ave keeps an outbound request open to `api.telegram.org`.
  That discloses this desktop's network address and its online pattern to
  Telegram **before** any account is paired and before any conversation is
  shared. Pausing stops the poll loop, not merely inbound handling.
- Messages sent to the bot before connecting are discarded rather than
  replayed. Replaying a backlog would run each one as a live turn.

### What Ave never does to your bot

Ave calls only `getMe`, `getWebhookInfo`, and `getUpdates`. It never calls
`setWebhook`, `deleteWebhook`, `logOut`, or `close`. If the bot already has a
webhook registered, connecting fails closed and asks you to remove it in your
own deployment; Ave will not remove it for you, because that would destroy a
deployment it does not own.

### Pairing

A bot cannot open a chat, so the paired owner always sends the first message.

1. Register your own numeric user ID in the desktop connection Settings. Use your account ID, not a username or bot ID. Only that ID can pair and send; an unknown or different sender cannot redeem a code.
2. Create a bot with `@BotFather` and paste its token into the connect form.
3. Choose **Pair my Telegram account**. Ave mints a single-use code of the form `ave-tg-v1.<43 characters>`, shown once.
4. Send that code from your registered account to the bot as an ordinary message.

Changing the registered owner ID removes the current pairing and conversation approvals and pauses a connected transport. Existing bindings without a matching registered owner are visibly suspended; register your ID, pair again and approve the conversation. See the [owner identity decision](../architecture/permission-decision-tree.md).

The code is deliberately not a slash command. The shared ingress core rejects
every leading-slash message unconditionally, and admitting a Telegram account
is a privileged action; a `/start` consumer would have to branch that gate.
Deep links of the form `t.me/<bot>?start=<payload>` are therefore not usable.

Redemption is consumed before the message can reach the conversation, so a
pairing code never enters the transcript. Text that merely looks like a code is
consumed and dropped too, so a near-miss credential cannot land there either.
The code is single-use, expires, and has a small attempt budget; exhausting
that budget destroys it, after which even the correct code no longer pairs.

Unknown senders receive no reply at all. Any Telegram user can message a bot,
and answering would confirm to a stranger that this bot is attached to a live
desktop.

The paired owner is a different case. When their message cannot be routed —
because nothing is shared, or because the shared conversation is not the one
open on the desktop — Ave answers with a fixed host notice saying so. It
carries no conversation material, goes only to the paired account, and is sent
at most once every ten minutes per chat so a flood of unroutable messages cannot
turn the bridge into a reply amplifier. A notice that fails to send is not
retried; silence is preferable to a loop.

This is deliberately a second, narrow egress path. The conversation delivery
channel is fenced by the route guard, and that fence is precisely what is
closed when there is nothing to say — so without this path an unroutable
message would be consumed and answered with nothing, which is indistinguishable
from a dead bot.

### Pairing is not access

A paired account still sees nothing. Sharing is a separate, explicitly
gestured action that binds the conversation you have open, for a fixed
duration.

That binding is durable and it is the whole point: your phone talks to the
conversation you shared, not to whichever one you happen to have open. It
survives closing the conversation and it survives restarting the app, and only
one conversation is shared at a time — sharing another one replaces it, so
there is never a grant you cannot see. Ave stores that conversation's local
identifier next to the opaque digest the share was granted under, and refuses
the record unless the two still agree, so editing one of them in that file
yields no share at all. That digest is a plain hash of values that are both in
the same file, so it is not a defence against someone who can rewrite the file:
what protects the share is that the paired account is named by a key held in
this machine's credential store, which the file does not contain, and that a
shared conversation only runs while it is the one on screen. Revoking the
share, re-sharing under a new grant, pausing, or disconnecting each invalidates
the previous binding.

Running a turn is a narrower question than being shared. Because the host runs
one active session, replies run only while the shared conversation is the one on
screen; open a different one and the desktop says so and answers Telegram with
the host notice, without dropping the share. Opening the shared conversation
again continues it. Running a shared conversation in the background is not
something Ave does today.

If the shared conversation is deleted, the desktop says that instead. It is a
distinct state, not the same "not on screen" message: there is nothing to
reopen, and the only repair is to share a different conversation. The grant
itself is left alone, so restoring the conversation restores the share.

### What leaves this desktop

Only assistant text and coarse progress, through the shared safe projection.
The host never adds model reasoning, tool inputs or results, local paths,
attachments, memory source text, internal identifiers, or error stacks to what
it sends.

Read that as a statement about the host, not a filter on the text. Assistant
prose is forwarded verbatim and is not redacted, and a model routinely writes a
file path into its own reply. What the projection guarantees is that none of
those things is attached as a structured field; it does not guarantee that a
path never appears in a sentence the model wrote. If the assistant would say it
on screen, assume it can be said on your phone.

Tool approvals stay local. A Telegram message can start work that needs an
approval, but the approval prompt appears only in the desktop app; Telegram
cannot answer it.

An authenticated owner-matching account bound to the conversation uses the same tool rules, remembered grants, mode and reviewer as the local user. Genuine external-content floors still require a fresh human answer. Internal skill and hook approvals retain live identity checks, including while waiting and before a persistent skill grant commits. The [permission decision tree](../architecture/permission-decision-tree.md) owns the complete decision order.

### Pausing and disconnecting

Pausing stops queued sends and any send not yet handed to the Bot API. It
cannot recall a request already handed over, even if Ave has not yet seen the
response.

Disconnecting deletes the stored token, revokes the pairing and any share,
stops receiving, and leaves your bot exactly as it was on Telegram's side.

## Operational limits

- Inbound deliveries use durable, plaintext-free receipts for seven days. The
  outbound projection is live, bounded, and at-most-once: after a process
  restart or an uncertain Bot API response, Ave does not replay content
  blindly.
- Accepted and permanently rejected deliveries are confirmed so that a stale
  command is not retried later. Only unavailable/capacity conditions are left
  for retry — by not confirming the update, so the next poll re-fetches it.
- Telegram output is plain `sendMessage` text only. Ave does not set Markdown
  or HTML parsing, entities, keyboards, callbacks, paid broadcast, threads, or
  link previews.
- Deltas buffered behind an in-flight delivery are compacted from the existing
  safe projection only; adjacent text remains ordered, transient progress
  statuses may collapse, and no more than one Bot API send is launched for a
  paired DM per second. A separate bot-wide pace permits one launch every
  34 ms (about 29 messages per second), keeping below Telegram's approximate
  free bulk-delivery guidance of 30 messages per second.
- Route/session revocation stops queued sends and sends that have not yet been
  handed to Telegram. It cannot recall a request already handed to the Telegram
  Bot API. The bridge guard fences entry to `ConversationLoop.runTurn`, but
  cannot cancel a provider/model turn already executing inside it.
- Only one receiver can hold a bot's updates. If another app or machine is
  already polling, or a webhook is registered, Ave reports the conflict and
  stops rather than fighting for the stream.
- The adapter uses the bounded safe projection, which cannot judge whether
  ordinary assistant prose is sensitive. Treat Telegram as an external
  recipient accordingly.

Official references: [Telegram Bot API](https://core.telegram.org/bots/api),
[getUpdates](https://core.telegram.org/bots/api#getupdates),
[setWebhook](https://core.telegram.org/bots/api#setwebhook),
[sendMessage](https://core.telegram.org/bots/api#sendmessage), and the
[Telegram Bot FAQ](https://core.telegram.org/bots/faq).
