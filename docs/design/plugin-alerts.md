# Plugin alerts — a host delivery contract, declared per kind

Status: proposed design, not implemented. Owner decisions recorded in this
page: the alert *mechanism* is raised to the host contract; each plugin
declares what it alerts on in its manifest and detects it itself; the host
owns delivery; every alert kind is opt-in; the `vega-helper` plugin
dissolves into the plugins that own its signals. Line references are against
ave `origin/main` at `ccf81ced5` and the official marketplace monorepo at
`origin/main` `6a4d3b3` (2026-09-25: `plugins/vega-helper/source` 0.11.3,
`plugins/lyra-mail/source` 0.5.3, `plugins/meeting/source` 0.8.5); the internal
`orion-api` plugin is 0.21.5.

"The alerts release" below is the ave release that carries the last two
host pull requests of the plan (marketplace conditional revocations and the
routine/deprecation changes). This page writes it as 0.12.0; substitute the
version that actually carries them, because every successor plugin's
`minAppVersion` and the revocation's `appVersions` are fixed to it. "The
follow-on release" is the minor release after the alerts release, where the
deprecations below are retired.

## Why a contract, not a port

Three partial mechanisms exist today and do not compose:

- **`notificationEvents`** (`src/plugins/public-contract.ts:537-542`): a manifest
  maps a bus event's fields to an OS notification, registered by
  `registerPluginNotifications` (`src/boot/plugins.ts:159-259`) and fired as
  `kind: "plugin"` through `NotificationService` (line 244). The title and body
  are whatever fields the plugin names — `lyra-mail` sends the raw sender and
  subject of every new mail to the OS notification centre. There is no card, no
  per-plugin cooldown beyond the 5 s kind cooldown
  (`src/main/notification-service.ts:117-129`), and no user toggle.
- **`triggerConversation`** (`public-contract.ts:1797-1799`, spec at `:1928-1975`):
  a plugin with `host:overlay` stages an overlay card whose prompt becomes a
  user turn. `evaluateTriggerSpec` (`src/boot/steps/plugin-runtime/trigger-gate.ts:312`)
  dedupes for 5 minutes (line 29), rate-limits 6 per 60 s (lines 100-101) and
  caps the prompt at 4096 (line 82); `visibility` and `priority` are normalised
  (line 451) and then only audited — the card looks the same for every value.
  Nothing links it to an OS notification or a user setting.
- **`workProposals.kinds` + `proposeWork`** (`public-contract.ts:568-573`,
  `:1839`; `host-api-factory.ts:1659-1680`): declaration is authorization
  (`getDeclaredWorkProposalKinds`, `src/plugins/runtime/manifest-validation.ts:136`,
  fail-closed and all-or-nothing), one open card per declared kind, upsert by
  `(kind, key)`, and a durable, retractable card on the Work Board.

`vega-helper` (`plugins/vega-helper/source/src/hostPlugin.ts`, 1523 lines)
built the missing composition in plugin space: per-intent cooldown, a fixed
per-intent OS notification (`notification-metadata.ts`), user toggles stored in
its own `configSchema` (`disabledDetectors`, `osNotificationsEnabled`,
`osNotificationIntents`), a prompt/summary split so opaque ids reach the model
but not the card, and relay events so other plugins could act. Every one of
those is delivery, and delivery is the host's job. What the host must **not**
take is the content: mail keywords, sender allow-lists, meeting-room phrasing,
organisation names and tool names all stay in the plugins that own the signal
(`AGENTS.md` > Organizational identifiers, lines 168-173; the decoupling audit
`src/plugins/__tests__/app-plugin-decoupling-audit.test.ts`).

## The contract

### Manifest fragment — `extensions["ai.agent-connector.ave"].alerts`

```jsonc
"alerts": {
  "reasoning": "Why this plugin alerts at all — shown in Settings.",   // ≤ 400 chars
  "kinds": [
    {
      "id": "mail-reply",                       // ^(?!.*--)[a-z][a-z0-9-]{0,30}[a-z0-9]$, unique in the plugin
      "label":       { "en": "Mail needing a reply", "ko": "답장 필요 메일" },   // ≤ 40 chars per locale
      "description": { "en": "…", "ko": "…" },  // ≤ 200 chars per locale, optional
      "defaultEnabled": false,                  // every kind in this page is opt-in; see Settings
      "visibility": "user-visible",             // "user-visible" | "summary-only" | "silent"
      "osNotification": {                       // optional; absent = never notifies the OS
        "defaultEnabled": false,
        "bypassFocusGate": false,
        "body": { "en": "A mail that needs your reply arrived.", "ko": "…" }  // static text, no slots, ≤ 80 chars
      },
      "actionLabel": { "en": "Draft a reply", "ko": "답장 작성" },  // optional card button, ≤ 24 chars
      "slots": {                                // typed, bounded, untrusted values
        "subject":    { "kind": "text", "maxLength": 80 },
        "senderName": { "kind": "text", "maxLength": 80, "optional": true },
        "emailId":    { "kind": "ref" }
      },
      "summary": { "en": "{senderName} wrote: {subject}", "ko": "…" },
      "prompt":  { "en": "A mail that seems to need a reply arrived from {senderName}: {subject}. Read it with the mail tools and help me answer.", "ko": "…" },
      "inherits": [ /* see Migration of user choices */ ]
    }
  ]
}
```

Rules the host enforces at manifest load (`getDeclaredAlertKinds`, next to
`getDeclaredWorkProposalKinds` in `manifest-validation.ts`):

- **Declaration is authorization.** A `kind` not declared, or a block that is
  malformed in any entry, grants nothing — all-or-nothing, as `workProposals`
  (`manifest-validation.ts:130-134`). At most 12 kinds per plugin. Kind ids
  never contain `--`, so `<pluginId>--<kind>` splits unambiguously (plugin ids
  forbid `--` too, `schemas/plugin-manifest.schema.json:22`).
- **Templates are declared, slots are typed.** `summary` and `prompt` are
  locale maps of template strings whose only dynamic parts are `{slot}`
  references to declared slots. Slot names match `^[a-z][a-zA-Z0-9]{0,31}$`.
  A template referencing an undeclared slot, a slot declared but unused in
  both templates, or any `<`/`>` in template text rejects the block. Slot
  kinds: `text` (untrusted third-party text, `maxLength` ≤ 200), `ref`
  (an opaque id matching `^[A-Za-z0-9+/=_-]{1,256}$`; appears in the prompt
  only, never in the summary), `list` (`maxItems` ≤ 5 items of `text`, each
  capped by `maxLength` ≤ 120; rendered as `; `-joined text in the summary
  and one bullet line per item in the prompt). A slot is required unless
  `optional: true`; an optional slot that is absent renders as the empty
  string or the empty list.
- **OS notification text is static.** `osNotification.body` admits no slot;
  the title is the kind's `label`. This is the privacy rule of the plugin's
  `notification-metadata.ts` made structural, and it keeps slot text out of
  `NotificationService`'s toast-to-OS fallback (`notification-service.ts:380-395`).
- **Every user-facing string is a locale map** with `en` required, resolved by
  the host at render time in the app locale — the plugin never localises.

### HostApi

```ts
// src/plugins/public-contract.ts — PluginHostApi
raiseAlert(input: AlertInput): Promise<AlertResult>;
withdrawAlert(kind: string, key: string): Promise<boolean>;

export interface AlertInput {
  kind: string;                                // a declared kind id
  key: string;                                 // ^[A-Za-z0-9_.:/@+=-]{1,256}$ (Outlook message ids run ~150 chars); dedupe identity; never rendered, never logged raw
  slots?: Record<string, string | string[]>;   // declared slots only
  priority?: "low" | "normal" | "high";        // default "normal"; see Priority
  visibility?: "user-visible" | "summary-only" | "silent"; // may only LOWER the declared visibility
  ttlMs?: number;                              // card lifetime; host clamps to [1 min, 7 days], default 24 h
}

export type AlertResult =
  | { status: "raised"; alertId: string; delivered: { card: boolean; osNotification: boolean; toast: boolean } }
  | { status: "refreshed"; alertId: string }  // an open card with this identity was updated in place
  | { status: "kind_not_granted"; kind: string }
  | { status: "disabled_by_user" }             // the user's toggle for <pluginId>:<kind> is off
  | { status: "blocked_by_predecessor"; pluginId: string } // a plugin named in the kind's `inherits` is installed and not revoked
  | { status: "closed" }                       // this identity was dismissed or accepted within its card TTL
  | { status: "cooldown" }                     // the kind fired within its cooldown window
  | { status: "rate_limited" }                 // per-plugin sliding window
  | { status: "invalid"; field: string };      // slot missing/too long/wrong shape, bad key, bad priority
```

**Identity.** `alertId = base64url(HMAC-SHA256(installSecret, pluginId + "\0" + kind + "\0" + key))`
truncated to 32 characters, where `installSecret` is 32 random bytes the host
creates once in the `alerts` feature namespace. It is the only identity that
reaches the overlay item, the audit log, bus events and `open.json`; the raw
`key` never leaves the call. The HMAC matters because plugin keys can be
guessable (vega-helper's fallback key is `mail-intent:<subject>|<sender>`,
`decide.ts:145`), and a plain hash of a guessable key is reversible.

**Upsert and closed state.** Re-raising an identity whose card is open
refreshes the card (new slots, new `ttlMs`, moved to the top of its priority
band) and returns `refreshed`; no OS notification, no cooldown or rate charge.
Refreshes have their own budget: at most 6 per identity per 10 minutes, then
`rate_limited`, so a plugin cannot keep a card pinned to the top by
re-raising. An identity that the user dismissed or accepted stays closed for
the card's TTL and returns `closed` — `proposeWork`'s "stays closed" rule.
For `summary-only` and `silent` alerts, which draw no card, the identity
lives for the same clamped `ttlMs` and a re-raise within it returns
`refreshed` without any delivery. Both open and closed identities are
persisted, so a restart cannot bring a card back (calendar watchers keep
their own notified-sets in memory and re-emit after restart); the closed
table holds at most 512 identities per plugin, oldest evicted. Each kind
holds at most 3 open cards; a fourth evicts the lowest priority first, then
the oldest, with `alert.withdrawn` reason `evicted`.

**Priority.** `high` cards sort above `normal` above `low` in the overlay
region, and a `high` toast stays until dismissed; `low` never notifies the OS
even when the kind allows it. Nothing else reads it.

`withdrawAlert(kind, key)` dismisses the open card for `(caller, kind, key)`
and resolves `false` when none is open — the same identity scoping as
`withdrawWorkProposal` (`host-api-factory.ts:1682-1690`).

Effect classification: `raiseAlert` and `withdrawAlert` are `"write"` in
`src/permissions/effect-kind.ts` (as `proposeWork`, line 187); the isolation
wire entries mirror `proposeWork` (`src/plugins/isolation/host-api-wire.ts:1006-1019`,
`host-api-dispatcher.ts:1297-1305`, `host-api-child.ts:265-266`): plain JSON
in, plain JSON out, no lifetime.

### Host-owned events

