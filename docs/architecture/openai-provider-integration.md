# OpenAI provider integration

The provider boundary adapts two connection contracts to the same Ave engine:
an API-key connection using the existing SDK transport and a Codex subscription
connection using the governed native App Server. The common provider layer owns
the model-visible request projection. It removes host-only tool-call metadata
while retaining tool identity, input, result error status, and image provenance.
It does not introduce another agent loop.

## Connection ownership

| Responsibility | Owner |
|---|---|
| Engine input/output | `GenericMessage`, `StreamTurnParams`, `StreamEvent` |
| API-key provider creation | `src/engine/llm/provider-factory.ts` |
| Subscription provider creation | `src/main/subscription-llm-provider.ts` |
| Common OpenAI request contract | `src/engine/llm/openai/` |
| API HTTP and SDK mapping | Existing SDK provider transport |
| Native account, thread, turn, and dynamic-tool protocol | Codex App Server clients |
| Other subscription protocols | Their own protocol adapters |
| UTF-8 JSONL framing | `src/lib/json-line-reader.ts` |
| Pending RPC identities and timers | `src/lib/json-rpc-pending-request.ts` |
| Tool execution, approval, memory, and broadcasts | Ave host services |

An API-key connection resolves the configured secret and API endpoint through
the existing factory. A subscription connection resolves its active native
profile and receives its session-opening service from the main process. The
shared engine-facing module does not import a desktop runtime or read native
credentials. Authentication and billing stay attached to the selected route.
It neither falls back between routes nor converts subscription authentication
into an API credential.

## The user's own `codex` CLI

Ave ships no app-server binary. `src/main/codex-user-runtime.ts` finds the
`codex` the user installed and qualifies it before either app-server client
starts it:

1. **Location.** An explicit path chosen in settings wins and is never
   replaced by discovery when it disappears. Otherwise each absolute PATH
   entry is tried, then the official install locations: `$CODEX_INSTALL_DIR`,
   `~/.local/bin` (the standalone installer), `/opt/homebrew/bin` and
   `/usr/local/bin` (Homebrew), and on Windows
   `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` and the npm shim directory. The
   first `codex` found decides; an unusable one is reported, not skipped.
2. **Native binary only.** A Mach-O, ELF or PE file is used as is. The npm
   launcher script is followed to the native binary it would start; nothing
   is run through a shell or an interpreter.
3. **Version gate.** `codex --version` must report
   `CODEX_CLI_MINIMUM_VERSION` (0.152.0) or later.
4. **Protocol check.** `codex features list` must name every feature Ave
   disables at launch, and `codex app-server generate-json-schema
   --experimental` must describe every request, field, enum value,
   notification and server request Ave uses
   (`src/main/codex-protocol-requirements.ts`).

The verdict is cached per file identity, so an updated binary is checked
again. A probe that cannot run is a start failure and is retried; it is never
read as a compatibility verdict. The settings card shows the official install
methods while no CLI is found, and "Codex CLI 0.152.0+ required" when the
found one is too old or incompatible.

The minimum was measured, not guessed: published versions from 0.140.0 to
0.163.0 (every minor, with both patches either side of each boundary) were
unpacked into an empty directory, each generated schema was checked against
the requirements, and an app-server was started with Ave's exact argv and
asked to `initialize`. Versions before 0.144.0 lack login
fields Ave sends; versions before 0.152.0 refuse to start because they do
not know the `sleep_tool` feature Ave disables under `--strict-config`.

**Credentials stay isolated.** Ave still starts the user's binary with its
own `CODEX_HOME`, a sanitized environment and `cli_auth_credentials_store =
"file"`, and signs in through the app-server's `account/login/start`. The
user therefore signs in once more inside Ave, even if `codex login` already
ran in a terminal. That is the deliberate trade-off: sharing `~/.codex` would
let the CLI and Ave rotate the same refresh token concurrently and would
expose the user's own configuration, MCP servers and history to Ave's
governed runtime. The model list still comes from the user's binary through
`model/list`.

The [Claude Code subscription runtime](claude-code-subscription-runtime.md)
uses the same engine contract and JSONL reader with its own CLI authentication,
print-stream validation, and MCP bridge adapter.

## Request and stream semantics

Both connections use the common model-visible projection before their wire
mapping. Stored history is unchanged. Tool-call IDs and inputs survive the
projection; host execution provenance and scheduling fields do not enter model
input. Tool-result failures and retained images survive transport mapping.
Existing image selection and count/byte limits remain authoritative.

The API transport applies its configured numeric output and thinking controls.
The native transport uses its selected profile and supported native effort.
Those controls are distinct contracts: sharing the provider layer does not
translate a numeric thinking budget into a native effort or change the model.

Registered dynamic tool requests return through the governed Ave tool path.
Ave executes the tool and supplies the next round through its ordinary engine.
Both account and conversation processes explicitly disable native shell,
snapshot, connector, browser, computer, subagent, and other optional execution
features. Hosted web search is separately disabled because the native sandbox's
network setting does not remove it.

The App Server does not expose a complete native-tool allowlist. Its patch tool
can remain in the native catalog, and `unified_exec` can report enabled despite
the disable flag; `shell_tool=false` is the command-tool control. Unsupported
native execution still triggers the existing interrupt and transport shutdown,
and native approval requests are declined. These flags do not replace that
enforcement boundary. Native command and patch execution additionally receive a
read-only filesystem policy with network access disabled. Ave dynamic tools
execute in the host callback under their own permission policy, outside that
native sandbox. The host stages image inputs before native turn startup; the
App Server needs to read those files, not create them. Native IDs and
interruption remain transport state. Text,
reasoning, tool, usage, completion, cancellation, and sanitized error events
retain their existing stream contract.

## Shared child-process transport

Each child-process transport owns one incremental JSONL reader. A line may span OS chunks,
and a chunk may hold several lines. The byte ceiling applies to the individual
line rather than to the delivery chunk. Invalid JSON or an oversized line closes
that reader once. Closing from a message callback suppresses later messages in
the same chunk.

The pending registry allocates monotonically increasing numeric IDs, stores
request methods with pending promises, and clears timers when replies settle.
Late or duplicate responses cannot settle a different request. Timeout callbacks
apply the adapter's existing close policy; conversation prompts and account
probes are not assigned one universal timeout. Envelope validation, server
requests, session state, process management, and safe error projection belong to
the protocol adapter.

## Adding a connection

Reuse a protocol adapter when the external endpoint implements that protocol.
Add a distinct adapter when authentication, framing, session lifecycle, or tool
delivery differs. Supply the existing engine contract and shared projection;
do not add provider branches to tool governance or plugin integration. Tests
must cross the provider entry and transport boundary, including images, tool
results, cancellation, explicit completion, and late responses.
