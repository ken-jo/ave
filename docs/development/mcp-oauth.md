# Remote MCP authentication

Remote Streamable HTTP servers added separately in MCP settings and configured with OAuth can use browser authentication from their server row. Select OAuth for an HTTP server, save it, then choose **Authenticate**. An HTTP 401 challenge on that server marks authentication as required without opening a browser. The host opens the authorization page only after the user chooses the action, receives a loopback redirect, and reconnects through the existing MCP manager after authentication succeeds.

Authentication status is separate from connection status: `required`, `authenticating`, `authenticated`, or `error`. An authenticated server can still fail to connect because of transport, policy, or protocol errors. Background connection attempts never open an authentication browser. The renderer receives status and `mcp-auth-required` or `mcp-auth-failed` errors, never access tokens, refresh tokens, client secrets, authorization codes, or authorization URLs. The authenticate action can be retried after failure.

The flow follows the MCP authorization specification revision `2026-07-28` (the current revision as of 2026-10-22): [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [authorization server discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery) and [client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration).

## Ownership and reuse

| Responsibility | Owner |
| --- | --- |
| MCP framing, HTTP transport, tool discovery and invocation | Existing `McpClient` and `HttpTransport` in [`mcp-client.ts`](../../src/mcp/mcp-client.ts) |
| Authentication session, discovery, token attachment and refresh | [`mcp-oauth.ts`](../../src/mcp/mcp-oauth.ts) |
| Connection lifecycle and tool registration | [`mcp-manager.ts`](../../src/mcp/mcp-manager.ts) |
| Encrypted credential persistence | Existing `SettingsService` secret methods and secret document store |
| Loopback callback listener | Existing [`AuthRedirectCatchers`](../../src/main/auth-redirect-catcher.ts) |
| Outbound HTTP | Existing host `singleHopNetworkFetch` and [`network-guard.ts`](../../src/core/network-guard.ts) |
| Discovery, registration, PKCE and token request primitives | Installed protocol SDK authorization helpers |

No alternate MCP transport or credential file is introduced. The host supplies browser opening and callback capabilities during boot. Authentication does not grant permission to invoke tools; discovery and invocation retain the [architecture's permission and audit requirements](../architecture/architecture.md#mcpplugin-execution-parity-invariant).

## Discovery and authorization

The session reads `resource_metadata` and scope information from a server's `WWW-Authenticate` challenge. Without that metadata URL it tries the endpoint-specific protected-resource well-known URI, then the origin's well-known URI. Protected-resource metadata is required; the MCP origin is never guessed to be the authorization server.

The resource identifier must match the configured endpoint exactly, or use the same origin with a containing path at a segment boundary and no query component. Validation happens before client registration, browser opening, or credential transmission. The authorization server comes from the validated resource metadata. Its metadata is discovered using the standard authorization-server and identity-provider well-known locations, including issuer paths. Its `issuer` must exactly match the selected issuer identifier.

Authorization requires metadata that explicitly advertises PKCE `S256`. The session records the issuer, a fresh state value and the code verifier for that attempt in host memory. It validates state and any returned `iss` before exchanging a code; when metadata sets `authorization_response_iss_parameter_supported: true`, a missing `iss` is rejected too. Issuer comparison uses the decoded string without URI normalization.

The selected resource identifier is included in the authorization request, authorization-code exchange and refresh request. Access tokens are attached only to requests to the configured MCP endpoint. Metadata and token requests use the host's egress transport with URL validation, timeout policy and redirect rejection. Production authorization endpoints require HTTPS. Explicit private-network configuration permits loopback HTTP for local development; it does not permit insecure non-loopback authorization endpoints.

The initial unauthenticated resource request can discover a challenge, but a successful anonymous response never reaches capability discovery. Later requests cannot fall back to anonymous access after losing a grant. A failed initial network request can be retried without granting anonymous access.

## Client registration and compatibility

This flow supports dynamic client registration when authorization-server metadata advertises a registration endpoint. An omitted `clientRegistration` setting and explicit `dynamic` select this flow; other explicit registration modes are rejected rather than silently converted. The client describes a native application with authorization-code and refresh-token grants and registers the actual loopback redirect URI. Registration credentials are bound to the issuing authorization server. A compatible saved registration can be reused even if the server no longer advertises registration.

The current authorization specification recommends hosted client metadata documents and retains dynamic registration for compatibility. Ave does not yet provide a hosted client metadata document or a settings field for a pre-registered client ID. A server that offers neither a usable registration endpoint nor previously stored compatible registration therefore cannot complete this flow. Authentication fails visibly instead of inventing a registration endpoint or hosted client identifier.

This feature covers HTTP transport authorization. Stdio credentials keep their existing configuration path. Automatic scope escalation following HTTP 403 is outside this flow; an insufficient-scope response is a connection or invocation failure, not permission to silently open a new browser flow.

OAuth servers bundled with plugins are excluded from plugin activation. Their lifecycle records `credential_required` and directs the user to configure the remote endpoint separately in MCP settings. Bundled rows do not offer **Authenticate**. This avoids attaching an interactive credential session to an unimplemented plugin-generation lifecycle; configuring the endpoint separately does not authenticate the bundled server.

## Token lifecycle and failure behavior

Stored registration and token records are bound to the server configuration, selected resource and authorization issuer. Changing the server URL or OAuth configuration selects a different credential key. Discovery rejects reuse if the issuer or resource changes. Secrets use the existing encrypted store; an unavailable encryption backend must not create a new plaintext credential path. Explicit development-only plaintext storage policy does not establish encrypted-storage validation.

A metadata location supplied by a challenge is retained in the encrypted record so refresh can rediscover it after restart. The host still validates the URL, resource and issuer again before using stored credentials.

Refresh preserves a prior refresh token when the issuer omits a replacement and stores a rotated refresh token when supplied. Within one server session, concurrent refresh requests share one refresh operation, and concurrent authenticate actions share one login operation. Each HTTP request permits one refresh and one retry after a token-related HTTP 401. Repeated HTTP 401 responses do not create an unbounded retry loop.

A permanent grant rejection clears saved tokens and returns the server to `required`, allowing the user to choose **Authenticate** again. A rejected client registration also clears the client credentials. Transient refresh failures preserve saved credentials and set `error`, allowing a later retry without discarding a usable refresh token. Credential generations prevent an obsolete refresh result from overwriting newer login credentials or clearing their authority.

The callback listener is released after success, cancellation, failure or disposal. When the running manager replaces a known session after configuration changes, it waits for that session's credential record to be cleared before creating the replacement. Removing a server clears its current credential record. Offline configuration edits can leave records under older hashed keys: the manager cannot enumerate those prior keys from the new configuration. Changed endpoint or OAuth configuration does not reuse them.

Kill, removal and shutdown retire pending authentication before connection teardown. Lifecycle generations and the configuration critical section prevent a delayed login from reconnecting or registering tools after retirement. Losing authorization also removes the server's available tools. Provider response bodies and credential-bearing URLs must not appear in logs, IPC responses or user-facing errors.

## Verification

The runtime tests use local HTTP servers. Most run with the explicit private-network option; one integrated case addresses the mock server by a public HTTPS host name so resource, metadata and token requests pass through the network guard's public-address resolution without that option. They inspect actual registration and token requests, verify the challenge against the received verifier, and exercise authenticated MCP requests. Required cases are discovery from a challenge and well-known metadata, issuer and resource rejection, PKCE `S256`, resource parameters on each grant, refresh rotation, revoked-token reauthentication, bounded retry, state and callback issuer rejection, and credential isolation.

Manager tests cover authentication state, reconnection through governance, session disposal, tool removal, retired login races and the rejection of bundled interactive authentication. The integrated manager/session/client mock flow exercises the real transport and authorization boundaries together. IPC and preload tests cover the typed authenticate action and sender validation. The changed MCP-settings browser flow checks action availability, busy state and status rendering. A mock issuer validates protocol behavior; it does not establish interoperability with an external authorization service or the availability of a machine's encrypted storage backend.