| Event | Payload | Who |
| --- | --- | --- |
| `alert.raised` | `{ pluginId, kind, alertId, visibility, priority, raisedAt }` | host emits after the pipeline accepted the alert |
| `alert.withdrawn` | `{ pluginId, kind, alertId, reason: "withdrawn" \| "expired" \| "accepted" \| "dismissed" \| "evicted" }` | host emits |

`alert` joins `HOST_ONLY_EMIT_NAMESPACES` (`src/plugins/capabilities.ts:112`) —
a plugin that could emit `alert.raised` could make subscribers react to an
alert nobody raised. It does **not** join `PUBLIC_EVENT_NAMESPACES`: a
subscriber receives only the events whose `pluginId` is its own, and another
plugin's alerts only with a `pluginAccess.plugins[].events` grant naming that
plugin, the same ownership rule as any plugin event
(`assertEventSubscribeAccess`, `src/plugins/runtime/index.ts:345-375`). Host
kinds' `alert.*` events therefore reach no plugin, because no grant can name
`@host`; that is intended. The
filter is applied at delivery by the alerts pipeline, since the emitter is
the host. Payloads carry no slot values.

## Delivery pipeline (host)

`src/alerts/` is the host domain; the Work Board (`src/work-board/*`,
`src/boot/steps/work-board-setup.ts`) is the layout precedent.

```
src/alerts/
  kinds.ts            registered kinds: <pluginId>:<kind> → declaration (+ host-declared kinds under @host)
  identity.ts         install secret, HMAC alertId
  render.ts           locale resolution, slot sanitisation, template fill, prompt footer
  gate.ts             predecessor check → user toggle → closed/open → cooldown → rate → visibility
  stage.ts            overlay item + pendingPrompt envelope (shares trigger-gate.ts helpers)
  notify.ts           NotificationService.fire({ kind: "alert", … }) after acceptance
  audit.ts            alert.raised / alert.suppressed rows (alertId only), TriggerDenyAuditThrottle
  store.ts            open and closed identities: ~/.ave/alerts/open.json (rehydration, TTL expiry, boot queue)
  host-kinds.ts       kinds the host itself declares (Work Board due-soon)
  __tests__/
src/boot/steps/alerts-setup.ts    builds the pipeline after conversation-wiring; deferred start
src/ipc/domains/alerts.ts          ave:alerts:* (renderer only)
src/shared/alerts-types.ts         renderer DTOs
src/i18n/messages/generated/alerts.ts   alerts.* (renderer) and be_alerts.* (main)
```

Order of operations for `raiseAlert`, each step producing exactly one result
code. Dedupe, cooldown and rate state are recorded **only after acceptance**
(the rule `trigger-gate.ts:403-407` follows), so a refusal never charges a
window.

1. **Grant.** `kind` must be in the caller's declared kinds → `kind_not_granted`.
2. **Shape.** Every required slot present with the right shape and within its
   cap; `key` matches its pattern; unknown slot → `invalid`.
3. **Predecessor.** While any plugin named in the kind's `inherits[].pluginId`
   is **loaded, or installed (registry) and not revoked**
   (`revocationRegistry`), the kind is not delivered and its toggle is not
   resolved → `blocked_by_predecessor`. "Loaded" is part of the condition
   because `markRevoked` acts only at load (`runtime/index.ts:2957-2980`) and
   a revocation applied mid-session does not stop a running plugin: a
   revoked predecessor whose uninstall failed or is policy-locked keeps
   alerting until the next restart, and blocks until then; after the restart
   it is refused at load, raises nothing, and no longer blocks. Which
   installed package counts as the predecessor depends on what the host
   knows: until the retirement entry for that plugin id is in a synced
   snapshot, a package matches by name plus the source hint the successor
   carries in its own `inherits[]` entry (`sourceId: "ave"`, the fixed and
   reserved official id, `src/marketplace/sources/official.ts:23`) — the
   package's `sourceId` must equal the hint or be `null` (an old snapshot, a
   company-source `orion-api` arriving before the official sync, or a
   never-bound package must all block, not double, while an unrelated
   package that merely shares the name cannot block a user who never syncs
   the official source); once the entry is known, a package matches when its
   `sourceId` equals the source that carries the entry or is `null`. An
   internal mirror that republishes vega-helper under its own source id
   does not match the hint and would run beside the successors; that rare
   case is accepted. This is the generic rule that closes
   every double-alert window: the successor stays silent until the
   predecessor is gone or silenced, whatever order the two updated in.
4. **User toggle.** `settings.alerts.kinds["<pluginId>:<kind>"].enabled`,
   resolved as described under Settings → `disabled_by_user`, audited through
   the existing `TriggerDenyAuditThrottle` (`trigger-gate.ts:225`).
5. **Open or closed identity.** Open → refresh the card, `refreshed`. Closed
   within the card TTL → `closed`. The identity table is the pipeline's own
   (`store.ts`), persisted with the cards; it does not share
   `TriggerConversationDedupe`, whose global 256-entry LRU
   (`trigger-gate.ts:53-58`) would let another plugin's churn evict alert
   entries.
6. **Cooldown.** One fire per kind per 5 minutes (the plugin's
   `DEFAULT_COOLDOWN_MS`), keyed `<pluginId>:<kind>` → `cooldown`.
7. **Rate.** A `TriggerConversationRateLimiter` bucket per plugin, separate from
   the overlay and proposal buckets (`host-api-factory.ts:127` precedent) →
   `rate_limited`.
8. **Render.** Slot values pass the sanitiser ported from the plugin's
   `template.ts` (`sanitize`: control, bidi and variation-selector strip,
   code-point-safe truncation to the slot cap; `wrapUntrusted`:
   `<untrusted-<slot>>` tags with literal angle brackets neutralised). The card
   `summary` is the filled summary template with plain sanitised values; the
   model-facing `prompt` is the filled prompt template with wrapped values,
   then one `- <slot>: <untrusted-<slot>>value</untrusted-<slot>>` line per
   `ref` slot (ids are wrapped too: a mail id is chosen by the mail server,
   not by the plugin), then `formatPluginPendingPrompt` (`trigger-gate.ts:122`)
   wraps it in the `imported-from-proactive` envelope with source
   `overlay:<pluginId>--<kind>` (matches `OVERLAY_TRIGGER_SOURCE_PATTERN`,
   `src/shared/overlay-trigger-source.ts`, body `overlay:[a-z][a-z0-9-]*`,
   `src/shared/staged-origins.ts:108`); host kinds use `overlay:host--<kind>`.
   Two rules keep these sources unforgeable: manifest validation and the
   marketplace repository check reserve the package id `host`, and
   `triggerConversation` rejects a `source` containing `--`, so only the
   alert pipeline can mint a `--` source. The accepted turn keeps the
   `plugin-emitted` staged origin (`src/shared/staged-origins.ts:127`), so it
   carries that origin's force-ask posture and the
   `overlay-trigger-origin-guidance` block.
9. **Visibility** (effective = min(declared, requested)):
   - `user-visible`: overlay card (`OverlayItem` with source
     `{ kind: "alert"; pluginId; kindId; alertId }`, a new member of
     `OverlayItemSource`, `src/ui/renderer/context/OverlayContext.tsx:26-43`;
     `handlePluginPrimaryAction`, `use-routine-overlay.ts:181-191`, already keys on
     `pendingPrompt`), plus the notification step.
   - `summary-only`: the notification step only; no card, no prompt — nothing
     reaches the model.
   - `silent`: audit row and `alert.raised` only.
   With no window to draw into (boot before the window, teardown) the accepted
   alert is queued in `store.ts` and staged when the window appears; there is
   no refusal for that state.
10. **Notify.** The kind's `enabled` toggle governs the in-app cue: the card
    for `user-visible`, and for `summary-only` an in-app toast while the
    window is focused (`NotificationService.fire({ kind: "alert", title:
    label, body: osNotification?.body ?? description, bypassFocusGate: false })`
    on the focused path only). The kind's `osNotification` toggle governs the
    OS notification alone: when the kind declares `osNotification`, that
    toggle and the master switch are on, `priority` is not `low`, and the
    window is unfocused or the kind sets `bypassFocusGate`, the same call
    takes the service's OS path (`notification-service.ts:299-330`). So a
    `summary-only` kind such as `mail-new` is heard whenever it is enabled,
    with or without the OS toggle. New `NotificationKind` `"alert"` with the
    5 s cooldown of `plugin`, added in both `notification-service.ts:33-39`
    and the renderer copy `src/ui/renderer/types.ts:377`. This fires
    **after** the alert is accepted and the card is staged, never before — a
    behaviour change from the plugin, which emitted the OS notification
    before `triggerConversation` returned and regardless of its result.
11. **Audit and event.** `alert.raised` audit row and bus event with
    `alertId`, kind, visibility, priority. Rejections at steps 3-7 write
    `alert.suppressed` with the reason, throttled.

Cards are removed when their plugin is **uninstalled or revoked**, not when it
is unloaded: a config change restarts the plugin (`host-api-factory.ts:636-650`)
and an update reloads it, and neither should clear the user's cards. Accepting
a card inserts the envelope as a user turn in the tile's conversation exactly
as a plugin overlay item does today, and emits `alert.withdrawn` with reason
`accepted`.

### The host's own kind

The Work Board's due-soon nudge uses the same pipeline as a host-declared kind
`@host:due-soon` (`host-kinds.ts`, label and body from `be_alerts.*`). The
`@host` namespace cannot collide with a plugin because plugin ids cannot
contain `@` (`plugin-manifest.schema.json:22`) — a plugin named `work-board`
declaring `due-soon` would otherwise share the settings key and could withdraw
the host's card. `scanAndEmitDueSoon` (`src/work-board/due-soon.ts:55`) keeps
emitting `work_board.work_item.due_soon` for plugin subscribers and
additionally raises the host kind, so the nudge is visible with no plugin
installed — today it is visible only because `vega-helper` subscribed to
it. The kind is `defaultEnabled: false` like every other; how a former
vega-helper user's `work-item-due-soon` choice reaches it is under
Migration (the host cannot name the plugin, so the mapping is marketplace
data). A host kind has no predecessor to block on, so on the first boot of
the alerts release it resolves to off before any retirement has happened;
that value is auto-resolved (`seenByUser: false`) and is re-resolved once
when a retirement mapping for it arrives later (Settings, below). One
spelling everywhere the host owns the identifier: the settings key is
`@host:due-soon`, the HMAC `pluginId` input is `@host`, the `alert.raised`
payload carries `pluginId: "@host"`. Only the staged source differs,
`overlay:host--due-soon`, because the source body admits no `@`; that is why
the package id `host` is reserved.

## Settings surface

`AppSettings.alerts` (`src/data/settings-store.ts:492`, normalised like the
other domains):

```ts
interface AlertSettings {
  osNotificationsEnabled: boolean;                       // master; default true
  kinds: Record<string, AlertKindChoice>;                // key "<pluginId>:<kind>" or "@host:<kind>"
}
interface AlertKindChoice {
  enabled: boolean;
  osNotification: boolean;
  visibility: "user-visible" | "summary-only" | "silent"; // the declared visibility the user consented to
  seenByUser: boolean;                                    // false = auto-resolved, never visited
  repaired?: true;                                        // the loader replaced a damaged entry; cleared when the user sets the kind
  absentSinceAppVersion?: string;                         // set when the plugin is uninstalled; cleared on reinstall
}
```

