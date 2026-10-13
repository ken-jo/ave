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

Every download button opens the latest GitHub Release, and the visitor picks
the asset for their platform there:

```
https://github.com/former_org/ave/releases/latest
```

The buttons do not deep-link to an asset file. Assets are published under their
version (`Ave-0.10.0-mac-arm64.dmg`), so a static href can only name a file
that stops existing at the next release, and the `Ave-latest-*` aliases that
once gave those files a stable name are no longer published.

The landing page auto-detects the visitor's OS and highlights the matching card.
