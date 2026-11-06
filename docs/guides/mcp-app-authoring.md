# Authoring an MCP App (`ui://` card) in an Ave plugin

An **MCP App** is an interactive HTML view served by an MCP server: a meeting summary, an indexer status panel, or a form that calls a tool. Ave renders these views in chat and declared sidebar or floating surfaces using the [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps/tree/main/specification) (spec `2026-01-26`).

**A plugin builds its app against `@modelcontextprotocol/ext-apps` directly.** The MCP library defines the standard UI contract; placement and host policy in this guide are Ave-specific.

Three moving parts:

| Part | Where it lives | What it does |
|---|---|---|
| **Declare** | `plugin.json` → `uiResources[]` | names the `ui://` uri and its security policy |
| **Serve** | `RuntimePlugin.readUiResource(uri)` | returns the card's HTML bytes |
| **Trigger** | a tool handler's `_meta.ui.resourceUri` | asks the host to render that card with this result |

The rule that ties them together is **declared policy, served content**: the manifest declares *what a card may do* (statically reviewable, covered by `manifestSha256`); your plugin serves *what the card is* at read time. The host never reads a path you hand it.

---

## 1. Declare the resource

```jsonc
// plugin.json
{
  "id": "my-plugin",
  "uiResources": [
    {
      "uri": "ui://my-plugin/report",          // authority MUST equal your plugin id
      "csp": {
        "connectDomains": ["https://api.example.com"],  // fetch/XHR/WebSocket → connect-src
        "resourceDomains": ["https://cdn.example.com"], // img/script/style/font/media
        "frameDomains": [],                              // nested iframes → frame-src
        "baseUriDomains": []                             // base-uri
      }
    }
  ]
}
```

- **`uri`** — `ui://<your-plugin-id>/<path>`. The authority must be your own plugin id; the host re-checks this fail-closed at serve time. You cannot serve into another plugin's namespace.
- **`csp`** — domain *buckets*, not CSP directive names. Main **computes** the Content-Security-Policy response header from these; you never supply a header string. Omit a bucket to allow nothing in it. **Least privilege is not advice here — it is the whole point of the field being in the manifest**: a reviewer sees exactly what your card may reach before any of your code runs.
- **Clipboard write only.** A resource may declare `permissions: { clipboardWrite: {} }` and use `navigator.clipboard.writeText()` in response to a user action. Clipboard read is blocked and `clipboardRead` is rejected. Other declared standard resource permissions retain their existing host policy. A declaration requests access rather than guaranteeing browser availability; handle a refused write in your UI.

### Sidebar and floating placement

The same declared HTML resource can back a secondary panel:

```jsonc
// extensions["ai.agent-connector.ave"] in plugin.json
{
  "ui": [{
    "id": "report-panel",
    "slot": "sidebar", // or "floating"
    "kind": "mcp-app",
    "resourceUri": "ui://my-plugin/report",
    "title": "Report"
  }]
}
```

The resource must appear in `uiResources[]`. A floating declaration makes the
view eligible for the host's dock; attachment remains a server-side host operation.
The host reads the resource before mounting and supplies the server identity;
a panel does not need a synthetic tool call merely to load its HTML.

The `csp` stays in the *manifest* on purpose. If it came back from your `readUiResource` hook, a plugin could present a narrow policy at review and widen it at runtime.

## 2. Serve the HTML

```ts
// your RuntimePlugin factory
export default function createPlugin(ctx: PluginRuntimeContext): RuntimePlugin {
  return {
    handlers: { /* … your tools … */ },

    readUiResource(uri) {
      if (uri === "ui://my-plugin/report") {
        return readFileSync(join(ctx.pluginRoot, "dist/report.html"), "utf8");
      }
      throw new Error(`unknown ui resource: ${uri}`);
    },
  };
}
```

You are the MCP server; the host relays. The host only calls this hook for a uri **you declared** and whose authority it **already verified**, so the hook's own job is small: return bytes. It is bounded by the host at a single chokepoint — a 10 s ceiling and a 4 MiB HTML cap, fail-closed — so ship a self-contained document (inline your CSS/JS, or bundle to one file), not a loader that fans out to disk.

## 3. Trigger the card from a tool

Put the standard `_meta.ui` on what your tool handler returns. Same keys an external MCP server puts on its `CallToolResult` — nothing Ave-specific; the loopback delegate lifts them onto the wire for you.

```ts
async function handleGenerateReport(args) {
  const report = await buildReport(args);
  return {
    summary: report.summary,          // ← everything OUTSIDE _meta is what the MODEL reads
    warnings: report.warnings,
    _meta: {
      ui: {
        resourceUri: "ui://my-plugin/report",   // required
        title: "Q3 Report",                     // optional — webview title bar
        height: 420,                            // optional — initial px (the app can resize itself later)
        slot: "chat",                           // optional — defaults to "chat"
      },
    },
  };
}
```