Resolution of a kind with no entry happens when the kind is first registered
and is written back only when it is final:

- If a plugin named in the kind's `inherits` is installed and not revoked,
  nothing is resolved (the kind is blocked, above).
- Else if a retired record for such a plugin exists and names the kind's
  plugin as a successor, the `inherits` mapping decides (Migration).
- Else the kind's own `defaultEnabled` and `osNotification.defaultEnabled`
  apply — with one override: a kind that is **first seen in an update** of an
  already-installed plugin resolves to `enabled: false` regardless of its
  declaration. An update must not turn on a card the user never agreed to.

Two later events can change an entry without the user:

- **A retirement mapping arrives.** An entry that is still auto-resolved
  (`seenByUser: false` and not `repaired`) is re-resolved once from the
  retired record when that record is written — this is how `@host:due-soon`,
  resolved off on the first boot before any retirement, picks up the
  `successors.hostKinds` mapping. An entry the user has visited is never
  changed, and neither is a repaired one: corruption recovery outranks
  every automatic transition, so the only thing that turns a repaired
  entry on is the user setting it (which also clears `repaired`).
- **Visibility escalates.** The entry stores the `visibility` the user
  consented to; when an update declares a higher visibility than stored,
  the entry is reset to `enabled: false`, `seenByUser: false` and the new
  visibility. Lowering never resets.

Settings shows every `seenByUser: false` kind with a "new" mark.
`settings.alerts` is written only by the alerts service — from the `setKind`
IPC and from its own write-back — so a generic settings patch and main's
write-back cannot race; `SettingsService.patch()` excludes `alerts` and
`retiredPluginConfigs` from its parameter type and ignores them at runtime.
Removing a plugin leaves its entries in place with `absentSinceAppVersion`
so a reinstall keeps the user's choice; the settings loader drops an entry
whose `absentSinceAppVersion` is two minor releases behind the running
version (a higher major, or the same major with a minor difference of at
least two) — except a repaired entry, which is kept until the user sets it,
so the repair guarantee below holds for as long as the entry exists and a
reinstall after the window cannot recreate the kind from a third-party
`defaultEnabled: true`. A retired record ages by `retiredAtAppVersion`
under the same rule, but is pruned only once every plugin in its
`successors.plugins` has consumed it (`consumedBy`, Migration): plugins do
not auto-update, and a user who updates the app before the successor
plugins must not lose the choices the record carries. The loader takes the
running version as an optional constructor argument and prunes nothing
when it is absent or not a stable semver core — keeping data is the safe
failure.

**A damaged kind entry never turns a kind on.** The settings loader keeps a
kind entry only under a key in the `<pluginId>:<kind>` / `@host:<kind>`
grammar with the manifest's bounds — a plugin id of 3 to 64 characters
(`schemas/plugin-manifest.schema.json:22-27`) and a kind id of 2 to 32 —
(anything else is dropped with a warning), and an entry whose
`enabled`, `osNotification`, `seenByUser` or `visibility` is out of shape is
replaced by the fail-closed choice `{ enabled: false, osNotification: false,
visibility: "silent", seenByUser: false, repaired: true }` rather than
dropped: a dropped entry would resolve again from the kind's declaration,
which for a third-party kind may say `defaultEnabled: true`, while the
repaired entry stays off and is marked new. `repaired` is what enforces
that: the retirement re-resolution above skips repaired entries, the
escalation rule only ever resets to off, and delivery reads `enabled`; so
no automatic transition can turn a repaired entry on, only the user's own
`setKind`, which clears the flag. (`silent` is stored as the lowest
consented visibility so a later declaration counts as an escalation, but
the flag, not the visibility, carries the guarantee.) An invalid
`absentSinceAppVersion` alone only loses that field. A `repaired` key that
is present with any value other than `true` is itself damage to the flag
that carries the guarantee, so the entry is treated as malformed and
becomes the fail-closed choice again — reading it as absent would let a
later retirement mapping turn the entry on. This guarantee is about kind
entries, and it holds for as long as the entry exists: a repaired entry is
never pruned for absence (above); what a damaged retired record means is
under Migration.

**Opt-in is the rule, and it is a visible loss.** Every kind in this page
declares `defaultEnabled: false`, including the successors of the OS
notifications that `lyra-mail` (`email.new`, `email.action.needed`) and
`meeting` (`meeting.summary.created`, `meeting.summary.degraded`) send today
through `notificationEvents`. When those plugins update, users stop receiving
new-mail and meeting-summary notifications until they turn the corresponding
kinds on. Discoverability, without any default-on kind:

- Each plugin's config tab (`src/ui/renderer/tabs/PluginConfigTab.tsx`, the
  `plugin-config-installed` section, line 583) gains a host-drawn **Alerts**
  section under the plugin's own `PluginConfigSchemaForm`: the plugin's
  `reasoning`, then one row per kind — label, description, enabled toggle,
  OS-notification toggle where declared, the "new" mark, and a "superseded,
  waiting for `<predecessor label>` to be removed" note while step 3 blocks
  it. The note offers **Remove** only through the retaining uninstall path
  (`ALERTS.removePredecessor`, which in main calls the marketplace uninstall
  with `retain: { reason: "superseded" }`, Migration — the renderer's
  `UninstallRequest` never carries `retain`). When the predecessor is
  policy-locked (`assertNotRequiredByPolicy`, `service.ts:878`, would refuse)
  the note shows "managed by policy" instead of the button; a revoked
  predecessor that is still loaded shows "silenced at next restart". The
  host's own kinds appear under a "Built-in" heading with the master OS
  switch.
- The installed-plugins list shows a count badge of unseen kinds per plugin,
  and the marketplace's post-install and post-update views say "N alert kinds
  available, all off" and open that plugin's config tab directly (they run in
  the same renderer and already hold the plugin id). The section is nested
  inside the selected plugin, so it is not its own anchor; onboarding cards
  point at the existing `plugin-config/plugin-config-installed`
  (`PluginOnboardingAction`, `public-contract.ts:676-685`, whose `tab/section`
  grammar is unchanged), and `settings-section-anchors.test.ts` is unchanged.
- A `CHANGELOG.md` entry for the alerts release states the loss plainly.

Install and update review keep showing the descriptor `authority` only
(`src/marketplace/app/service.ts:677,758,778-782`); `alerts` is a manifest
block outside `PLUGIN_AUTHORITY_FIELDS` (`src/marketplace/resolve/manifest-rules.ts:20-28`)
and the descriptor schema is not changed — `pluginAuthority` is
`additionalProperties: false`, and a new field there would make older apps
drop the package. The "first seen in an update resolves off" rule above is
what replaces consent at review time.

IPC (`src/shared/ipc-channels.ts`, preload `window.aveApi.alerts.*`, all behind
`validateHostRendererSender`; covered by `channel-inventory.test.ts` and
`preload-shape.test.ts`):

```ts
export const ALERTS = {
  listKinds: "ave:alerts:list-kinds",       // invoke → AlertKindRow[] (declaration + effective choice + blocked state + pluginLabel)
  setKind: "ave:alerts:set-kind",           // invoke(kindKey, patch) → AlertKindRow; also clears the "new" mark
  kindsChanged: "ave:alerts:kinds-changed", // main → renderer after any change or plugin install/uninstall/update
  listOpen: "ave:alerts:list-open",         // invoke → OpenAlertRow[] (for the overlay region on restart)
  removePredecessor: "ave:alerts:remove-predecessor", // invoke(kindKey) → UninstallResultView; main adds retain:{reason:"superseded"}
} as const;
```

## Security and privacy rules

- **Nothing the host renders or hands to the model is free text from a
  plugin.** The user-visible summary, the model-facing prompt and the OS
  notification body are declared templates; runtime input is slot values that
  are typed, capped, sanitised and — in the prompt — wrapped as untrusted
  data, ids included. Templates are validated for `<`/`>` so a plugin cannot
  declare a template that closes the wrapper. This is why declared templates
  were chosen over host sanitisation of free text: sanitisation bounds length
  and characters, not meaning; a template bounds what an alert can *say* and
  moves localisation to the host.
- **Ids reach the model only as a wrapped footer, never the card.** The
  plugin's `appendEmailIdForLlm` rule becomes the `ref` slot rule.
- **OS notifications carry no user content.** Static body, kind label as
  title, `alertId` never rendered, no slot text on the toast-to-OS fallback
  path.
- **Audit, events and `open.json` carry only `alertId`, kind ids and enums.**
  `maskSensitiveData` (`src/shared/dlp.ts:243`) is applied to any diagnostic
  line that could include a slot value. `alertId` is an HMAC, not a hash.
- **`inherits` and `configInherits` read retired records only, never a live
  plugin's config, and only when the retirement entry names the reading
  plugin in `successors.plugins`.** A same-source successor may use both; an
  `anySource` successor may use `inherits` only, so a plugin that merely
  shares an id with the intended successor learns at most the toggle bits
  and never a config value. The retired record carries that list, so a
  plugin cannot copy an arbitrary revoked plugin's config into its own
  (`configInherits.from`) or probe it through `disabled_by_user`; the
  authorisation is marketplace data, reviewed with the revocation.
- **Budgets are host-owned and not raisable from a plugin:** per-kind
  cooldown, per-plugin rate, `ttlMs` clamp, 12 kinds, 3 open cards per kind,
  slot caps.
- **The accepted conversation keeps every permission gate.** The turn is a
  `plugin-emitted` staged origin; tools the model calls from it pass the
  loop's ordinary approval chain and the force-ask rule for that origin.
- **A plugin may only lower visibility**, and an update cannot raise a kind's
  effective visibility or enable it without the user.

## Superseding the three mechanisms

