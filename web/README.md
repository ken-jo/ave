# Ave website

The product site and user guide for Ave, a Next.js static export served from
the canonical host. Korean lives at `/`, English under `/en/`.

- Design decisions: `DESIGN.md`
- Deployment: `DEPLOY.md`

## Pages

```
/                 home (ko)        /en/                 home (en)
/browser/ /terminal/ /models/ /plugins/ /security/   feature pages (and /en/…)
/download/        installers       /en/download/
/docs/            guide index      /en/docs/
/docs/<slug>/     guide pages      /en/docs/<slug>/
/changelog/       CHANGELOG.md     /en/changelog/
404.html          not found        en/404.html
```

Copy is data: home in `lib/home.ts`, feature pages in `lib/features.ts`,
download, docs index, changelog and not-found in `lib/pages.ts`, the guide in
`lib/docs.ts`; `lib/nav.ts` owns every destination and label. The changelog
page parses the repository's `CHANGELOG.md` at build time (`lib/changelog.ts`).
Screenshots are in `public/media/` with their sizes in `lib/media.json`
(`DESIGN.md`, "Media"). Pages that existed before this structure are
redirected by `public/_redirects`.

`bun run build` exports to `out/`, moves the not-found pages to `404.html` and
`en/404.html`, and checks the export's link graph
(`scripts/lib/web-export.mjs`); a broken rule fails the build.

## Files the app reads

These keep their URLs. The app fetches them from the canonical host.

- `public/.well-known/ave-service.json`: the service descriptor current builds read.
- `public/announcements/v1.json`: announcements the descriptor names.
- `public/schemas/**`: the plugin host protocol schema mirror and the contract
  schemas (`plugin/`, `skill/`, `marketplace/`) at their `$id` URLs, both
  maintained by `scripts/lib/plugin-host-protocol-mirror.mjs`.

`test/scripts/web-site-contract.test.ts` checks them, the download links and
the page map.

## Local development

```bash
bun install --frozen-lockfile
bun run dev      # http://localhost:3000
bun run build    # static export → out/
```

## Downloads

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

While no release is published, `RELEASE_PUBLISHED` in `lib/downloads.ts` stays
false and the download page shows "release in preparation" instead of these
links.
