# Remote MCP authentication

Remote Streamable HTTP servers configured with OAuth, whether added in MCP settings or bundled with a plugin, can use browser authentication from their server row. Select OAuth for an HTTP server, save it, then choose **Authenticate**. An HTTP 401 challenge on that server marks authentication as required without opening a browser. The host opens the authorization page only after the user chooses the action, receives a loopback redirect, and reconnects through the existing MCP manager after authentication succeeds.

Authentication status is separate from connection status: `required`, `authenticating`, `authenticated`, `insufficient_scope`, or `error`. An authenticated server can still fail to connect because of transport, policy, or protocol errors. Background connection attempts never open an authentication browser. The authenticate action can be retried after failure.

The renderer receives status and one of these error codes, never access tokens, refresh tokens, client secrets, authorization codes, or authorization URLs:

| Code | Meaning |
| --- | --- |
| `mcp-auth-required` | No usable grant; choose **Authenticate**. |
| `mcp-auth-failed` | The flow or connection failed; retry. |
| `mcp-auth-storage-unavailable` | Encrypted secret storage is unavailable, so no flow starts. |
| `mcp-auth-storage-unreadable` | A saved credential record could not be decrypted or read. |
| `mcp-auth-registration-unsupported` | The configured client registration cannot be used with this server. |
| `mcp-auth-resource-mismatch` | The protected-resource metadata describes a different resource than this endpoint; nothing was registered or opened. |
| `mcp-auth-index-unreadable` | Shown on the server row while the credential index cannot be read; stored sign-ins are not cleaned up until it is rebuilt. |

Each code has English and Korean text in the MCP settings tab.

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

The resource identifier must match the configured endpoint exactly, or use the same origin with a containing path at a segment boundary and no query component. When the metadata was located through a challenge's `resource_metadata` parameter, its `resource` must be identical to the endpoint's canonical URI ([RFC 9728 §3.3](https://www.rfc-editor.org/rfc/rfc9728#section-3.3)). A mismatch in any of these checks, or against a configured `oauth.resource`, fails with `mcp-auth-resource-mismatch`. The selected value sent on the wire is the resource the metadata declares. Validation happens before client registration, browser opening, or credential transmission. The authorization server comes from the validated resource metadata. Its metadata is discovered using the standard authorization-server and identity-provider well-known locations, including issuer paths. Its `issuer` must exactly match the selected issuer identifier.

Authorization requires metadata that explicitly advertises PKCE `S256`. The session records the issuer, a fresh state value and the code verifier for that attempt in host memory. It validates state and any returned `iss` before exchanging a code; when metadata sets `authorization_response_iss_parameter_supported: true`, a missing `iss` is rejected too. Issuer comparison uses the decoded string without URI normalization.

The selected resource identifier is included in the authorization request, authorization-code exchange and refresh request. It is sent in canonical form ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)): an origin-only resource has no trailing slash, and a path keeps its exact spelling. The SDK helpers serialize a parsed URL, which always adds a slash after an origin, so the session sets the `resource` parameter itself. Access tokens are attached only to requests to the configured MCP endpoint. Metadata and token requests use the host's egress transport with URL validation, timeout policy and redirect rejection. Production authorization endpoints require HTTPS. Explicit private-network configuration permits loopback HTTP for local development; it does not permit insecure non-loopback authorization endpoints.

The initial unauthenticated resource request can discover a challenge, but a successful anonymous response never reaches capability discovery. Later requests cannot fall back to anonymous access after losing a grant. A failed initial network request can be retried without granting anonymous access.

## Client registration

The session chooses a client in the order the client-registration specification recommends:

1. **Pre-registered client.** When `oauth.clientId` is set, it is used as a public client (`token_endpoint_auth_method: none`). No metadata document is fetched and no registration request is sent. The ID must be 1 to 256 visible ASCII characters with no spaces. It can be combined only with an omitted `clientRegistration`, `preregistration` or `manual`. The operator registers the redirect URI `http://127.0.0.1` with any port.
2. **Client ID metadata document.** When authorization-server metadata sets `client_id_metadata_document_supported: true` and either omits `token_endpoint_auth_methods_supported` or lists `none`, Ave uses its published document as the `client_id`: [`https://ave.agent-connector.ai/oauth/mcp-client.json`](https://ave.agent-connector.ai/oauth/mcp-client.json). Its source is [`web/public/oauth/mcp-client.json`](../../web/public/oauth/mcp-client.json), and the web deployment serves it as `application/json`.
3. **Dynamic registration.** This is the deprecated compatibility path, used when the server advertises a registration endpoint. A saved dynamic registration is reused only when it was issued by the same authorization server, has not expired, and lists the redirect URI of the current flow. Otherwise the session registers again.

An omitted `clientRegistration` follows this order. If the server then refuses the metadata document — an `invalid_client` or `unauthorized_client` error on the authorization callback or at the token endpoint — the same **Authenticate** action runs the flow once more with dynamic registration, and later flows in that session go straight to registration. A refusal shown only in the browser, without a redirect back, cannot be detected and ends as a timeout. `client-id-metadata-document` requires the metadata document and never falls back. `dynamic` uses only registration. When the configured mode cannot be used with the server, the flow stops with `mcp-auth-registration-unsupported`. This happens before a callback listener opens or a browser starts. Modes are never silently converted.

The callback listener binds `127.0.0.1` on an ephemeral port, so each flow can use a different port. The metadata document and pre-registered clients therefore list `http://127.0.0.1` without a port. [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3) requires authorization servers to accept any port for a loopback IP-literal redirect. [§8.3](https://www.rfc-editor.org/rfc/rfc8252#section-8.3) discourages `localhost`. Other callers of the shared callback listener keep their `localhost` default.

This feature covers HTTP transport authorization. Stdio credentials keep their existing configuration path.

## Step-up authorization

A token-bearing request answered with HTTP 403 and `error="insufficient_scope"` records the challenged scope and metadata location. Status moves to `insufficient_scope`, and existing tools stay registered. No browser opens. The next **Authenticate** action requests the union of the granted and challenged scopes. A failed step-up keeps the previous grant and status; a token response is validated before it can replace the stored grant. Each challenged scope set gets at most two step-up attempts per session; after that the 403 is returned as an ordinary failure. This keeps the specification's "no more than a few times" bound.

## Bundled servers

A plugin-bundled OAuth server is withheld from activation until it is authenticated. Its lifecycle records `credential_required` (retryable). Its settings row offers **Authenticate** under the bundled configuration ID. The session key is derived from the package and server name, so a regenerated runtime ID keeps the same credentials. A successful action disconnects that server's runtime instances and asks the bundled credential source to reconnect. The connection then sends requests through the authenticated session. No host code branches on a specific plugin.

Bundled grants are recorded in the credential index under their stable ID. A package source that reports a complete list (no package of its kind failed to load) retires the grants of bundled OAuth servers its list no longer declares, which is how an uninstalled plugin's sign-in is removed. An incomplete or unreadable list deletes nothing. Plugin kinds without a registered package source keep their grants until the server is authenticated again under a different key.

## Token lifecycle and failure behavior

Stored registration and token records are bound to the server configuration, selected resource and authorization issuer. The credential key derives from the server ID, URL and OAuth configuration. Discovery rejects reuse if the issuer or resource changes. Each record also stores its client source, and a record with an unknown source or a non-canonical resource is not used.

Secrets use the existing encrypted store. Encryption availability comes from the settings service (`isSecretStorageEncrypted`), which is the same source the secret writer uses. It is checked before discovery, a callback listener, or registration. An unavailable backend stops the flow with `mcp-auth-storage-unavailable` and never creates a plaintext credential path. A record that cannot be read sets `mcp-auth-storage-unreadable`; the next action reads storage again.

A metadata location supplied by a challenge is retained in the encrypted record so refresh can rediscover it after restart. The host still validates the URL, resource and issuer again before using stored credentials.

Refresh preserves a prior refresh token when the issuer omits a replacement and stores a rotated refresh token when supplied. Within one server session, concurrent refresh requests share one refresh operation, and concurrent authenticate actions share one login operation. Each HTTP request permits one refresh and one retry after a token-related HTTP 401. Repeated HTTP 401 responses do not create an unbounded retry loop.

A permanent grant rejection clears saved tokens and returns the server to `required`, allowing the user to choose **Authenticate** again. A rejected client registration also clears the client credentials. Transient refresh failures preserve saved credentials and set `error`, allowing a later retry without discarding a usable refresh token. Credential generations prevent an obsolete refresh result from overwriting newer login credentials or clearing their authority.

The callback listener is released after success, cancellation, failure or disposal. Session creation is synchronous per server, so concurrent connections share one session. The manager keeps an encrypted index from server ID to credential key. Replacing a session deletes the old record only when the credential key changed. An unrelated edit, such as a header, keeps the grant: the old session first lets a refresh it has in flight finish and persist (a rotated refresh token is not lost), and the new session reads the record after that. Removing a server deletes its record after the configuration file is rewritten, and removal does not fail when the old URL no longer parses.

At startup, records in the index that no configured server uses are deleted, which also covers configuration edits made while Ave was not running. This happens only when the configuration file itself was read and parsed. A missing, empty or unparsable file, or a legacy `.bak` fallback, deletes nothing, so a syntax error cannot sign the user out of every server. A first run has neither a file nor an index. An index that cannot be read or parsed is logged as an error and shown on OAuth server rows. Nothing is deleted on its account. After the next successful configuration load it is rewritten from the keys known then; records it had listed for servers that no longer exist stay in the store, unreferenced.

Kill, removal and shutdown retire pending authentication before connection teardown. Lifecycle generations and the configuration critical section prevent a delayed login from reconnecting or registering tools after retirement. Losing authorization also removes the server's available tools. Provider response bodies and credential-bearing URLs must not appear in logs, IPC responses or user-facing errors.

## Verification

The runtime tests use local HTTP servers. Most run with the explicit private-network option; one integrated case addresses the mock server by a public HTTPS host name so resource, metadata and token requests pass through the network guard's public-address resolution without that option. They inspect actual registration and token requests, verify the challenge against the received verifier, and exercise authenticated MCP requests. Required cases are discovery from a challenge and well-known metadata, issuer and resource rejection, PKCE `S256`, resource parameters on each grant, refresh rotation, revoked-token reauthentication, bounded retry, state and callback issuer rejection, and credential isolation.

The authorization-server fixture is strict. It checks redirect URIs exactly at authorize and token time. Only a loopback IP literal ignores the port. It rejects unknown clients and validates a fetched metadata document's `client_id`, required fields and redirect URIs. Mode cases cover selection order, metadata documents, pre-registered clients without registration, re-registration for a new redirect URI after revocation, step-up and its limit, origin-only resources, challenge resource equality, and storage failures before any browser step.

Manager tests cover authentication state, reconnection through governance, session disposal, tool removal, retired login races, credential-identity deletion, orphan cleanup, concurrent session creation and bundled authentication. The integrated manager/session/client mock flow exercises the real transport and authorization boundaries together. IPC and preload tests cover the typed authenticate action and sender validation. The changed MCP-settings browser flow checks action availability, busy state and status rendering. A mock issuer validates protocol behavior; it does not establish interoperability with an external authorization service or the availability of a machine's encrypted storage backend.