`_meta` is protocol, not payload: the host strips it, and the model reads the rest (stringified if it is not already a string). So the card is *in addition to* the reply, never instead of it — **write a result that stands on its own, because the model cannot see your card.** The strip happens whether or not the card renders, so the model's view never depends on the UI.

Only a **declared** `resourceUri` renders. An undeclared one is dropped, not served.

## 4. Build the app itself

Inside the card, use the ext-apps View SDK directly:

```ts
import { App } from "@modelcontextprotocol/ext-apps/app";

const app = new App({ name: "my-plugin-report", version: "1.0.0" });
await app.connect();

const ctx = app.getHostContext();        // theme, locale, timeZone, displayMode, styles…
app.onhostcontextchanged = (next) => applyTheme(next);
```

### What the host gives you (`HostContext`)

| Field | Value |
|---|---|
| `theme` | `"light"` / `"dark"` |
| `locale` | BCP-47, e.g. `"ko"` |
| `timeZone` | IANA, e.g. `"Asia/Seoul"` |
| `displayMode` | the mode this card is **currently** in |
| `availableDisplayModes` | `["inline", "fullscreen", "pip"]` — what this host can actually apply |
| `styles.variables` | the host theme, as **standard** `McpUiStyleVariableKey` CSS variables |

`styles.variables` uses the spec's fixed vocabulary — `--color-background-primary`, `--color-text-secondary`, `--color-background-danger`, `--border-radius-md`, `--font-text-md-size`, … — never Ave's internal `--ave-*` names. Style against those keys and your card themes correctly on any MCP Apps host, not just this one. The host pushes updates on theme/locale change; re-read from `onhostcontextchanged` rather than caching at boot.

### What you can ask the host to do

| Call | Behavior in Ave |
|---|---|
| `app.callServerTool({ name, arguments: args })` | calls **your own plugin's** tool. See the visibility gate below. |
| `app.sendSizeChanged({ height })` | the card resizes to fit — do this instead of guessing `height` |
| `app.openLink({ url })` | opens an external URL through the host |
| `app.requestDisplayMode({ mode })` | Requests `inline`, `fullscreen`, or `pip`. The response tells you the mode actually applied, which may not be the one you asked for. Always render from the response, never assume. |
| `app.sendMessage({ role, content })` | see *Talking to the conversation* below |
| `app.updateModelContext({ … })` | see *Talking to the model* below |
| `app.downloadFile({ … })` | inline bytes → a save dialog. The host does **not** fetch a URL for you; a `resource_link` is rejected. |

`fullscreen` fills the current renderer rather than opening a second application window. `pip` uses the renderer's draggable picture-in-picture surface. Each away surface has one slot, so a newer card can replace the current occupant; keep rendering from host context instead of assuming the requested surface remains assigned.

### The visibility gate on `callServerTool` — read this before you debug it

The spec says a host **MUST** reject an app's call to a tool whose `_meta.ui.visibility` does not include `"app"`. Ave enforces it. A tool that omits `visibility` gets the spec default `["model", "app"]`, so it is app-callable out of the box — narrow it to `["model"]` and your card can no longer call it, by design.

```jsonc
// plugin.json → tools[]
{ "name": "my_plugin_refresh" }                                                   // dual by default — your card CAN call it
{ "name": "my_plugin_refresh", "_meta": { "ui": { "visibility": ["model", "app"] } } }  // the same thing, spelled out
{ "name": "my_plugin_delete",  "_meta": { "ui": { "visibility": ["model"] } } }         // model only — card cannot call
{ "name": "my_plugin_wait_changes", "_meta": { "ui": { "visibility": ["app"] } } }      // app only; hidden from the model
```

App-only tools are callable by this server's views through `app.callServerTool()`, including views in a sidebar or floating dock. They remain hidden from the model and pass the same host permission and approval boundary as other view calls.

**A call from your card is not more trusted than a call from the model.** It goes through the same host risk classifier and the same approval gate — a `write`/`shell`/`network` tool can prompt the user, and the user can deny it. Handle rejection in your UI; do not assume a call succeeds. Your card also cannot name a *different* server: the host binds the target from the trusted payload, and a cross-server call is denied.

### Talking to the conversation (`sendMessage`)

Two intents, and the host decides which by looking at the content block's `_meta`.

**A popup notification** — reaches the user, never the model, never the transcript:

```ts
app.sendMessage({
  role: "user",
  content: [{
    type: "text",
    text: "Build finished",
    _meta: {
      "ai.agent-connector.ave/notification": {
        title: "Build finished",
        body: "3 warnings, 0 errors",
        severity: "info",            // "info" | "warning" | "critical"
      },
    },
  }],
});
```

**Text into the conversation** — a plain `text` block with no notification meta:

```ts
app.sendMessage({ role: "user", content: [{ type: "text", text: "Summarize the Q3 report card." }] });
```

A sidebar or floating view always stages this text in the current conversation's composer; when no conversation is open, the host opens a new composer. The user sends the draft. An in-chat card stays bound to its own conversation, with the existing behavior:

