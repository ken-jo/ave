## Important: unsigned and not notarized

This is an operator-approved unsigned public release. It is not signed with a Windows Authenticode certificate and it is not macOS notarized.

- **Windows:** SmartScreen and an "Unknown publisher" prompt are expected. Download only from the official download host, https://downloads.agent-connector.ai.
- **macOS:** Gatekeeper may block the first launch because the app is unsigned and not notarized. Do not bypass OS protections unless you independently trust this release.
- **Linux:** before installation, compare `openssl dgst -sha512 -binary <file> | base64` with the `sha512` that https://downloads.agent-connector.ai/releases/latest-linux.yml lists for that file.

The public tag build contains no embedded internal credentials.