| Mechanism | Fate | Deprecation owner | Removal condition |
| --- | --- | --- | --- |
| `notificationEvents` | Deprecated at the alerts release. Keeps working through the window; the host warns once per plugin at load when a manifest declares both `alerts.kinds` and `notificationEvents`, and the marketplace repository check flags a descriptor that declares `notificationEvents` with `minAppVersion` at or above the alerts release. | ave maintainer | The follow-on release PR adds `notificationEvents` to `RETIRED_EXTENSION_FIELDS` (`manifest-validation.ts:95`), which drops the field with a warning instead of failing the strict vendor block (`manifest-validation.ts:447-493`), and removes `registerPluginNotifications` and the contract type. Prerequisite: `local-indexer` has published a version on the alert contract. |
| `triggerConversation` | **Survives** for one-time suggestions: a plugin-authored prompt that seeds a conversation once (the local-indexer rescan suggestion, `plugins/local-indexer/source/src/rescanSuggestion.ts:210`; the daily-briefing routine suggestion below). Those carry no third-party content and need arguments a typed slot cannot express (`routine_schedule` calls). Structural limit, not a review rule: a plugin whose manifest declares an `alerts` block also declares its overlay suggestion sources — `alerts.suggestions: ["overlay:lyra-mail-daily-briefing-routine"]`, at most 4 entries, each a full `triggerConversation` `source` string that validation checks against `OVERLAY_TRIGGER_SOURCE_PATTERN` (`^overlay:[a-z][a-z0-9-]*$`, `staged-origins.ts:108`) and the `--` ban — and for such a plugin `triggerConversation` accepts only a declared source (`ConversationTriggerResult.reason: "source_not_declared"`, a new member of the union at `public-contract.ts:1989-1994`) and at most one acceptance per declared source per 30 days (`reason: "suggestion_limit"`; `trigger-gate.ts`, stored in the `alerts` namespace). The overlay source is distinct from the routine's idempotency marker (`RoutineRecord.source`, `suggestion:lyra-mail:daily-briefing`, checked with `hasRoutineBySource`), exactly as vega-helper keeps `overlay:vega-helper-daily-briefing-routine` and `suggestion:vega-helper:daily-briefing` apart (`dailyBriefingRoutineSuggestion.ts:18,21`). Declaring the source is the grant; the fixed list is what stops a plugin from rotating suffixes on the free source string, which the source pattern would otherwise allow. Scoping is fail-closed: a manifest that carries an `alerts` block counts as "declared" even when the block is refused as malformed, so a deliberately broken block cannot evade the limit. So the path can only serve a handful of one-time suggestions. The limit is scoped to plugins on the contract because the plugins that are not yet on it are exactly the ones the transition must not silence: vega-helper 0.11.3 raises every recurring alert through `triggerConversation` with one fixed `source` per intent (`decide.ts:160,282,362,428,498`, `meeting-room-suggest-detector.ts:261`, `webex-link-missing-detector.ts:196`, `video-conference-reserved-detector.ts:167`, `meeting-summary-detector.ts:140`), and while it is installed its successors' kinds are blocked — an unscoped limit would leave that window, which is indefinite for a policy-locked package, with no alerts at all. Declaring `alerts` is the plugin's statement that its recurring alerts use the contract. Until the scoping is lifted, a plugin without an `alerts` block evades the limit; that is accepted — such a plugin has the unlimited path today and loses it at the follow-on release, when every official plugin is on the contract. `visibility` and `priority` are accepted and ignored. | ave maintainer | `visibility` and `priority` leave `ConversationTriggerSpec` in the follow-on release PR, which also drops the `alerts`-block scoping once `notificationEvents` is retired and every official plugin is on the contract. |
| `workProposals` / `proposeWork` | Unchanged. A proposal is durable work; an alert is a time-bound nudge. | — | — |

## Plugin-side changes

Signal ownership and grants: an event has exactly one owner, the last plugin
that registered it (`src/plugins/runtime/index.ts:2199-2201`,
`inferEventOwner` at `:2982`), and subscribing to another plugin's event needs
a `pluginAccess.plugins[].events` grant naming that owner
(`assertEventSubscribeAccess`, `index.ts:345-375`; grant ↔ descriptor lockstep
`src/marketplace/resolve/manifest-rules.ts:85`). Every subscription below is
grounded in that: nothing trusts "any mail source". Every grant, capability
and dependency added below is a `PLUGIN_AUTHORITY_FIELDS` change and lands in
the plugin's `ave-package.json` descriptor in the same commit.

### lyra-mail 0.5.3 → 0.6.0 (`requires.minAppVersion`: the alerts release)

Gains:

- `alerts.kinds`, all `defaultEnabled: false`: `mail-approval`, `mail-meeting`,
  `mail-action`, `mail-reply` (slots `subject`, `senderName`, `emailId:ref`),
  `mail-new` (`summary-only`, the successor of the `email.new` notification),
  `calendar-event-prep` (slots `subject`, `minutesUntilStart`, `eventId:ref`;
  `bypassFocusGate: true` as the plugin's manifest had it), `calendar-conflict`
  (slots `subject`, `conflictSubject`, `eventId:ref`). Each declares
  `osNotification` with the plugin's fixed body text
  (`notification-metadata.ts`) and, except `mail-new`, `inherits` from
  `vega-helper`.
- Moved code from `plugins/vega-helper/source/src/decision/`:
  `mail-keywords.ts`, `meeting-detector.ts`, `approval-detector.ts`,
  `action-detector.ts`, `reply-detector.ts`, `calendar-event-detector.ts`,
  `calendar-conflict-detector.ts`, `classify-l2.ts` (over `hostApi.callLlm`,
  20 calls per 10 min, `src/boot/conversation.ts:605-612`), the sender policy from
  `meeting-detector.ts` under the config key `alertSenderDomains` (the plugin
  keeps its own default; the host has none) filled from the user's former
  `meetingDetectorAllowedSenderDomains` by `configInherits` (Migration),
  `limits.ts` and the tests. Detection runs in the watchers' emit path:
  `emailWatcher.ts` `emitFreshFromPage` already runs `analyzeEmail` per mail;
  the four mail detectors run beside it, and the first verdict in the ladder
  calls `raiseAlert`. `calendarWatcher.ts` raises at the
  `calendar.event.upcoming` and `calendar.event.conflict.detected` sites
  (`calendarWatcher.ts:185, :215`).
- A new owned event **`calendar.events.loaded`** `{ events: CalendarEvent[],
  reason: "first-load" | "auth-changed" | "requested" }` with full rows
  (`plugins/lyra-mail/source/src/calendar/types.ts:1-14`: `attendees`,
  `bodyText`, `organizer`, `onlineMeetingUrl`, `webLink`, `isOnlineMeeting`,
  `location`), covering today and tomorrow (two days), emitted on the
  watcher's first successful load, on
  `lyra-mail.auth.changed`, and in answer to `meeting.calendar.snapshot.requested`
  (a meeting-owned event; lyra-mail subscribes with a
  `pluginAccess.plugins[{ pluginId: "meeting", events: [...] }]` grant). The
  answer is served from a 60 s cache of the last two-day fetch, so a burst
  of requests (meeting restarting twice, or several successors starting
  together) costs one Graph call; a request cannot loop, because lyra-mail
  never requests and meeting never answers. The answer path exists because
  the loaded event is push-only: the watcher
  fetches immediately at start (`calendarWatcher.ts:58`), typically before
  `meeting` has subscribed, and `meeting` restarts on every update and on a
  `config.set` that changes cleartext config while no restart is unsafe
  (`host-api-factory.ts:626-650`, rule at `config-restart-policy.ts:87`),
  which includes the one that turns its calendar automation on. vega-helper pulled the same snapshot
  at its own start and on `plugin.installed` (`hostPlugin.ts:1173`). This
  replaces the snapshot it requested at boot (`calendarDays: 2`,
  `hostPlugin.ts:373`): the watcher itself emits no `calendar.event.added` on
  first load (`calendarWatcher.ts:141-146`) and `injectEvent` (`:106`) emits
  none, and it sees today only.
- The daily-briefing tool **`lyramail_daily_briefing`**: vega-helper's
  isolated generate function moved in — mail list, two-day calendar, then a
  tool-less `hostApi.callLlm` with the plugin's injection banner and
  directives, returning the briefing text. Raw mail never enters a session
  that holds write tools (`lyramail_email_reply`, `lyramail_calendar_create`);
  the briefing routine calls this one tool.
- `host:overlay`, for one suggestion: the daily-briefing routine setup
  (Migration). Two sources, as in vega-helper: the overlay trigger's
  `source: "overlay:lyra-mail-daily-briefing-routine"`, declared in
  `alerts.suggestions`, and the proposed routine's idempotency marker
  `source: "suggestion:lyra-mail:daily-briefing"`, checked with
  `hasRoutineBySource`.

Deleted: `eventSubscriptions: ["vega_helper.snapshot.requested"]`, the
`pluginAccess.plugins[vega-helper]` grant, the `lyra-mail.snapshot.ready`
emit and its handler, and both `notificationEvents` entries. Bus events
(`email.*`, `calendar.*`) are otherwise unchanged.

### meeting 0.8.5 → 0.9.0 (`requires.minAppVersion`: the alerts release)

Gains:

- `alerts.kinds`, all `defaultEnabled: false`: `summary-ready` (slots `title`,
  `highlights:list(3)`, `actionItems:list(3)`, `sessionId:ref`; the follow-up
  call-to-action of `meetingSummaryPrompt` becomes the template; inherits
  vega-helper's `meeting-summary`), `summary-degraded` (`summary-only`:
  toast or OS notification, nothing to the model).
- Moved: `meeting-summary-detector.ts` and its template, raised at the
  `meeting.summary.created` emit site (`plugins/meeting/source/src/hostPlugin.ts:2843`).
- **Calendar automation, plugin-owned.** Subscribes to `calendar.events.loaded`,
  `calendar.event.added`, `calendar.event.upcoming`, `calendar.event.starting`
  with a `pluginAccess.plugins[{ pluginId: "lyra-mail", events: [...] }]`
  grant, and ports the relay from `vega-helper` `hostPlugin.ts`:
  `isRecordableCalendarEvent`, bulk prep registration from the loaded rows,
  the 5-minute prep timer and the start timer, once-per-event `prepTriggered`
  / `recordingStarted` sets, and `meetingContextForCalendar` over the full
  row. The `wa-<hash>` session-id derivation is **kept** and the once-per-event
  sets are keyed by `eventId` across both the plugin's own subscriptions and
  vega-helper's `vega_helper.meeting.prep.requested` /
  `.recording.requested` relay events, which the plugin keeps handling through
  the window, so an overlap with a still-installed vega-helper is
  idempotent rather than doubled. At start, and again whenever the automation
  is switched on, the plugin emits its own `meeting.calendar.snapshot.requested`
  and receives `calendar.events.loaded` with `reason: "requested"` (grant
  above). A flat plugin setting `calendarAutomationEnabled: boolean` gates
  it, **default off**; `configInherits` sets it on for former vega-helper
  users (Migration).
- The three `vega_helper.*.requested` subscriptions, their grant and their
  handlers stay until the follow-on plugin release, then go.

Deleted now: both `notificationEvents` entries (`meeting.summary.created`
with raw title and summary, `meeting.summary.degraded`).

### orion-api 0.21.5 → 0.22.0 (company git; `requires.minAppVersion`: the alerts release)

Gains: `alerts.kinds` `room-suggest`, `webex-link-missing`,
`conference-prep-register`, all `defaultEnabled: false`, with the plugin's own
templates (they may name ORION facilities and tools) and `inherits` from
vega-helper's three ORION intents; `eventSubscriptions: ["calendar.event.added"]`
with a grant to `lyra-mail` (the ORION detectors took only `added` in
vega-helper; running them over `calendar.events.loaded` would re-alert on
every boot); moved
`meeting-room-suggest-detector.ts`, `webex-link-missing-detector.ts`,
`video-conference-reserved-detector.ts` and templates;
`dependencies: [{ pluginId: "meeting", required: false }]` because the
prep-register prompt tells the model to call `meeting_bulk_upsert_preps`. The
reservation detector runs in-process at the `orion-api.video-conference.reserved`
emit site (`ave-plugin-orion/src/hostPlugin.ts:2667`); the event stays for other
subscribers. `host:overlay` is not needed: alerts do not use it.

### vega-helper

No further version. Retired by revocation (below). Its chat tools
`vega_helper_set_detector_enabled`, `vega_helper_list_detectors` and
`vega_helper_generate_daily_briefing` retire with it; the Settings section
replaces the first two and `lyramail_daily_briefing` the third. Its
marketplace index entry **stays** until the legacy-binding window closes
(`docs/design/multi-source-git-marketplace.md` §16.3 binds a pre-marketplace
install only when the id exists in the official snapshot; a user upgrading
straight from an old build after the entry vanished would keep an unbound
vega-helper that no revocation can reach). The directory is deleted in the
follow-on monorepo change, with the revocation entry kept.

### local-indexer

Unchanged now. Its two `notificationEvents` (`index.scan.completed`,
`index.folders.changed`, 0.6.7) move to `summary-only`, `defaultEnabled: false`
kinds before the follow-on release PR, which is the prerequisite for retiring the
field; that manifest also declares its rescan suggestion source in
`alerts.suggestions`, since a plugin on the contract may trigger only
declared sources.

### Release order and the combinations

The alerts release ships first. The monorepo then lands **one commit** with
`lyra-mail` 0.6.0, `meeting` 0.9.0, the descriptor changes, the re-vendored
`contract/` and `tools/vendor/marketplace-check.js`, and the conditional
revocation of `vega-helper`; `orion-api` 0.22.0 is published to the company
source the same day. Plugins do not auto-update, sources sync independently,
and an uninstall can fail, so the predecessor rule (step 3) is what makes the
pairings safe rather than the order:

| App | Plugins | Outcome |
| --- | --- | --- |
| before the alerts release | any | Nothing changes: 0.6.0 / 0.9.0 / 0.22.0 are `upgrade_required` (`chooseVersion`, `src/marketplace/catalog/aggregate.ts:129`), the conditional file is not evaluated, `vega-helper` keeps running. |
| alerts release, snapshot pinned by an older app at the same commit | old | The snapshot's format version is older, so the first sync rebuilds it at the same pin (Retirement) and the conditional entry appears; until then the retirement entry is unknown, so any installed successor's kinds are blocked by the predecessor's name alone. |
| alerts release, after sync | old lyra-mail / meeting | The revocation uninstalls `vega-helper` (retired record written). Mail and calendar cards stop until the user accepts the offered `lyra-mail` update; the marketplace tab shows the revoked package with a reason naming the successors, and the update badge is on. The old `notificationEvents` keep firing in the window. Bounded vanish, no doubling. |
| alerts release | new plugins, vega-helper gone | Contract path only; kinds resolve from the retired record. |
| alerts release | new lyra-mail, old meeting | Calendar automation vanishes until `meeting` updates; mail and calendar alerts work. |
| alerts release | new meeting, old lyra-mail | `calendar.events.loaded` does not exist yet; preps appear only from `upcoming`; summary alerts work. |
| alerts release | `orion-api` 0.22.0 from the company source before the official source synced | The retirement entry is not known yet, so its three kinds are `blocked_by_predecessor` by name while vega-helper is installed; the reserved-event path works once it is gone. |
| alerts release | revocation applied mid-session, uninstall failed (`service.ts:1080-1081`) or the package is `lockedByPolicy` / a required install | Vega-helper stays installed and revoked, and keeps running until the next restart because `markRevoked` acts only at load; the successors' kinds stay blocked while it is loaded (no doubling), the retired record was already written when the revocation was applied (Migration), and after the restart the load is refused, the block lifts and the kinds resolve from that record. The Settings note reads "silenced at next restart" while it is loaded; a policy-locked predecessor that is not revoked shows "managed by policy" and blocks until policy changes. |
| alerts release | vega-helper with `sourceId === null` (never bound) | The per-source feed (`service.ts:1043-1045`) cannot reach it, but the index entry still exists so legacy binding can; a `null` source matches the predecessor rule, so inheriting kinds are blocked, and vega-helper itself keeps alerting through `triggerConversation` (the acceptance limit does not apply to it). |

The pairing "new meeting on an old app" is what forces `meeting` to require
the alerts release: on an older app it would register preps beside
`vega-helper`'s relay without the host-side blocking rule.

## Retirement by revocation

`policy/revocations.json` cannot carry an app-version condition:
`schemas/marketplace/revocations.schema.json` is `additionalProperties: false`
at both levels with `schemaVersion: { const: 1 }`, and an invalid file
**rejects the whole source commit and keeps the previous pin**
(`docs/design/multi-source-git-marketplace.md:129-134`,
`src/marketplace/sources/snapshot.ts:277-290`). A new field or schema version
would freeze every older app's official source forever.

So the condition lives in a **sibling file** that older apps never open:
`policy/revocations-by-app.json`, read by the alerts release and later,
validated by its own schema (`schemas/marketplace/revocations-by-app.schema.json`),
same entry shape plus a required `appVersions` minimum (evaluated with
`appVersionSatisfiesMin`, the `minAppVersion` rule, `aggregate.ts:83`) and a
`successors` block: `plugins` — the plugins allowed to inherit from this
package's retired record, each either a plugin id from the same source as
the entry, or `{ pluginId, anySource: true }` for a successor that lives in a
source the official data cannot name (custom and managed source ids are
chosen per install, `src/marketplace/sources/registry.ts:400-405`, and a
managed id may be an organisation name); an `anySource` successor may use
`inherits` (toggles) only, never `configInherits` — and `hostKinds` for the
host's own kinds, each keyed by the full `@host:<kind>` settings key with a
required `enabled` rule and an optional `osNotification` rule (Migration).
Absent file = no entries. An invalid file rejects the
commit exactly as `revocations.json` does, for the same reason: a policy file
that cannot be trusted must not partially apply.

```json
{
  "schemaVersion": 1,
  "revocations": [
    {
      "kind": "plugin",
      "name": "vega-helper",
      "versions": "*",
      "appVersions": "0.12.0",
      "reason": "Superseded by the plugin alert contract. Mail and calendar alerts ship in lyra-mail 0.6.0, meeting alerts in meeting 0.9.0, ORION alerts in orion-api 0.22.0.",
      "at": "2026-10-01T00:00:00Z",
      "action": "uninstall",
      "successors": {
        "plugins": [
          { "pluginId": "lyra-mail" },
          { "pluginId": "meeting" },
          { "pluginId": "orion-api", "anySource": true }
        ],
        "hostKinds": [
          { "kind": "@host:due-soon",
            "enabled":        { "key": "disabledDetectors",     "listed": "disabled", "values": ["work-item-due-soon"] },
            "osNotification": { "key": "osNotificationIntents", "listed": "enabled",  "values": ["work-item-due-soon"], "masterKey": "osNotificationsEnabled" } }
        ]
      }
    }
  ]
}
```

Integration, in the snapshot rather than at the feed:

- `SourceSnapshot` (`snapshot.ts:50-58`) gains `formatVersion: 2` and
  `conditionalRevocations: ConditionalRevocation[]`, stored **raw**. The
  builder reads the sibling file beside `policy/revocations.json` (`:71`,
  `:276-283`).
- `sync.ts:181-187` no-ops today when the candidate equals the pin and a
  snapshot file exists. It now also requires `formatVersion` to be current; a
  snapshot without the field counts as version 1, and an older snapshot at
  the same pin is rebuilt. Without this, a user who synced on an older app
  and then upgraded would keep a snapshot without the conditional entries
  while `chooseVersion` already offered the successors.
- One accessor `effectiveRevocations(snapshot, appVersion)` returns the plain
  entries plus the conditional entries whose `appVersions` the running
  version satisfies (`appVersionSatisfiesMin`). **Every** consumer reads
  through it:
  `aggregate.ts:155` (`chooseVersion`), `service.ts:682,693` (install and
  update review), `views.ts:137` (`versionViews`), the boot feed
  (`src/boot/steps/revocation-bootstrap.ts`) and `readRevocations`
  (`sync.ts:304`, which today serves only the feed). From there nothing
  changes: `revocationFeed` (`src/marketplace/app/revocations.ts`),
  `revocationRegistry` (`src/plugins/revocation/revocation-registry.ts`),
  `markRevoked` at the load boundary (`src/plugins/runtime/index.ts:2957-2980`,
  refusing the load with `plugin-revoked`), `applyRevocations` uninstalling on
  `action: "uninstall"` (`service.ts:1068-1085`), `versionExclusions` hiding
  it from install (`aggregate.ts:90`), and the revoked-package view in
  `GitMarketplaceTab.tsx`.
- `repository-check.ts` and the monorepo's `tools/vendor/marketplace-check.js`
  validate the new file; the monorepo re-vendors `contract/` and the check in
  the same commit.

No plugin id appears in host source; the id is marketplace data.

## Migration of user choices

Three generic host rules and two manifest fields carry the user's choices into
the successors without the host naming any plugin.

1. **A retirement writes a retired record before anything is removed.** The
   record is `settings.retiredPluginConfigs[<id>] = { config, enabled,
   sourceId, retiredAtAppVersion, successors, consumedBy }`, where
   `consumedBy` starts as `[]` and collects the plugin ids that have applied
   the record (below), and `config` is the
   package's *effective* config computed by the same layered function the
   live getter uses (`host-api-factory.ts:574-578`: manifest defaults,
   wildcard entries, stored values — one shared helper, not a re-derivation
   from `applyConfigDefaults` alone), `enabled` is the registry flag, and
   `successors` is copied from the retirement entry. Two writers, one
   helper:
   - **The revocation feed.** `applyRevocations` (`service.ts:1068-1085`)
     writes the record when it applies an `uninstall` revocation, before
     calling `this.uninstall`, and **only if no record for that id exists**:
     a locked or failed package is re-applied on every feed, and a rewrite
     would move `retiredAtAppVersion` forever, re-trigger the one-time
     re-resolution and `configInherits`, and defeat the removal migration.
     The effective config is computed from the installed manifest **on
     disk** (the package directory's manifest, read through the same layered
     helper), not from the runtime: a revoked plugin was refused at load and
     has no runtime manifest, which is also why the lifecycle's own lookup
     (`uninstall-lifecycle.ts:408`, `getPluginManifest(...)?.configSchema`)
     cannot serve this path. A failed uninstall (`:1082`) or a policy-locked
     package therefore still leaves the record, and the successors' kinds
     resolve from it once the predecessor stops blocking.
   - **The uninstall lifecycle**, for the superseded-row path. The call chain
     is `this.uninstall` → the installer port `uninstall(name)`
     (`src/ipc/domains/git-marketplace.ts:151`, `InstallerPorts` in
     `src/marketplace/app/ports.ts`) → `uninstallPluginWithLifecycle`
     (`src/plugins/uninstall-lifecycle.ts:338`). The `config` phase
     (`uninstall-lifecycle.ts:155-156`) runs in journal replay after the
     runtime and files are gone, and crash recovery
     (`recoverPendingPluginUninstallCleanups`, `src/boot.ts`) replays the
     same record, so the capture happens at `journal.prepare`: the lifecycle
     takes an internal `retain: { reason: "revoked" | "superseded", sourceId,
     successors }` option (never accepted from the renderer's
     `UninstallRequest`), computes the same effective config and `enabled`,
     and stores them in the `PluginUninstallCleanupRecord`
     (`src/plugins/plugin-uninstall-cleanup-journal.ts:6`); the `config`
     phase writes the retired record from it if none exists and removes
     `pluginConfigs[<id>]` as today.
   A user-initiated uninstall keeps deleting. The retained record is dropped
   by the settings loader when it is two minor releases behind the running
   version by `retiredAtAppVersion` (the same rule and the same fail-safe as
   `absentSinceAppVersion`) **and** `consumedBy` contains every
   `successors.plugins[].pluginId`; a record with an unconsumed successor is
   kept for as long as it takes, because plugins do not auto-update and the
   choices it carries belong to the user. Consumption is one decision per
   successor, taken by the alerts service when **both** of its stages have
   reached a durable terminal outcome, and only then is the plugin id
   written to `consumedBy`:
   - **Readiness.** A successor version is ready when its loaded manifest
     names the predecessor in at least one kind's `inherits` or in
     `configInherits`. An installed *old* version (the supported pairing
     under Release order) declares neither; it is not consumed and the
     record stays pending — an empty declaration must not count as done.
     Consumption is attempted at record-write time and again on every
     registration of the successor (install, update, load), so the version
     that first declares the inheritance is the one that consumes.
   - **Kinds stage** is terminal when every inheriting kind of the plugin
     has a written-back entry: resolved from the record, or intentionally
     left alone because the entry is visited or repaired (re-resolution
     never touches those, so waiting would never end). A kind that is
     `blocked_by_predecessor` is not terminal — a loaded predecessor blocks
     resolution until restart — and the attempt is retried when the
     predecessor stops blocking.
   - **Config stage** is terminal when every `configInherits` entry naming
     the predecessor has been applied, or intentionally skipped: the target
     key already set, the record's `enabled` false (nothing to copy), or the
     successor named `anySource` (config inheritance is refused for it).
   Host kinds are consumed at record-write time and need no entry. There is
   no cap on retained records: one per retired plugin id, bounded by the
   plugins an install ever had. A record with
   any field out of shape is dropped whole on load: a half-repaired record
   would hand a successor choices nobody made. Dropping it is a loss of
   inheritance, not a fail-closed repair — a successor installed afterwards
   resolves from its own declaration, exactly as for a user who never had
   the predecessor, which for every official successor means off and for a
   third-party successor means whatever it declares. The kind-entry
   guarantee (Settings) does not extend to this case, and this page says so
   rather than pretending a tombstone could carry choices nobody can read.
   Writing the record also triggers `configInherits` for installed successors
   and the one-time re-resolution of auto-resolved kinds (Settings).
2. **`inherits` on a kind**, resolved only from a retired record whose
   `successors.plugins` names the kind's plugin (same source as the entry,
   or `anySource`), only once the predecessor no longer blocks (step 3),
   and only when `enabled` in that record is `true` — a user who had disabled the
   whole plugin (`runtime/index.ts:297-306`) is treated as never having had it.
   An `inherits` entry naming a plugin whose record does not list the reader
   is ignored with a load warning:

   ```jsonc
   "inherits": [{
     "pluginId": "vega-helper",
     "sourceId": "ave",   // required; predecessor source hint, used only before the retirement entry is known (step 3)
     "enabled":        { "key": "disabledDetectors",     "listed": "disabled", "values": ["mail-reply", "reply-detection"] },
     "osNotification": { "key": "osNotificationIntents", "listed": "enabled",  "values": ["mail-reply"], "masterKey": "osNotificationsEnabled" }
   }]
   ```

   `enabled` is required and `osNotification` optional — a kind that
   declares no OS notification has nothing to inherit there; `values` is a
   non-empty list of non-empty strings — an empty `listed: "disabled"` rule
   would read as "on" for every former user, so it is malformed and takes
   the block (manifest) or the record (retirement) with it. `enabled` is
   true unless any of `values` is in the
   list at `key` (or false unless listed, per `listed`); `osNotification`
   likewise, and false when `masterKey` is `false`. Because the record holds the *effective* config,
   a user who never opened vega-helper's settings inherits its defaults
   (alerts on), and a user who saved only `disabledDetectors` keeps the
   default OS-notification intents. With no record at all — the user never
   had the plugin, or had it disabled — the kind's `defaultEnabled: false`
   applies. `values` lists both current and legacy spellings, which is where
   `LEGACY_INTENT_REMAP` (`hostPlugin.ts`: `meeting-detection`,
   `approval-detection`, `action-detection`, `reply-detection`) goes; the
   three ORION intents are inherited by `orion-api`'s kinds the same way, and the
   host kind's mapping travels in the revocation entry's `successors` block
   with the same shape.