- **A turn is in flight** → your text joins the guidance queue and reaches the model as part of that turn, **with no user confirmation**. Be deliberate about what you send on this path: it is ungated. The rest of that turn is downgraded to your app's provenance, which force-asks the user before any `write` / `shell` / `network` tool the model then reaches for.
- **No turn in flight** → the host raises a **staging card**; the user clicks to send. Sending requires a user gesture. An app that could start a turn on its own could drive the model with no one watching.

Either way the message is tagged `app-emitted` and wrapped so the model sees it came from your app, not from the user's keyboard. Text is capped at 4096 characters. The two intents are exclusive: notification meta wins, and that message never reaches the conversation. No view may dispatch a privileged slash command.

### Talking to the model (`updateModelContext`)

An **overwrite slot**, not a message: the host stores your latest context and folds it into the *next* turn the user starts. Calling it does not wake the model, does not append to the transcript, and a second call replaces the first. Use it to keep the model aware of what the card is currently showing ("user is viewing rows 40–60, filtered to failures") so the next question lands with context.

## Realtime state without a private push channel

Use an ordinary app-only tool for bounded long polling. For example:

```jsonc
{
  "name": "my_plugin_wait_changes",
  "description": "Wait for changes after a cursor, or return when the wait expires.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "cursor": { "type": "string" },
      "waitMs": { "type": "integer", "minimum": 0, "maximum": 10000 }
    },
    "required": ["cursor", "waitMs"],
    "additionalProperties": false
  },
  "_meta": { "ui": { "visibility": ["app"] } }
}
```

The tool result can carry an application-defined structured payload such as
`{ cursor: "42", changes: [{ kind: "status", value: "done" }] }`. On timeout,
return `{ cursor: "42", changes: [] }`. For an expired cursor, return an explicit
reset such as `{ cursor: "57", reset: true, snapshot: { status: "done" } }`.
The cursor and change/reset payloads are your tool's contract, not a new host
protocol; validate them and scope each stream to the authorized account.

Enforce the wait bound on the server and resolve outstanding waits when it stops. The bound must fit within the host's tool-call ceiling.
Keep one request outstanding per view and repeat through
`app.callServerTool()` after applying each response. Stop scheduling requests
when the view is disposed; handle cancellation and errors without a busy loop.
Do not invent vendor notifications from the plugin into its view.

Authentication changes invalidate the host's view instance: the host remounts
it, and its new instance reloads state through its own tools. Theme and locale
changes use `app.getHostContext()` and `onhostcontextchanged`, including the
standard `styles.variables`. There is no `host.theme.changed` view event.

## Host extension negotiation

The host advertises MCP Apps at
`capabilities.extensions["io.modelcontextprotocol/ui"]`, including the
supported HTML MIME type. Ave-only server-to-host operations are declared under
`capabilities.extensions["ai.agent-connector.ave/host"]`. Their methods and
metadata use `ai.agent-connector.ave/`, including
`ai.agent-connector.ave/host/*`,
`_meta["ai.agent-connector.ave/operationPolicy"]`,
`_meta["ai.agent-connector.ave/pathFields"]` and
`_meta["ai.agent-connector.ave/notification"]`. Retired short-prefix keys are
rejected; there are no aliases. Plugin ids, tool names and domain event names
keep their separate naming rules. In particular, tool names use
`^[a-zA-Z_][a-zA-Z0-9_]*$`, not a vendor-prefixed method path.

The view has only the standard MCP Apps bridge. Host fetch, auth windows,
secret leases and delegated workers remain server-side host capabilities;
expose a narrow declared tool when a view needs one of those operations.

## 5. Test it

- The host renders your card in a sandboxed webview whose inner frame is `sandbox="allow-scripts"` only — **no same-origin, no storage, no cookies**. `localStorage`/`sessionStorage` throw. Keep state in the app, or push it to your plugin with a tool call.
- Your card's network access is exactly `csp.connectDomains`. If a fetch fails silently, check the manifest before you check your code.
- Nothing in the card can inject a CSP or a sandbox attribute — those are host-computed and host-owned. If you need a domain, declare it.

## Where the pieces are (host source, for when something misbehaves)

| Symptom | Look at |
|---|---|
| card never renders | `plugin-runtime-delegate.ts` (does `_meta.ui` reach the wire?), then `plugin-ui-resource-provider.ts` (declared? authority?) |
| card renders blank / CSP error | the per-resource header main computes from your `csp` |
| `callServerTool` rejected | the visibility gate, then the risk classifier / approval gate |
| a handler does nothing at all | the handlers table in `src/ui/renderer/components/mcp-app-bridge.ts` — the host's advertised capabilities are derived from the same array that registers the handlers, so what it advertises is what it answers |

## Reference

- Spec: [MCP Apps, `2026-01-26`](https://github.com/modelcontextprotocol/ext-apps)
- SDK: `@modelcontextprotocol/ext-apps` (`/app` for the View side, `/server` for the server side)
- Host bridge: [`mcp-app-bridge.ts`](../../src/ui/renderer/components/mcp-app-bridge.ts)
