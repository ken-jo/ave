# Device authorization and proof-bound credentials

The owner decision of 2026-11-13 adds Device Code and DPoP to MCP and host-mediated plugin authentication. Authorization Code + PKCE and the existing login-window policy remain unchanged.

## Research (2026-11-14)

| Official source | Conclusion |
| --- | --- |
| [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) | Device authorization advertises `device_authorization_endpoint`. Poll after `interval` (five seconds when omitted), permanently add five seconds on `slow_down`, back off on connection timeout, and stop on denial, expiry or any other terminal OAuth error. Display the code even with a complete URI. |
| [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449) | Asymmetric proofs contain public JWK, fresh `jti`, `htm`, query/fragment-free `htu`, `iat`, optional nonce and resource-only `ath`. Public-client refresh tokens remain bound to the same key. |
| [Current authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | HTTP authorization retains discovery, resource binding, issuer validation, registration and PKCE. Device authorization is an explicitly selected extension. |
| [SEP-1932](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1932) | Open, Draft and unmerged at inspection. Its normative text adopts RFC 9449 without custom claims or content digests, and requires token/resource nonce handling. The stale content-digest testing-plan entry conflicts with the normative text; this implementation follows the latter and does not claim a final extension. |
| [Installed SDK source](https://github.com/modelcontextprotocol/typescript-sdk) | Locked `@modelcontextprotocol/sdk` 1.32.2 provides discovery URL construction, registration, code exchange and refresh, but no device lifecycle/poller or proof signer. Its generic token helper accepts custom grants but does not implement the device protocol. Existing SDK operations remain in use; the missing device and proof mechanisms live in host modules. |

The installed SDK's AS parser requires browser authorization fields. Device-only discovery therefore reuses its discovery URL builder and separately validates the raw device metadata, including the exact issuer and all endpoint types. Only discovery 404/405 advances to the next specified metadata URL. The SDK registration/refresh adapter passes validated device metadata without fabricating browser endpoints; those SDK operations consume only registration/token fields. Code-flow discovery is unchanged.

## Configuration and public contract

`oauth.grantType?: "authorization-code" | "device-code"` selects the MCP grant. Omission preserves Authorization Code + PKCE. Device flow also requires an advertised device endpoint; failure never opens the code flow instead. A pre-registered public `clientId` is preferred. Explicit or selected dynamic registration uses the device grant with no invented redirect URI. The published code-flow client metadata document is not used for device registration.

`oauth.dpop?: "required"` requires advertised, compatible proof support. Independently, advertising `dpop_signing_alg_values_supported` enables proof binding. Only ES256 is implemented. An absent advertisement retains Bearer mode unless required; a malformed or incompatible advertised set fails. A negotiated proof grant rejects a Bearer token response. Existing Bearer refresh grants that encounter newly advertised proof support require fresh interactive authentication rather than changing their binding silently.

Plugins opt in with `networkAccess.deviceCodeAuth: true`, the `external-auth-consumer` capability and the existing network allow-list. The additive host capability surface is:

```ts
hostApi.authDeviceCode.authorize({ issuer, clientId, resource, scopes?, dpop?, signal? })
  // -> { handle }
hostApi.authDeviceCode.fetch({ handle, url, method?, headers?, body?, signal? })
  // -> Response
hostApi.authDeviceCode.clear({ handle })
  // -> void
```

Plugins use pre-registered public clients. Signals remain local and are represented by host-call cancellation across the worker wire. Handles belong to one plugin incarnation; restarting requires `authorize` to reopen the matching encrypted grant. `fetch` accepts only the exact normalized authorized resource URL, rejects redirects and caller-supplied credential headers, and never exposes polling endpoints. `clear` invalidates matching local handles and deletes the encrypted grant; it does not claim remote revocation. Keys and refresh tokens never enter the plugin response. Public contract, wire schema, manifest schema and capability fixtures move together; external contract consumers adopt the surface at the next app release tag.

## Storage, requests and UI

Host signing keys are per credential. A generated key is serialized only for the existing encrypted secret store, then used as a non-exportable live signing key. Transient exported bytes are cleared; the encrypted serialization is host-private and restores the same key after restart. This is encrypted host storage, not a hardware-backed non-exportable key vault. Encryption must be available before authorization egress and is required again at the storage mutation, including development policy and weak-backend refusal. Corrupt key material fails clearly. Host OAuth key families are denied to both plugin secret export and credential leasing.

Token requests alone carry token proofs; resource requests use `Authorization: DPoP` with `ath`. Code authorization also sends `dpop_jkt`. Token/resource nonce domains are separate and scoped by origin. Each HTTP request gets at most one fresh-proof nonce retry, including concurrent requests; invalid proofs and repeated challenges terminate. Successful responses can rotate a cached nonce. Refresh requests use the original key and preserve refresh-token rotation. All network requests retain the existing host egress, effect and approval gates. Host credential form values and proof headers must stay out of reviewer/audit inputs while actual request bytes remain bound to the approval identity.

The host-owned modal presents the user code, verification URI, optional complete link, copy and cancel. It has no preload, scripts, remote content or network access. Main-frame action URLs name only stored host actions; navigation cannot supply arbitrary clipboard text or external targets. Closing the modal, its parent, or the caller aborts requests and polling. Success closes it without canceling the completed grant. Without a live human surface, a new device flow denies before egress with interactive-authentication guidance. Existing encrypted credentials may be reused unattended. Poll expiry starts at the device response, aborts pending requests and never restarts automatically. Connection timeouts double the interval; generic network failures terminate.

## Validation and limits

Unit coverage exercises every device/standard token error, metadata/config opt-in, cancellation, expiry, permanent slowdown and timeout backoff. Independent signature verification checks proof claims, nonce isolation, one retry, terminal proof errors and same-key restoration. Local HTTP AS integration covers device-only discovery/registration, both grants, PKCE preservation, resource proofs, refresh rotation and restart identity. The real secret document store is tested with authenticated encrypted persistence, unavailable encryption and ciphertext tampering. The background modal flow checks rendered content, copy/open/cancel, overflow and focus behavior with a screenshot.

Native OS keychain availability and live third-party authorization servers are outside local fixture coverage. Static gates include typecheck, unused-code and lint baselines, i18n, protocol schema, duplicate helpers, packaging discipline and script lock suites.