3. **`configInherits` on a plugin manifest** fills a flat plugin config key
   from a retired record, only if the target key is unset, only when the
   record's `successors.plugins` names the plugin, and only when the record's
   `enabled` is `true` (for `from` and `value` alike):

   ```jsonc
   "configInherits": [
     { "pluginId": "vega-helper", "from": "meetingDetectorAllowedSenderDomains", "to": "alertSenderDomains" },  // lyra-mail
     { "pluginId": "vega-helper", "to": "calendarAutomationEnabled", "value": true }                          // meeting
   ]
   ```

   `from` copies a value; `value` sets a constant; an `anySource` successor
   may use neither (its entry is toggles only) — since `anySource` is known
   only from the retirement entry, not at manifest validation, the entry is
   refused when applied, with a load warning. It is applied at the moment
   the retired record is written if the plugin is installed, and otherwise
   when the plugin is next installed. Applying it completes the config
   stage only; the plugin id reaches `consumedBy` when the kinds stage is
   terminal too (Migration 1), never from this path alone.
   `settingsService.setPluginConfig`
   only stores (`settings-store.ts:1649-1658`); the restart lives in the
   `hostApi.config.set` wrapper (`host-api-factory.ts:636-650`) and
   `src/plugins/config-restart-policy.ts`, so after the write the host
   restarts the plugin explicitly through that policy — that restart is what
   makes meeting emit `meeting.calendar.snapshot.requested` when its
   automation is switched on this way. This carries a customised sender list
   (`*`, extra domains) and turns meeting's calendar automation on for former
   vega-helper users only.
