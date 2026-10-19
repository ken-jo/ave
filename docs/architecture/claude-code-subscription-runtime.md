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

Native executables run from a private, sealed, content-hashed copy. Package
launchers resolve only the official package's `cli.js` and a pinned native
interpreter, without a shell. The interpreter, package files and declared
required/optional/peer dependency closure are copied through the same no-follow
hashing and sealing primitives. Dependency directory layout is preserved, so
nested and hoisted dependencies resolve inside the snapshot. Missing required
dependencies, package symlinks and unsupported script interpreters fail closed.

Package entry points run only from that snapshot. A sealed preload registers
synchronous module resolution/loading hooks before entry execution. Both import
and require are restricted to built-ins and the copied file manifest. Global
module search is disabled; undeclared, absolute and network module sources
outside the manifest are rejected. JavaScript and JSON code are loaded from
no-follow handles and checked against their digests at load time. The script
interpreter must support synchronous loading hooks (22.15.0 or later on the 22.x
line, 23.5.0 or later on newer lines); unsupported runtimes are rejected before the CLI probe.
Copied package metadata is also checked around resolution and loading.
The installed script or its dependencies are never executed by path after a
check, so an installer replacing them cannot change the invocation's code.

Qualification, authentication and each turn recheck the original launcher route,
source dependency graph and the sealed private artifact immediately before
spawn. A changed source or artifact refuses the next turn of an existing session.
The ownership trust boundary remains the current account and root, as for native
artifacts; it does not claim to isolate a compromised current account or replace
the operating system's native library loader.

Discovery checks the version identity and advertised authentication commands.
Help is not a complete flag inventory. Connected verification exercises the
actual print arguments and validates the initialization catalog and successful
structured result before granting chat capability. A signed-out verification
creates no transport proof. Failed identity qualification is
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
official install methods with "Check again" while no usable CLI is found. Model selection and native
image attachments are not supported by this transport.

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

Verification performs version/auth checks and one short print request under the
same stream contract without tools. Every tool-enabled invocation also validates
its actual bridge catalog. Failures revoke the subscription service's verification
proof; another session must verify again.
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
