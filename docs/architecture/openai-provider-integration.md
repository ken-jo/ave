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
   replaced by discovery when it disappears. Otherwise each fully qualified
   PATH entry is tried, then `$CODEX_INSTALL_DIR`, `~/.local/bin`,
   `/opt/homebrew/bin` and `/usr/local/bin`; Windows also checks
   `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` and `%APPDATA%\npm`. Windows
   paths must name a drive root or a UNC share. Drive-relative, root-relative
   and device-namespace paths are rejected. The first existing `codex`
   decides; an unsafe or invalid candidate and filesystem inspection errors
   are reported instead of continuing discovery.
2. **Trusted source.** The selected file, its symlink route, canonical route
   and every ancestor must prevent writes by other accounts. POSIX owners
   must be root or the current account; Windows checks ownership against the
   current account and trusted system principals, plus access-control rules.
   The npm launcher is followed to its native executable without running a
   shell or interpreter, and its route receives the same checks. An unsafe
   location reports `codex-runtime-unsafe-location`; recovery is to install
   or choose a CLI whose file and path meet these ownership and write rules.
3. **Private artifact.** Ave copies the admitted executable into a random
   private directory under its isolated runtime home. Exclusive creation,
   no-follow opens where supported, pinned source handles and source
   rechecks detect replacements during copying. Ave hashes the copied bytes
   with SHA-256 and makes the file owner-readable and executable. Structural
   validation runs on the copy and requires a complete Mach-O, ELF or PE
   header for the current platform and architecture; a magic prefix alone
   is insufficient. This does not prove the operating system's loader will
   accept the file. Every compatibility probe also runs against the copy.
4. **Version gate.** The copied `codex --version` must report
   `CODEX_CLI_MINIMUM_VERSION` (0.152.0) or later.
5. **Protocol check.** `codex features list` must name every feature Ave
   disables at launch, and `codex app-server generate-json-schema
   --experimental` must describe every request, field, enum value,
   notification and server request Ave uses
   (`src/main/codex-protocol-requirements.ts`). Required fields and their
   types must coexist in the applicable union branch; fields from different
   alternatives cannot collectively satisfy a request contract.
6. **Launch identity.** Both account and conversation clients receive the
   qualified artifact, including its digest and version. Its private
   location, regular-file status, permissions and content hash are checked
   immediately before every probe and app-server spawn.

`src/main/codex-native-spawn.ts` preserves loader rejection as a start
failure. Linux subscription startup requires a host runtime exposing
`process.execve`; the [native host guide](../guides/native-server.md#build-the-artifact)
states the feature-specific runtime prerequisite. Ave trusts its host installation
as the source of the bootstrap runtime; CLI candidate admission rules apply to
discovered or configured CLI paths and their private copies.
On Linux, Ave starts a new host runtime process with a static bootstrap, passes the private
CLI path and arguments as data, and replaces that process through `process.execve`.
The bootstrap removes its launch-only environment before replacement. A missing API or
catchable bootstrap failure exits with status 126. A rejected syscall can
instead terminate the child with another nonzero status or signal; both are
start failures.

The desktop's [minimum macOS version](../../package.json#L366) is 13. On that
supported system range, Ave starts the absolute artifact path directly through
`posix_spawn`, avoiding replacement of an extra host runtime process. The current
embedded runtime uses libuv 1.52.1; its [explicit-path spawn route](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/process.c#L704-L712)
returns loader errors directly. The [legacy fork route](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/process.c#L872-L898)
requires an unavailable spawn operation; working-directory changes are supported
on the minimum system version. Account changes and detached sessions are
rejected because they can select that legacy route. Every production caller uses
the current account and session. Windows starts the artifact directly through
`CreateProcess`. These supported CLI launch routes never pass a CLI candidate to
`execvp`, so `ENOEXEC` cannot trigger a shell fallback.

The in-memory compatibility cache identifies the CLI and copied helper by
their SHA-256 content hashes. Changed bytes are checked again even if file
size and timestamps are preserved. A probe that cannot run is a start failure
and is retried; it is never read as a compatibility verdict. The settings
card shows the install methods while no CLI is found, and "Codex CLI 0.152.0+
required" when the found one is too old or incompatible. These checks do not
defend against root or an arbitrary malicious process already running as the
same user.

Rejected snapshots are discarded even when their negative verdict is cached.
After a failed qualification, a cleanup failure evicts its verdict and retains
ownership of the copy. Future snapshot requests retry pending removals first,
keeping repeated removal failures from accumulating copies. Disposal can also
retry those removals.
Successful copies remain owned by their locator until its transports stop;
disposal then removes only that locator's copies. A failed integrity check
evicts the cached artifact, so the next request qualifies a fresh snapshot.
Abrupt host termination can leave private copies, which a later host does not
automatically reuse or remove across sessions.

An installed `codex-code-mode-host` (`.exe` on Windows) receives the same
source admission, native-header validation, private copy and digest checks.
For a `CodexCLI.app/Contents/MacOS/codex` entry point, `codex-resources/` sits
beside the application bundle. Package resources take precedence over the legacy
sibling location; the qualified helper is placed beside the copied CLI under its
expected name.
The CLI alone can run the version, features and schema probes. The helper
remains necessary for models whose metadata selects `code_mode_only`, which
takes precedence over `--disable code_mode` in both
[0.152.0](https://github.com/openai/codex/blob/rust-v0.152.0/codex-rs/core/src/tools/mod.rs#L68-L90)
and [0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/tools/mod.rs#L77-L102).
A missing helper therefore does not invalidate every native executable;
code-mode-only execution without it fails closed. Probe success does not
establish support for those models. The package's `rg` serves thread search,
and shell, sandbox and voice resources serve native execution or realtime
paths outside Ave's governed request set.
Startup's built-in command aliases point back to the private CLI rather
than requiring another installed helper. Native execution denials and the
host's dynamic-tool permission gates remain authoritative.

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