4. **The daily-briefing routine.** The record with
   `source: "suggestion:vega-helper:daily-briefing"` has a pre-prompt that
   calls `vega_helper_generate_daily_briefing` and
   `request_plugin({pluginId:'vega-helper'})`, and a scope of
   `{ mode: "allow", ids: ["vega-helper"] }`
   (`dailyBriefingRoutineSuggestion.ts`). The generic host rule for the
   scheduler: a scheduled `llm-session` routine whose allow-list names **no**
   installed plugin (registry) is skipped with
   `lastSkippedReason: "plugins-missing"`; one with some allow-listed plugins
   missing runs and is marked `needsAttention` with the missing ids;
   `RoutinePanel.tsx` shows both with a remove action. "Installed", not
   "loaded", so a plugin update at the scheduled minute is not a skip. The
   replacement is proposed once by `lyra-mail` 0.6.0
   (`hasRoutineBySource("suggestion:lyra-mail:daily-briefing")`, ledger in its
   data dir): a routine whose pre-prompt calls `lyramail_daily_briefing` and
   presents its result, scope `{ mode: "allow", ids: ["lyra-mail"] }`. That
   scope still exposes lyra-mail's write tools (`lyramail_email_reply`,
   `lyramail_calendar_create`, `lyramail_calendar_delete`) to the routine's
   session, and the briefing text is a summary of untrusted mail; the
   routine therefore relies on the tool-stage headless lane
   (`src/tools/pipeline/reviewer-dispatch.ts:80-101`), which is always on:
   with no reviewer attached every gated tool is denied ("headless reviewer
   not wired"), and with a reviewer attached only a `low` verdict passes —
   the lane denies non-low (`src/permissions/permission-manager.ts:133`).
   The effect-boundary deny in `effect-enforcement.ts:326-340` is not the
   guarantee: it sits behind `features.hostClassifiesRisk`, which defaults
   to false (`src/boot/steps/plugin-runtime.ts:291-294`, "pure pass-through";
   `host-api-factory.ts:968`). So the briefing can propose a reply, never
   send one; a test pins that `lyramail_email_reply` is refused in a routine
   under default settings. That lane is a stated dependency of this design,
   not a new rule.

## Host module changes on current main

| Area | File(s) | Change |
| --- | --- | --- |
| Contract | `src/plugins/public-contract.ts`, `schemas/plugin-manifest.schema.json` | `alerts` (kinds, `suggestions`) and `configInherits` manifest blocks, `AlertInput`/`AlertResult`, `raiseAlert`/`withdrawAlert`; `ConversationTriggerResult.reason` gains `source_not_declared` and `suggestion_limit`; `notificationEvents` and the two trigger fields marked deprecated in JSDoc |
| Validation | `src/plugins/runtime/manifest-validation.ts`, `src/marketplace/repository-check.ts` | `getDeclaredAlertKinds` (all-or-nothing), template/slot/locale checks, `alerts.suggestions` (≤ 4 sources), `configInherits` shape, reserved package id `host` in both, warn on `notificationEvents` + `alerts` and on `inherits` without successor authorisation |
| HostApi | `src/boot/steps/plugin-runtime/host-api-factory.ts`, `isolation/host-api-wire.ts`, `host-api-dispatcher.ts`, `host-api-child.ts`, `runtime/sandbox.ts`, `src/permissions/effect-kind.ts` | the two methods, wired like `proposeWork`; `triggerConversation` rejects `--` in `source` and, for plugins declaring `alerts`, accepts only declared suggestion sources with the per-source acceptance limit |
| Pipeline | `src/alerts/*`, `src/boot/steps/alerts-setup.ts`, `src/boot.ts`, `src/boot/types.ts` (`startAlerts`), `src/main.ts` | pipeline, deferred start beside `startWorkBoardDueSoon` |
| Host protocol | `src/plugins/isolation/host-api-wire.ts` (`HOSTAPI_PATH_CONTRACTS`), `host-api-dispatcher.ts`, `schemas/plugin-host-protocol/1/protocol.schema.json`, `src/plugins/isolation/__tests__/fixtures/host-protocol/1/` | `raiseAlert` / `withdrawAlert` as `ave/host/*` methods with `params`, advertised in the `construct` capabilities, the regenerated schema (the `build` gate fails on drift) and a method/reply golden pair |
| Overlay | `src/ui/renderer/context/OverlayContext.tsx`, `OverlayCard.tsx`, `use-routine-overlay.ts`, `TranscriptRenderer.tsx` | `alert` source kind, priority ordering, accept → `alert.withdrawn` |
| Notifications | `src/main/notification-service.ts`, `src/ui/renderer/types.ts:377` | kind `"alert"` in both copies |
| Events | `src/plugins/capabilities.ts`, `src/plugins/runtime/index.ts`, `src/boot/__tests__/event-namespace-policy.test.ts` | `alert` host-only emit, per-plugin delivery filter with grants |
| Work Board | `src/work-board/due-soon.ts`, `work-board-setup.ts` | raise `@host:due-soon` through the pipeline |
| Settings | `src/data/settings-store.ts`, `settings-defaults.ts` | `alerts` (with `visibility`, `seenByUser`, `absentSinceAppVersion`), `retiredPluginConfigs`; no new section anchor — the Alerts block nests in the selected plugin under `plugin-config-installed` |
| IPC / preload | `src/shared/ipc-channels.ts`, `src/ipc/domains/alerts.ts`, `src/ipc/index.ts`, `src/preload/internal-api-surface.ts` | `ALERTS` channels |
| Settings UI | `src/ui/renderer/tabs/PluginConfigTab.tsx`, marketplace post-install/update views | per-plugin Alerts section, unseen-kind badge |
| Marketplace | `src/marketplace/sources/{snapshot,sync}.ts`, `catalog/{types,validate,aggregate}.ts`, `app/{service,views,revocations}.ts`, `repository-check.ts`, `schemas/marketplace/revocations-by-app.schema.json` | snapshot format version, raw conditional entries, `effectiveRevocations` accessor for every reader |
| Uninstall | `src/plugins/uninstall-lifecycle.ts`, `src/plugins/plugin-uninstall-cleanup-journal.ts`, `src/marketplace/app/service.ts` (`applyRevocations` writes the retired record; `uninstall` passes `retain`), `src/marketplace/app/ports.ts` (`InstallerPorts.plugin.uninstall(name, retain?)`), `src/ipc/domains/git-marketplace.ts:151` (installer port), `src/ipc/domains/plugins.ts` | retired record written at revocation time; internal `retain` option captured at prepare and persisted in the journal record |
| Routines | `src/boot/routine.ts`, `src/main/routines-scheduler.ts`, `RoutinePanel.tsx`, `src/shared/routines-types.ts` | `plugins-missing` skip, `needsAttention` |
| Retirement of host references | `src/plugins/isolation/out-of-process-plugins.ts:417-428, :856` (`OUT_OF_PROCESS_PLUGIN_IDS` census), `src/ui/renderer/onboarding/default-tour-scenarios.ts:183-212, :316-345, :360-371`, `test/screenshots/plugin-seed.ts:224`, `test/screenshots/matrix.ts`, `test/e2e/ui/fixtures.ts:25-29`, `test/e2e/ui/plugin-load.spec.ts:15-19`, `.github/workflows/e2e.yml:59-67`, the `ALLOWED_FILE_LITERALS` entry in the decoupling audit | the last literals go in the follow-on release PR, after the index entry is deleted |
| Docs | `docs/architecture/architecture.md` (Plugin Runtime), `docs/references/overlay-trigger.md`, `CHANGELOG.md` | contract, deprecations, the opt-in loss |
| i18n | `src/i18n/messages/generated/alerts.ts` | `alerts.*`, `be_alerts.*` |

## Tests

Contract tests (host):

- `manifest-validation`: valid block; each malformed entry rejects the whole
  block; kind id pattern, `--` and the cap; slot name pattern; template
  references only declared slots and all declared slots; `<`/`>` in templates;
  `osNotification.body` static and capped; locale maps require `en`;
  `inherits` and `configInherits` shapes, with `inherits[].sourceId` and
  `inherits[].enabled` required and `osNotification` optional — an entry
  without `sourceId` or `enabled` refuses the block.
- Settings store: `alerts` and `retiredPluginConfigs` default on a fresh
  install and on a file without them; a generic `patch()` carrying either
  leaves both unchanged; a `set()` of either round-trips through the file
  and the loader; a kind entry under an invalid key is dropped, including a
  plugin id shorter than 3 or longer than 64 characters and a
  one-character kind id; an inherit rule with an empty `values` list makes
  its retired record malformed; an entry
  with a field out of shape loads as the fail-closed choice, marked new;
  an invalid `absentSinceAppVersion` alone loses only that field; a retired
  record with any field out of shape (missing `enabled`, non-string
  `sourceId`, `"unknown"` version, `anySource: false`, a plugin kind under
  `hostKinds`, a bad inherit rule, a non-object config) is dropped whole and
  its neighbours kept; a repaired entry carries `repaired: true`, and an
  entry whose `repaired` is present with any other value loads as the
  fail-closed choice — an off, unseen, repaired entry whose flag alone is
  damaged to `"true"` stays repaired, so a later retirement mapping of
  "on" cannot turn it on; a repaired entry with `absentSinceAppVersion`
  survives the two-minor prune; `consumedBy` is required and
  holds valid plugin ids; the two-minor prune drops an absent kind entry
  only when the loader is given a stable running version two minors ahead
  (same major, minor difference ≥ 2) or a higher major, keeps everything
  without a version, and drops a retired record only when both the age rule
  holds and every listed successor is in `consumedBy` — a record retired at
  0.12.0 with one unconsumed successor survives a 0.14.0 and a 1.0.0 load,
  and goes once the last successor has consumed it.
- Pipeline result codes in order: `kind_not_granted`; `invalid` per slot rule
  and key pattern (a 200-char key accepted); `blocked_by_predecessor` while
  the named plugin is installed but not loaded, while it is revoked but
  still loaded, by name plus the `inherits[].sourceId` hint (or a `null`
  source) before the retirement entry is known, for a `null`-source package
  after it is known, and **not** while it is revoked and unloaded, nor for a
  same-named package from an unrelated source before or after the entry is
  known; `disabled_by_user` with a throttled audit row; `refreshed` for an
  open identity (no OS notification, no cooldown charge) and `rate_limited`
  past the refresh budget; `closed` for a dismissed identity until TTL,
  surviving a restart; card-less identities expire at `ttlMs`; the closed
  table caps at 512 per plugin; `cooldown` per kind; `rate_limited` per
  plugin; no window recorded on any refusal; per-kind open cap evicts the
  lowest priority first, then the oldest, with `evicted`.
- Render: sanitiser canary (control, bidi, angle brackets, over-length),
  `list` rendering in both templates, optional slot absent, `ref` footer
  wrapped and present in the prompt only; `alertId` is an HMAC with the
  install secret and the raw key is absent from audit, events and
  `open.json`.
- Visibility routing for the three levels and the lower-only rule; boot
  queue when no window exists; OS notification fires only after acceptance,
  never for a refusal, never for `low`, toast when focused, OS when
  unfocused, `bypassFocusGate` honoured; `withdrawAlert` scoping; cards
  survive a config-set restart and an update, and go on uninstall and
  revocation.
- Toggle resolution: declared defaults; `inherits` from a retired record with
  `enabled: true`, with legacy spellings, with `masterKey` false, with the
  effective defaults of an untouched config; a retired record with
  `enabled: false` behaves as no record; a record whose `successors.plugins`
  does not name the reader is ignored; no resolution and no write-back while
  the predecessor is installed and unrevoked; a kind first seen in an update
  resolves off and is marked new; a visibility escalation resets a visited
  entry to off and new, a lowering does not; an auto-resolved entry is
  re-resolved once when a retired record arrives, a visited entry never,
  and a repaired entry never — a retired record whose mapping says "on"
  arriving over a repaired entry leaves it off, and the user's `setKind`
  clears `repaired`; a visibility escalation over a repaired entry keeps it
  off and repaired.
- Consumption lifecycle: retirement → app upgrade two minors → successor
  update: an installed old successor with no inheritance declarations is
  not consumed and the record survives the upgrade; the version that first
  declares `inherits`/`configInherits` consumes on registration; with the
  predecessor still loaded the config stage completes but `consumedBy` is
  not written until the kinds stage is terminal after the restart; visited
  and repaired kinds, an already-set target key, a disabled record and an
  `anySource` successor's config all count as terminal skips; a successor
  that is never updated leaves the record pending indefinitely.
  `absentSinceAppVersion` set on uninstall, cleared on reinstall, entry
  dropped two minors later; `settings.alerts` is written only through the
  alerts service.
- Host kind: due-soon raises `@host:due-soon` through the pipeline and still
  emits the bus event; resolved off on first boot, then re-resolved from the
  `successors.hostKinds` mapping when the retired record is written; source
  `overlay:host--due-soon` passes the staged-origin pattern and the plugin
  id `host` is rejected by manifest validation.
- Notify: a `summary-only` kind toasts while focused with the OS toggle off;
  the OS notification needs the OS toggle and the master switch.
- Events: a plugin receives only its own `alert.*` events without a grant and
  another plugin's with one; a host-kind `alert.*` event (`pluginId:
  "@host"`) reaches no plugin, with or without grants.
- `triggerConversation`: for a plugin declaring `alerts`, an undeclared
  source is refused with `source_not_declared`, a declared entry that fails
  the overlay source pattern or contains `--` rejects the block, a fifth
  declared source rejects the block, a second acceptance of the same
  declared source within 30 days is refused with `suggestion_limit` and the
  limit persists across restart; a manifest whose `alerts` block was refused
  as malformed still counts as declared; a `source` containing `--` is
  rejected for every plugin; for a plugin without an `alerts` block the
  acceptance limit does not apply.
- Routine lane: `lyramail_email_reply` invoked from a routine session under
  default settings (`hostClassifiesRisk` off, no reviewer attached) is
  refused by `reviewer-dispatch.ts`; with a reviewer attached a non-low
  verdict is still refused.
- `configInherits`: applied when the retired record is written (installed
  successor, plugin restarted) and on a later install; skipped when the
  target key is set, when the record's `enabled` is false, or when the
  reader is not a listed successor.
- Namespace policy, decoupling audit (no plugin id needles in `src/alerts/`),
  channel inventory, preload shape, host-renderer-only guard, settings section
  anchors, i18n catalog.
- Marketplace: conditional file schema; `appVersions` evaluation at the
  running version; absent file is not required by `ensure()`; invalid file
  rejects the commit; a snapshot with an older `formatVersion` at the same pin
  is rebuilt; `effectiveRevocations` is what `chooseVersion`, install review,
  update review, `versionViews` and the feed see; a snapshot without
  `formatVersion` is treated as 1; `markRevoked` refuses;
  `applyRevocations` writes the retired record (effective config through the
  live getter's helper from the manifest on disk, `enabled`, `successors`)
  before uninstalling, only when none exists — a second feed pass leaves
  `retiredAtAppVersion` untouched — and the record survives a failed
  uninstall, a policy-locked package and a refused-load plugin with no
  runtime manifest; an `anySource` successor's `configInherits` is refused
  when applied, with a warning; the
  superseded-row uninstall passes `retain` internally and the journal
  captures it at prepare, including a crash replay of a prepared record; a
  renderer `UninstallRequest` cannot carry `retain`; a user uninstall does
  not retain.
- Routines: no allow-listed plugin installed skips with reason; some missing
  runs with `needsAttention`; installed-but-not-loaded is not missing.
- Deprecation: the load warn for `notificationEvents` + `alerts`; in the
  follow-on change, the field is dropped with a warning, not a load failure.

Per-plugin tests (monorepo and `orion-api`): the ported detector suites, unchanged
in verdicts; a manifest ↔ runtime lockstep extension of each plugin's
`scripts/validate-events.mjs` that scans `raiseAlert({ kind: "<literal>" })`
against `alerts.kinds`; a canary that no `raiseAlert` call passes a raw
subject or sender as `key`; `inherits` values include the legacy spellings;
`configInherits` targets exist in `configSchema`; lyra-mail's
`calendar.events.loaded` on first load, auth change and in answer to
`meeting.calendar.snapshot.requested`, with full rows, and two requests
within 60 s cost one Graph call; meeting emits the request at start and
when its automation is switched on (including the `configInherits` restart),
and keys its
once-per-`eventId` sets across its own subscriptions and the relay events;
orion-api does not subscribe to `calendar.events.loaded`;
`lyramail_daily_briefing` calls `callLlm` with no tools and the injection
banner.

CDP checks (port 9222 against a built app; the `test/e2e/ui` harness):

- A seeded E2E fixture plugin declares one kind with a `text`, a `list` and a
  `ref` slot and a tool that raises it. The spec turns the kind on in the
  plugin's Alerts section (it starts off and marked new), raises, and asserts
  the card in `OverlayCardRegion` with the rendered summary (no footer), the
  in-app toast while focused, the `alert.raised` audit row with `alertId`
  only, and — after accepting — an `ImportedTriggerCard` whose envelope
  carries `overlay:<pluginId>--<kind>` and the wrapped `ref` footer. Raising
  again returns `refreshed` and draws no second card; dismissing and raising
  returns `closed`.
- Toggling the kind off makes the next raise return `disabled_by_user` and
  draw nothing.
- OS notification path: with the window unfocused the notification fires;
  focused, the toast appears instead, unless the kind bypasses.
- `test/screenshots/matrix.ts` re-keys the `vega-helper-*` cards to
  `alert-*` with `source: { kind: "alert", … }`; `test/e2e/ui/fixtures.ts`
  `E2E_PLUGIN_REPOS` and `plugin-load.spec.ts` drop `vega-helper`;
  `.github/workflows/e2e.yml:59-67` stops checking it out.

## Pull request plan

Every PR merges alone and leaves `main` shippable. Settings keys land before
any reader. Common gates: `bun run typecheck`, the touched suites plus their
consumers, `check:import-cycles`, `check:knip`, `check:sot-shapes`,
`check:no-inline-channels`, the naming gate, the decoupling audit,
`check:i18n-catalog` + barrels, `bun run build`.

ave:

1. **Design** — this page and the index line.
2. **Settings and shared types** — `AppSettings.alerts`,
   `retiredPluginConfigs`, normalisation, defaults and their tests,
   `src/shared/alerts-types.ts`. The normaliser and defaults are the readers
   that satisfy `check:knip`; nothing else consumes the keys yet. Gates:
   common + settings-store suites.
3. **Contract, validation and pipeline** — `public-contract.ts`, schema,
   `getDeclaredAlertKinds`, `configInherits`, `src/alerts/*`, `alerts-setup`,
   HostApi methods across the isolation wire (`raiseAlert` and `withdrawAlert`
   become `ave/host/*` methods: a `HOSTAPI_PATH_CONTRACTS` entry with its
   `params`, the dispatcher table and therefore the `construct` capabilities,
   the regenerated `schemas/plugin-host-protocol/1/protocol.schema.json` —
   the build gate fails otherwise — and a method/reply golden pair under
   `__tests__/fixtures/host-protocol/1/`), the overlay source guard in
   `use-routine-overlay.ts:190` and the source-dependent handling after it
   (today only `"plugin"` and `"app"` pass), `NotificationKind "alert"` in
   both copies, overlay `alert` kind with priority ordering, event delivery
   filter, audit, store with rehydration and boot queue, the declared-source
   and acceptance rules for `triggerConversation`. Its CHANGELOG entry
   states the one compatibility change for third-party plugins: a
   `triggerConversation` `source` containing `--` is now rejected (no
   official plugin uses one — vega-helper's sources and
   `overlay:local-indexer-nightly-rescan` contain none). Gates: common +
   trigger-gate, overlay, notification-service,
   isolation wire, runtime event suites + a CDP run with the seeded fixture
   plugin.
4. **Host kind and IPC** — Work Board due-soon through the pipeline, `ALERTS`
   channels, preload, IPC domain. Gates: common + channel inventory, preload
   shape, host-renderer-only, work-board suites.
5. **Settings UI** — the per-plugin Alerts section (nested under the
   existing `plugin-config-installed` anchor, no new anchor), the
   `removePredecessor` channel, unseen badge, post-install/update link,
   i18n, screenshot matrix and E2E fixture updates. Gates: common + renderer suites,
   settings-section-anchors, CDP layout check of the section at phone and
   desktop widths.
6. **Marketplace: conditional revocations and retained config** — snapshot
   format version and rebuild-at-same-pin, raw conditional entries,
   `effectiveRevocations` in every reader, schema, `repository-check`,
   `retain` through `applyRevocations` → lifecycle → journal record. Gates:
   common + catalog, snapshot, sync, service, views, uninstall-lifecycle,
   journal, revocation-bootstrap suites.
7. **Routines: missing-plugin rule** and **deprecation warnings** for
   `notificationEvents`; `architecture.md`, `overlay-trigger.md`, CHANGELOG
   with the opt-in loss. Gates: common + routine suites.

The alerts release is whichever release carries both 6 and 7; the
successors' `minAppVersion` and the revocation's `appVersions` are set to
that version at publication, not before.

Official monorepo (one commit, after the alerts release is published):

- `lyra-mail` 0.6.0 and `meeting` 0.9.0 with `minAppVersion` at the alerts
  release; descriptor changes (lyra-mail `host:overlay`, meeting and later
  orion-api `pluginAccess` grants, vega-helper grant removals);
  `policy/revocations-by-app.json` with the `vega-helper` entry; the
  re-vendored `contract/` and `tools/vendor/marketplace-check.js`. Gates:
  each plugin's typecheck, `vitest`, `validate-events.mjs` (extended), plugin
  CI; `node tools/index.mjs --check` and `marketplace-check.js` on the new
  file; a manual run on the alerts release of each pairing in the table.
- `local-indexer` on the alert contract before the follow-on release PR.
- With the follow-on release: delete `plugins/vega-helper/`, regenerate the
  index, keep the revocation entry; meeting drops the relay subscriptions.

Company git: `orion-api` 0.22.0 with `minAppVersion` at the alerts release,
published the same day as the monorepo commit. Gates: ported suites,
`validate-events.mjs`, a run on the alerts release with `lyra-mail` 0.6.0 and
`meeting` 0.9.0, and one with vega-helper still installed (blocked kinds).

## Decisions recorded

- Declared templates with typed slots, not host sanitisation of free text.
- Toggles live in a host-drawn section inside each plugin's config tab.
- `triggerConversation` survives for suggestions, with the persisted
  one-acceptance-per-30-days limit per `(pluginId, source)` applied only to
  plugins that declare an `alerts` block, so a plugin still on the old path
  keeps alerting through the transition.
- Conditional revocations live in a sibling file, stored raw in a
  versioned snapshot and evaluated at read time by every consumer; the
  entry's `successors.plugins` is the only authorisation for `inherits` and
  `configInherits`.
- A retirement writes the retired record (effective config, enabled flag,
  successors) when the revocation is applied, before any uninstall; the
  superseded-row uninstall retains through an internal `retain` option.
- A successor kind is blocked while its predecessor is loaded, or installed
  and not revoked; a revoked predecessor blocks until the restart that
  refuses its load. Before the retirement entry is known the predecessor is
  matched by name plus the successor's `inherits[].sourceId` hint (`ave`)
  or a `null` source; afterwards by the entry's source or a `null` source.
  An internal mirror republishing the predecessor under its own source id is
  not matched; accepted.
- Overlay suggestion sources are declared in `alerts.suggestions` (at most
  4, each matching the overlay source pattern, distinct from the routine's
  `suggestion:<pluginId>:<intent>` marker); for a plugin on the contract,
  `triggerConversation` accepts only declared sources
  (`source_not_declared`), once per source per 30 days (`suggestion_limit`);
  a malformed `alerts` block still counts as declared. A `--` in any trigger
  source is rejected so alert envelopes cannot be forged; no official plugin
  uses one, and the CHANGELOG entry names the third-party impact.
- Non-official successors are named `{ pluginId, anySource: true }` in the
  revocation entry and may inherit toggles only, never config.
- The routine session's write-tool guard is the tool-stage headless lane
  (`reviewer-dispatch.ts`), which denies non-low; the effect-boundary lane
  is off by default and is not relied on.
- The daily briefing is one `lyra-mail` tool with a tool-less LLM call and a
  routine scoped to `lyra-mail` only.
- The OS notification body is static.
- `alerts` stays outside `PLUGIN_AUTHORITY_FIELDS`; consent for kinds that
  appear in an update comes from the resolve-off rule, not from review.
- Every kind, including the successors of today's new-mail and
  meeting-summary notifications, is `defaultEnabled: false`; former
  vega-helper users inherit their choices from the retired record;
  everyone else opts in.
- Meeting's calendar automation is on only for former vega-helper users,
  through `configInherits`.
- `calendar.events.loaded` covers two days, matching vega-helper's
  snapshot, so preps for tomorrow register at boot as they did; it is pushed
  on first load and auth change and answered on `meeting.calendar.snapshot.requested`.
  More days would cost Graph quota on every auth change and every answer for
  little gain.
- The "superseded, waiting for removal" row offers Remove only through the
  retaining uninstall path, and shows "managed by policy" instead of the
  button when the package is policy-locked. The host draws it from the
  kind's `inherits` data and the marketplace's uninstall path, names no
  plugin in source, and the retain path is what keeps the user's choices; a
  plain uninstall from that row would silently reset them.
- The open-card cap is 3 per kind, evicting the lowest priority first, then
  the oldest. Mail kinds can burst; a higher cap fills the overlay region, a
  cap of 1 loses the second approval mail before the user reads the first,
  and priority-first eviction keeps a `high` card through a burst of
  `normal` ones.

- A kind entry that loads with a field out of shape becomes the fail-closed
  choice (off, no OS notification, `silent`, unseen, `repaired: true`)
  instead of being dropped; the flag outranks every automatic transition
  (retirement re-resolution skips it, escalation only resets to off), so a
  damaged kind entry can never turn a kind on until the user sets it. A
  retired record out of shape is dropped whole, which loses its inheritance
  and leaves the successor on its own declaration — stated as a loss, not
  covered by the kind-entry guarantee.
- A retired record carries `consumedBy` and is pruned only when it is two
  minors old and every listed successor has consumed it, so updating the
  app before the plugins cannot lose the user's choices. Consumption is one
  decision per successor, taken when a version that declares the
  inheritance has brought both the kinds stage and the config stage to a
  terminal outcome; an old successor version that declares nothing stays
  pending, and the attempt is retried on every registration and when the
  predecessor stops blocking.
- A `repaired` flag present with any value other than `true` makes the
  entry fail-closed again, and a repaired entry is exempt from the absence
  prune, so the repair guarantee holds for as long as the entry exists.
- `enabled` is required and `osNotification` optional in both a kind's
  `inherits[]` entry and a retirement entry's `hostKinds[]` mapping; an
  inherit rule's `values` list is non-empty.
- Kind keys carry the manifest's bounds: plugin id 3 to 64 characters,
  kind id 2 to 32.
- The two-minor prune of absent kind entries and retired records runs in
  the settings loader against the running version, and keeps everything
  when no stable version is supplied.

There are no open questions.
