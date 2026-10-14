# Overlay triggers and plugin alerts

This page owns the host delivery and trust contract for actions that begin
outside direct chat input. The alerts contract describes the complete alerts
release; a build containing only part of the
[rollout](../design/plugin-alerts.md#pull-request-plan) does not enable the whole
surface. Historical discussion remains in the
[Korean archive](../ko/references/overlay-trigger.md).

## Recurring alerts

A plugin detects a signal and calls `raiseAlert({ kind, key, slots, ... })`.
Its `extensions["ai.agent-connector.ave"].alerts.kinds` declaration authorizes the kind and
owns its localized templates, bounded slots, visibility and static OS text.
The host owns consent, identity, budgets, presentation and withdrawal.
Malformed declarations grant nothing. Alert kinds require no `host:overlay`
capability. `withdrawAlert(kind, key)` is scoped to the calling plugin.

The delivery stages run in this order:

1. Check the declared kind and input shape.
2. Block an inheriting kind while its predecessor is loaded, or installed and
   not revoked, if its source matches the declaration or has no binding.
   A revoked predecessor still running after a failed uninstall blocks until
   its load is refused on restart.
3. Check the user's kind toggle.
4. Resolve open and closed identities. Refresh an open identity without another
   notification; reject a dismissed or accepted identity until its TTL expires.
5. Apply the per-kind cooldown and per-plugin rate limit.
6. Stage the declared content with sanitized slots according to
   effective visibility, which a call may only lower.
7. Deliver the permitted notification cue, then emit host-owned audit and events.

Only acceptance charges cooldown and rate windows. Identity is an HMAC of the
caller, kind and key under an installation secret. The raw key and slot text
never enter `open.json`, audit rows or `alert.*` events. Slots in model-facing
text are wrapped as untrusted data; reference slots appear only in the prompt,
not on the card. OS notifications use static declared text.

| Visibility | Delivery |
| --- | --- |
| `user-visible` | Overlay card; OS notification when allowed. |
| `summary-only` | In-app toast while focused, or an allowed OS notification; no card or model prompt. |
| `silent` | Audit and `alert.raised` only. |

There is one notification cue per alert: an eligible OS notification replaces
the toast. OS delivery requires the kind's OS declaration, its user toggle and
the master switch. Low priority never sends an OS notification. Focus normally
selects the in-app path; a declared focus bypass can select OS delivery.
High-priority cards sort first. Closed identities persist across restart;
rendered cards do not. Because disk state contains no slot text, a still-open
identity is drawn again only when its plugin raises it again, returning
`refreshed`. Cards staged in the current process before a window exists are
available when the renderer attaches.
An accepted card remains queued if a window send fails; `delivered.card`
reports staging, not renderer acknowledgment.

Accepting a card inserts its pending prompt into the dedicated Suggestions
conversation (see [Where cards land](#where-cards-land)) and closes the alert
with reason `accepted`. Dismissal closes it with `dismissed`.
The renderer reports closures through `ave:alerts:card-closed` and obtains
staged cards through `ave:alerts:open-cards`; both are host-renderer-only IPC.
Plugin restarts and updates do not discard cards. Uninstall cleanup withdraws
the plugin's cards. Revocation withdraws them during the current session, even
if the plugin keeps running; its saved alert choices remain available.

## One-time suggestions

`triggerConversation` remains for plugin-authored setup suggestions. It requires
`host:overlay`. For plugins declaring an `alerts` block, its source must appear
in `alerts.suggestions` (at most four sources), and a source is accepted at most
once per 30 days, persisted across restart. Invalid alerts declarations do not
escape this restriction. Refusals include `source_not_declared` and
`suggestion_limit`.

During the transition, plugins without an alerts block retain their existing
trigger behavior. This exception ends in the minor release after the alerts
release, once the official plugins have migrated. The deprecated trigger fields
`visibility` and `priority` are accepted and ignored during the window and are
removed in that follow-on release.

A trigger source must match `overlay:[a-z][a-z0-9-]*` and must not contain `--`.
Only the alerts pipeline can mint `overlay:<pluginId>--<kind>` sources. Host
kinds use `overlay:host--<kind>`, with `@host` as their identity namespace; the
package name `host` is reserved. A suggestion's overlay source differs from a
routine's `suggestion:<pluginId>:<intent>` idempotency marker.

## Where cards land

Cards nobody asked for in the conversation at hand — alert cards, accepted
`triggerConversation` suggestions and routine running/result/failure cards —
are addressed to one dedicated, persistent Suggestions conversation, never to
the focused one. Onboarding proposals stay inline where the user is: they run
no turn, and a first-run user has no work for them to intrude on. It is an ordinary conversation in the
main session store under a reserved id (`src/shared/suggestions-session.ts`),
created empty on demand by the host just before the first card is staged. A
newly staged card moves it to the top of the conversation list; a snapshot pull
only makes it exist. Every surface names it from the catalog by its reserved id
in the current language (a stored title is ignored for that id, so it cannot be
renamed), and its sidebar row shows how many cards wait in it. It cannot be
archived — archived rows leave the list, which would hide every suggestion and
its count — and deleting it clears it: the host recreates it empty at once,
because cards still waiting in the window (a plugin card lives only there) name
it as their origin.

A card is drawn only in a pane holding the Suggestions conversation; otherwise
it waits and the row carries the count. Confirming a card runs its staged
prompt there; "Continue in a new conversation" instead starts a new
conversation in that pane and runs the prompt as its first turn. Either way the
staged origin and envelope are the same, and the user picks where it runs. Opening a routine
result still opens the routine run's own session. MCP App messages are not
suggestions: they were raised in a conversation and stay with it. The routing
rule keys on card kind only, is applied at the renderer's single card
ingress, and therefore also routes cards staged by an earlier build; nothing
on disk is rewritten. Plugin contracts (`triggerConversation`, `raiseAlert`,
onboarding manifests) are unchanged.

## Trust and migration

An accepted prompt retains the `plugin-emitted` staged origin and the
`imported-from-proactive` envelope. It cannot dispatch privileged slash commands.
All resulting tool calls retain the ordinary permission and force-ask gates;
clicking a card does not approve its tools.

From 0.13.0, an installed manifest's `notificationEvents` field is dropped with
one warning per plugin before strict validation. It no longer registers OS
notifications. The repository checker refuses a new declaration when the
matching descriptor or index version's `minAppVersion` is at or above the
configured alerts-release version. The alert contract replaces that path.

New-mail and meeting-summary OS notifications become opt-in when their plugins
migrate. Users enable the relevant kinds and OS toggles in plugin settings;
eligible choices retained from a predecessor can be inherited. Durable work
proposals continue to use `proposeWork`; an alert is a time-bound nudge.

A scheduled LLM routine with a non-empty explicit plugin allow-list checks the
installed registry at execution time. If every named plugin is absent, it
records `lastSkippedReason: "plugins-missing"` without creating a result. A
one-shot stays pending; repeating skips advance the occurrence. If only some
are absent, the routine runs and stores `needsAttention.missingPluginIds`.
Both states remain visible with a remove action. Installed but unloaded,
disabled, or updating plugins count as installed; this check does not grant
them tool access. Missing scope, an empty allow-list, deny-all and inherit
retain their existing execution behavior. Headless tool review remains the
write guard, including when optional effect classification is disabled.

## Implementation owners

- Contract and validation: `src/plugins/public-contract.ts`,
  `schemas/plugin-manifest.schema.json`, `src/plugins/runtime/manifest-validation.ts`.
- Identity, rendering, state and admission: `src/alerts/{identity,render,store,kinds,gate,service}.ts`.
- Events and suggestion limits: `src/alerts/{events,suggestion-ledger}.ts`.
- Boot and renderer boundary: `src/boot/steps/alerts-setup.ts`, `src/ipc/domains/alerts.ts`.
- Routine persistence and dispatch: `src/main/{routines-store,routines-scheduler}.ts`.
- Suggestions conversation: `src/shared/suggestions-session.ts`, `src/main/suggestions-session.ts`,
  `routeToSuggestionsSession` in `src/ui/renderer/context/OverlayContext.tsx`.
- Complete budgets and migration rules: [plugin alerts design](../design/plugin-alerts.md).
