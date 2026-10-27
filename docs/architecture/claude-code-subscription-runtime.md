# Claude Code subscription runtime

The main process launches the official `claude` CLI the user installed. Ave
finds it itself — each fully qualified PATH entry, then `~/.local/bin` (the
native installer's launcher), `/opt/homebrew/bin`, `/usr/local/bin` and
`/usr/bin`; on Windows PATH, the native install directory and the roaming
package-manager prefix. The user never picks the file. The first runnable
candidate decides; an untrusted one stops discovery before any probe.

Location admission, no-follow file opens, hashing and native artifact copying
reuse the shared executable trust implementation. Every path component and
symlink owner must be the current account or root; group/world mutation is
rejected except for sticky root-owned directories. Windows uses owner/DACL
checks; extended access rules follow the same shared policy.

Only standalone native installations are supported. Script launchers, command
shims and npm-managed installations fail with
`subscription-runtime-native-required` before qualification, authentication or
conversation spawn. The settings guidance offers manual migration with
`claude install` or the official native installer, followed by removal of the
npm-managed copy and another availability check. Ave does not run migration
commands or select a later executable after rejecting the first runnable one.

Native executables run from a private, sealed, content-hashed copy. Admission
requires the platform's native executable format; there is no interpreter,
package snapshot, module loader or launcher argument prefix. Qualification,
authentication and each turn recheck the original launcher route and the sealed
private artifact immediately before spawn. Changes refuse the next turn of an
existing session.
The final hash check and spawn are not atomic. A same-UID or root attacker who can
modify the private directory can replace its executable after the check for one
invocation. That compromise is outside the current-user/root trust boundary;
there is no unconditional exact-binary guarantee. The operating system's native
library loader is also outside this content proof.

Discovery runs only `--bare --version` and `auth --help` in a fresh empty private
probe home, with stdin ignored. These local checks need no authentication or
model request; help is not treated as a complete flag inventory. Verification
combines that admission with the account's local `auth status` and an artifact
recheck. It sends no prompt and consumes no subscription model usage. A signed-out
verification creates no transport proof. Failed identity qualification is
`claude-code-runtime-incompatible`, shown as update guidance; verdicts are
cached by content identity and probes that cannot run are retried. An update or
reinstall requires fresh verification. Authentication
commands use a separate application-owned home and `CLAUDE_CONFIG_DIR`; Ave
does not read OAuth tokens, reuse API keys, or forward auth output to the renderer.
The status projection accepts the CLI's `claude.ai` first-party authentication
with subscription metadata. Missing or contradictory metadata remains unavailable.
Discovery, browser login, cancellation, logout, and verification use the
existing subscription service and UI contracts. Settings lists Anthropic once:
its card asks for "Claude subscription" or "API key" first, and shows the
official install methods with "Check again" while no usable CLI is found. Native
image attachments are not supported by this transport.

Model settings use `catalogChatModelIds("claude")`, the active catalog shared
with the API-key route; there is no separate subscription model list or alias
table. Explicit IDs pass unchanged through the documented `--model` flag. An
unlisted ID fails with `subscription-model-not-supported` whenever the service
opens a model session, including a saved selection after restart, without
substituting a model or authentication route. The runtime descriptor explicitly
offers the CLI default: an absent persisted `model` omits `--model`.
The installed runtime still decides account availability; a rejected request
fails the turn rather than retrying with another model.

The sign-in choices, model chooser, selected settings model and current composer
disclose the selected authentication route's billing: the user's own subscription
or the configured API key. Local routes without required API keys carry no
API-key billing claim.
The host drops every inherited `ANTHROPIC_*` and `CLAUDE_*` variable before
spawn; its own `CLAUDE_CONFIG_DIR` points to the isolated runtime home. Login
uses only `auth login` in that same home. Credential files and account tokens
remain owned by the CLI, outside the host's settings and secret stores.

`SubscriptionLlmProvider` sends the complete controlled conversation envelope for
each Ave model round. A print invocation receives that envelope on stdin and runs
with `--no-session-persistence`. No native session is resumed: Ave owns history,
tool results, compaction, and the next model round. Session ids in the output are
validated within the invocation rather than persisted as a second history owner.

The CLI disables built-in tools with `--tools ""`. The separately configured MCP
bridge receives exact named approvals; `--allowedTools` is not an exclusive tool
catalog. Strict MCP configuration and the validated `system/init` catalog limit
the expected tools to this bridge. Tool deferral and account-connected remote MCP
servers are disabled. Only an authenticated bridge invocation becomes
an Ave tool call. A stdout tool announcement cannot execute a host tool or finish
the round. The CLI's `EndConversation` control is allowed when present because the
CLI retains it while MCP tools exist; it is never exposed as an Ave tool call.

User and project settings sources, slash commands, Chrome integration, and hooks
are disabled for the invocation. The runtime uses an isolated working directory.
These controls are not an OS sandbox: administrator-managed CLI policies still
apply and may require hooks that the CLI will not let a caller override. Unexpected
catalog entries, plugins, or hook records fail the host stream; detecting a hook
record is not proof that a managed hook did not run. `--bare` is unsuitable here
because it excludes subscription OAuth authentication. Administratively managed
installations need their own compatible policy; Ave does not bypass that policy.

The shared `JsonLineReader` frames stdout. The transport additionally bounds actual
stdout/stderr bytes and queued events, validates UTF-8, and checks the native
result. A successful text round requires a consistent session, a successful
structured result, and successful process/stdio completion. Malformed or truncated
output, a failed result, unknown execution events, and extra records after the
result fail explicitly. Raw stderr is drained without retention or UI projection.

The first real user turn performs the print protocol and isolation checks that
require a model response. Every invocation validates its actual initialization
and bridge catalog, successful result and process completion. A nonzero startup
exit with a recognized argument-parser rejection before protocol initialization,
or a rejected initialization catalog, uses the existing runtime-incompatible
error and update guidance. Other startup/provider failures remain operation errors.
Only fixed diagnostic match state is retained from stderr, never its raw text.
Failures revoke the subscription service's verification proof; another session
must verify again.
[The subscription service](../../src/main/subscription-runtime-service.ts) owns
that revocation and checks its safety epoch on each tracked session call.
User cancellation stays cancellation.

One managed child owns each invocation. POSIX children receive an owned process
group so cancellation includes the CLI's MCP descendants. Generator completion,
setup failures, and resumed cancellation paths clean the temporary MCP
configuration in the iterator's finally block. A consumer must finish or return
the iterator for that cleanup to complete: stopping a paused iterator alone does
not advance it. Those files use the feature namespace's private atomic writer and
are never used as an auth store. Login termination currently clears its local
handle before a best-effort kill; a kill failure is not surfaced by that path.

The external protocol is documented in the official [CLI reference](https://code.claude.com/docs/en/cli-reference),
[programmatic usage guide](https://code.claude.com/docs/en/headless), and
[tools reference](https://code.claude.com/docs/en/tools-reference).
The [MCP guide](https://code.claude.com/docs/en/mcp) defines the tool-discovery controls.
