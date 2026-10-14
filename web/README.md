# former-site.invalid

Unified web home for [Ave AI](https://former-site.invalid) — marketing landing (`/`) and the
user guide (`/docs/*`) in a single Next.js 14 static-export app.

- Design system: see `docs/DESIGN.md` (marketplace-aligned neutral system)
- Deployment: Cloudflare Pages via wrangler direct upload — see `DEPLOY.md`
- `docs.former-site.invalid` is a 301 redirect shim to `former-site.invalid/docs/*` (see `infra/docs-redirect/`)

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # static export → out/
npm run preview  # serve out/ locally
```

## Structure

```
app/            landing (/) + docs routes (/docs/**)
components/     landing/*, docs/*, motion/*, ui/*
lib/            navigation, search-index, roadmap, downloads
public/         favicon, ave-mark
infra/          docs-redirect shim for the legacy docs domain
```

## Desktop packages

Every download button links to a stable alias on the R2 release channel, the
same host installed apps update from (`package.json` `build.publish`):

```
https://downloads.agent-connector.ai/latest/mac-arm64.dmg
https://downloads.agent-connector.ai/latest/windows-x64-setup.exe
https://downloads.agent-connector.ai/latest/linux-x86_64.AppImage
```

The release workflow refreshes these aliases on every tag
(`scripts/upload-release-r2.mjs`) as server-side copies of the versioned files
under `releases/`, and each one downloads under its versioned file name
(`Content-Disposition`). See `docs/guides/release-r2.md`.

The landing page auto-detects the visitor's OS and highlights the matching card.
