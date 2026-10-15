# R2 Release Channel

Status: Active. Cloudflare R2 is the primary download and auto-update channel.
The GitHub Release that the tag workflow drafts is a secondary record; the
source repository is private, so installed apps never read it.

## Implementation Anchors

- `package.json` `build.publish`: one `generic` entry,
  `https://downloads.agent-connector.ai/releases`, channel `latest`,
  `useMultipleRangeRequest: false` (R2 documents single `Range` requests;
  electron-updater otherwise sends multi-range ones). electron-builder embeds this entry as the
  packaged `app-update.yml`.
- `scripts/lib/release-channel.mjs`: object layout, upload order, headers.
- `scripts/upload-release-r2.mjs`: runs the plan (`--dry-run` prints it).
- `.github/workflows/build-installers.yml`, job `publish-r2`: tag builds only.
- `web/lib/downloads.ts`: the website's download buttons.
- Tests: `test/scripts/release-channel.test.ts`,
  `src/__tests__/packaging-discipline-source.test.ts`.

## Object Layout

| Key | Content | `Cache-Control` |
| --- | --- | --- |
| `releases/<Product>-<version>-<platform>.<ext>` | installers (`dmg`, `zip`, `exe`, `AppImage`, `deb`, `rpm`) | `public, max-age=31536000, immutable` |
| `releases/<installer>.blockmap` | differential-update sidecars | `public, max-age=31536000, immutable` |
| `latest/<platform>.<ext>` | server-side copy of the newest installer, downloads under its versioned name | `public, no-cache, must-revalidate` |
| `releases/latest.yml`, `latest-mac.yml`, `latest-linux.yml` | update feed (Windows, macOS, Linux) | `public, no-cache, must-revalidate` |

The feed and the versioned files share `releases/` because electron-updater
resolves each `url:` in a feed against the feed's own base URL, and finds the
previous version's blockmap by replacing the version in the new file's URL.
Versioned names keep every release. The upload writes versioned files first,
then the `latest/` aliases, then the three feed files, so a client never reads
a feed that names a missing file. A versioned object that already exists is
kept when its bytes are identical and is a failure when they differ.

Website links: `https://downloads.agent-connector.ai/latest/mac-arm64.dmg`,
`.../latest/windows-x64-setup.exe`, `.../latest/linux-x86_64.AppImage`.

## One-Time Cloudflare Setup (owner)

1. Create the R2 bucket (any name; the workflow reads it from `R2_BUCKET`).
2. Bucket → Settings → Custom Domains → Add `downloads.agent-connector.ai`.
   The `agent-connector.ai` zone must be in the same Cloudflare account. Wait
   until the status is **Active**. Leave the `r2.dev` public URL disabled.
3. R2 → Manage API tokens → Create an **Account API token** with permission
   **Object Read & Write**, applied to this bucket only. Record the Access Key
   ID and Secret Access Key; the secret is shown once.
4. In the repository's environment settings, create or open `release` and allow
   deployments only from branch `main` and tags `v*`. Add its four environment
   secrets (values are pasted at the prompt, never typed into a command line or
   a file):

   ```bash
   gh secret set R2_ACCOUNT_ID -R ken-jo/ave --env release
   gh secret set R2_ACCESS_KEY_ID -R ken-jo/ave --env release
   gh secret set R2_SECRET_ACCESS_KEY -R ken-jo/ave --env release
   gh secret set R2_BUCKET -R ken-jo/ave --env release
   ```

   Delete any repository-level copies after setting the environment values;
   every job reading these secrets must use `environment: release`.
   The job fails, naming the missing secret, when any of the four is unset.
   To check the secrets before a tag build, manually dispatch the **R2 Probe**
   workflow (`.github/workflows/r2-probe.yml`) from `main` only. It
   uploads one small object under `_ci-probe/`, confirms it is listed, deletes
   it, and confirms it is gone; nothing outside `_ci-probe/` is touched.
   The contract bundle probe also requires a `main` dispatch of
   `build-installers.yml` with `contract_probe=true`; it builds, signs, uploads,
   checks signature reuse and deletes its `_ci-probe/contract/<run>/` bundle
   without building installers. Both probes skip other refs, including tags;
   tag pushes retain the protected annotated-tag validation for publication.
5. Do not add a Cache Rule that caches everything on this host: the feed and
   the `latest/` aliases rely on their `no-cache` origin header.

Public-access check after setup (any small test object you upload by hand):

```bash
curl -sSI https://downloads.agent-connector.ai/<test-object> | head -n 1   # expect HTTP/2 200
```

## Verify a Release

After the `publish-r2` job of a tag build succeeds:

```bash
base=https://downloads.agent-connector.ai
for feed in latest.yml latest-mac.yml latest-linux.yml; do
  curl -sSI "$base/releases/$feed" | grep -iE '^(HTTP|cache-control|content-type)'
  curl -sS "$base/releases/$feed" | grep -E '^(version|path):'
done
curl -sSI "$base/latest/mac-arm64.dmg" | grep -iE '^(HTTP|content-disposition|cache-control)'
```

Each feed must answer `200` with `cache-control: public, no-cache, must-revalidate`
and name the tag's version; the alias must name the versioned file in
`content-disposition`. The job log also prints the full plan from its
`Plan the R2 upload` step.

## Rollback

Re-upload the previous version's three feed files (from that tag's workflow
artifacts or its GitHub Release draft) to `releases/` with
`Cache-Control: public, no-cache, must-revalidate`. The previous versioned
installers are still in the bucket, so the restored feed resolves immediately.
Point the `latest/` aliases back the same way if the website must stop
offering the bad build.

## Re-running a Tag

electron-builder output is not byte-reproducible. If the `installers` matrix
is re-run for a tag whose `publish-r2` already uploaded, `publish-r2` stops
with "already exists with different bytes" instead of replacing a released
version (its cached copies and its feed's sha512 would disagree). Either
delete that version's `releases/<Product>-<version>-*` objects in the bucket
and re-run, or release a new patch tag. Re-running only `publish-r2` with the
same artifacts is safe: identical objects are kept.
