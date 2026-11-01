# Endpoint-scoped egress acceptance

Run from the repository root in a non-elevated interactive Windows x64 desktop
session. Use a verified SDK 1.0.1 installation and its dependencies. The driver
and child runtime must be the same trusted executable; this probe starts one
container and retains its fresh fixture directory. It makes no ACL, registry or
account changes and does not remove files. The SDK applies its own temporary
container/network state. See [the common probe prerequisites](README.md).

First compile the production listener and its host dependencies into an ignored
local bundle. This is a diagnostic input, never a packaged application resource:

```powershell
bun x esbuild src/permissions/egress-invocation-listener.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/mxc-egress-listener.mjs
$Electron = 'C:\staged-app\electron.exe'
$Sdk = 'C:\staged-sdk\node_modules\@microsoft\mxc-sdk'
$env:ELECTRON_RUN_AS_NODE = '1'
& $Electron tools/mxc-probes/egress-policy.mjs --sdk-root $Sdk --runtime $Electron
```

Replace the two synthetic paths with verified absolute paths. Record their
SHA-256 hashes, the OS build, session and JSON output. Every fixture server
listens on `127.0.0.1` only; the probe opens no wildcard or non-loopback
listener, so it cannot raise a Windows Defender Firewall prompt or leave an
inbound rule for the runtime executable. A non-loopback host IPv4 address is
still required as the direct-egress target. Before native isolation is attempted,
two host positive controls must hold: loopback reaches the unrelated fixture
server, and a host connection to the same port on the non-loopback address is
actively refused (`ECONNREFUSED`, since nothing listens there). That proves the
address is routed and answered by the host stack, so the container's
EACCES/EPERM on the same target is a policy refusal rather than a missing route.
A host connection that succeeds or fails any other way stops the probe as an error.

The production listener is main-owned. Its diagnostic upstream records the
host-stamped authorization and returns 200 for `allowed.example/fixture`, 403 for
`denied.example/fixture`; neither hostname causes external traffic. A container
configured for holder A sends forged holder-B labels on both requests, then
attempts raw TCP to holder B, an unrelated loopback listener and the closed
fixture port on the host's non-loopback address. The run records actual upstream attribution and
independent unrelated-server accepts. Native refusal requires EACCES or EPERM;
a deadline or absent listener cannot establish isolation. The request admits
only A's proxy URL and no worker control port. The child creates no listener.

Inspect `details[].accepted`, not only the top-level verdict. Acceptance requires
A's successful request, a policy refusal stamped as A despite the forged label,
three native connection denials, and zero unexpected unrelated-server accepts.
`kernel-channel` describes endpoint scoping; it does not authenticate the proxy
process owner or imply closed inbound traffic. This diagnostic upstream does
not certify the production destination allowlist, DLP masking or audit sink.
Those remain covered by the production egress integration suites and native
packaged release gate.

Portable checks:

```sh
node --test tools/mxc-probes/egress-policy.test.mjs
node --check tools/mxc-probes/egress-policy-child.mjs
node --check tools/mxc-probes/egress-policy-run.mjs
```
