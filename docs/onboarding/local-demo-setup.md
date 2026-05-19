# Ave Local Demo Setup

This guide covers the corporate internal demo loop (Path 2). Demo mode lets a new
user click **"데모 자격증명으로 30초 안에 체험"** in the Login modal and have the
app silently provision an LLM key + endpoint without typing anything.

## How demo mode is activated

Demo mode is activated by environment variables read at boot. The `LoginModalConversational`'s demo chip auto-fires `loginMockup` with the
hard-coded `demo` / `demo123` mockup credentials; the IPC handler then
looks up the per-vendor API key from `AVE_DEMO_KEY_<VENDOR>` and persists
it into the encrypted secret store.

| Env var | Purpose |
|---|---|
| `AVE_DEMO_ENABLED=1` | Master gate. Without this, the IPC handler refuses to register in packaged builds. |
| `AVE_DEMO_VENDOR=azure-foundry` | Top-level vendor the login activates (default is `azure-foundry` for corporate internal demo). |
| `AVE_DEMO_KEY_AZURE_FOUNDRY=<api-key>` | The Azure Foundry API key to provision. |
| `AVE_DEMO_BASEURL_AZURE_FOUNDRY=<endpoint>` | The Azure Foundry endpoint URL. |
| `AVE_DEMO_MODEL_AZURE_FOUNDRY=<model>` | Optional model id override. |
| `AVE_DEMO_HOST_MAP=<host>=<ip>,<host>=<ip>` | Comma-separated host→IP table for the Electron `host-resolver-rules` switch (see "Host mapping" below). |

These variables are scrubbed from `process.env` in packaged builds before
the renderer / preload / workers can observe them. The captured values
live in main-process module state only.

## Host mapping (corporate intranet)

The Azure Foundry demo endpoint (`aif-example.*.azure.com`)
resolves only on the corporate intranet (10.0.100.0/24). Public DNS does not
return these IPs.

Ave applies the mapping **inside Electron only** via the Chromium
`host-resolver-rules` command-line switch — no `/etc/hosts` mutation, no
sudo. The mapping is sourced from `AVE_DEMO_HOST_MAP` and is applied at
boot iff `AVE_DEMO_VENDOR=azure-foundry`.

Example value (corporate intranet IPs as of 2026-05-19):

```
AVE_DEMO_HOST_MAP="aif-example.cognitiveservices.azure.com=10.0.100.174,aif-example.openai.azure.com=10.0.100.175,aif-example.services.ai.azure.com=10.0.100.176"
```

When `AVE_DEMO_VENDOR` is anything other than `azure-foundry`, the host
map is ignored (other vendors resolve via public DNS).

## Local launch — `.env.demo` template

Create `~/.ave/.env.demo` (or pass via your launch script) with the demo
credentials. The file is gitignored by repo convention — never commit it.

```bash
# ~/.ave/.env.demo — local demo credentials (DO NOT COMMIT)

export AVE_DEMO_ENABLED=1
export AVE_DEMO_VENDOR=azure-foundry

# Azure Foundry endpoint (corporate issued; intranet-only)
export AVE_DEMO_KEY_AZURE_FOUNDRY="<paste-api-key-here>"
export AVE_DEMO_BASEURL_AZURE_FOUNDRY="https://aif-example.openai.azure.com/openai/v1/"
export AVE_DEMO_MODEL_AZURE_FOUNDRY="gpt-4o"

# Host resolver — Electron-only, no /etc/hosts mutation
export AVE_DEMO_HOST_MAP="aif-example.cognitiveservices.azure.com=10.0.100.174,aif-example.openai.azure.com=10.0.100.175,aif-example.services.ai.azure.com=10.0.100.176"
```

Then launch the app with:

```bash
source ~/.ave/.env.demo && bun run start
```

When the Login modal opens, click the green **"데모 자격증명으로 30초 안에 체험"**
chip (or press `1`). The chip auto-fires `loginMockup`, persists the key
to the keychain, flips top-level `authMode=login` + `provider=azure-foundry`,
and closes the modal.

## Troubleshooting

- **`로그인 처리 중 오류가 발생했습니다.`** — IPC channel error. Check the
  main-process log for the underlying exception.
- **`데모 API 키가 환경 변수에 설정되어 있지 않습니다.`** — `AVE_DEMO_KEY_AZURE_FOUNDRY`
  is unset. Verify the `.env.demo` file is sourced before launch.
- **`데모 자격증명이 올바르지 않습니다.`** — the renderer chip used the wrong
  username/password. Should never happen with the chip-driven flow; if it
  does, file an issue with the auth audit log.
- **Network errors reaching `aif-example.*.azure.com`** —
  verify `AVE_DEMO_HOST_MAP` is set AND `AVE_DEMO_VENDOR=azure-foundry`.
  The main-process log emits `[demo-host-resolver] mapping applied: N
  host(s)` when the switch is installed; absence of that line means the
  switch was skipped (vendor mismatch or empty map).
- **Public network user (not on corporate intranet)** — the demo loop is
  intentionally intranet-only. Use the BYOK chip (`2`) to enter your own
  vendor API key via Settings → LLM tab.
