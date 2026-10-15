# Site design

The product site at the canonical host. These are the rules a change must keep.
Each one can be checked on the built pages; the build checks the navigation
rules itself (`scripts/lib/web-export.mjs`, run by `bun run build`).

The site was rewritten from scratch on 2026-10-15. Its density and its section
patterns follow a study of reference product sites; no text, picture or
typeface was taken from them.

## Argument

Ave is a desktop workbench where agents work on your computer with the model
you choose, and anything that changes something asks first. Every page proves
that with the real app: each claim sits next to a capture of the screen that
shows it.

| Page | What it covers |
| --- | --- |
| `/` | Hero loop, the workbench, what agents work with, three ways to connect a model, safety, extension kinds, the latest release, download. |
| `/browser/`, `/terminal/`, `/models/`, `/plugins/`, `/security/` | One feature each: hero shot, a split, a bento of crops, facts or a second split, 5–8 questions, next steps. |
| `/download/` | One card per system with the first-launch steps, then connecting a model, leading on to the start guide. |
| `/docs/**` | The guide (`lib/docs.ts`), one template. |
| `/changelog/` | `CHANGELOG.md` at build time, Ave's releases (v0.14.0 and later) each with an anchor. |
| `404.html`, `en/404.html` | Not-found page with links out. |

## Navigation

1. **Flat.** The header links the five feature pages, Docs and Changelog, plus
   the Download button and the language switch. The footer is the full index:
   features; download, the three systems and the changelog; the guide.
2. **One label, one destination.** On a page, the same link text always leads
   to the same place. Labels come from `lib/nav.ts` only.
3. **No self-links and no in-page jumps.** A link to the page being shown is
   rendered as text with `aria-current="page"`; the logo on a home page and
   the skip link are the exceptions.
4. **No dead links.** Every internal link, anchor and media source resolves in
   the export.
5. **Download is close.** Every page reaches `/download/` in at most two
   clicks; in practice the header button makes it one.
6. **Chains.** Feature pages hand on to the guide, the next feature and
   Download. The guide's previous/next runs from Download before the first
   page to the changelog after the last. `/download/` leads to the start guide.
7. **Language switch keeps the place.** It links the same path in the other
   language, and carries the current `#hash` with it.
8. **Pre-release.** `RELEASE_PUBLISHED` in `lib/downloads.ts` is the one
   switch. While it is false the system cards show "release in preparation"
   with the changelog link instead of installer links, which would answer 404.

## Layout

9. **One frame.** Content sits in `.wrap`: at most 1200 px with a gutter of
   `max(16px, 4vw)`. No horizontal page scroll at 360 px; every multi-column
   row is one column on a phone.
10. **Bands.** Sections alternate between the page ground and `--band`, and
    have the same vertical padding (`--sec`).
11. **Patterns.** A section is one of: a *split* (a full-app shot beside a
    dense list of 3–5 points, each a bold lead and the rest of the sentence); a
    *bento* (2–5 cards on a six-column grid, each a real crop with a title and
    a caption of about twenty words); *choices* (three equal cards); *facts*
    (three short ruled columns); *kinds* (an icon grid); *questions* (native
    `<details>`); *next steps* (three linked cards).
12. **Density.** Home about 900 English words and 12 media; feature pages
    600–700 English words and 6–7 media. Korean pages carry the same content.

## Type and colour

13. Geist for Latin, Noto Sans KR for Hangul through the stack, Geist Mono for
    code and eyebrows, all self-hosted by `next/font`.
14. Colours are tokens on `:root`, redefined under
    `prefers-color-scheme: dark`. The accent (`--accent`, lime) marks list
    bullets and selection; `--accent-ink` carries "more" links and eyebrows.

## Media

15. **Only real captures.** Every picture is Ave itself, captured for this
    site: no illustrations, stock images, third-party logos or mock-ups. The
    key of each picture is in `lib/media.json`; copy can only name a key that
    exists (`lib/content.ts`).
16. **How they were made.** The packaged app ran with an isolated `HOME`,
    `AVE_HOME` and Chromium profile under `/tmp`, `NODE_ENV=production`,
    `--lang=en-US` and a mock keychain. The model was a local scripted
    OpenAI-compatible stub with a fake key, answering a fixed scenario per
    prompt, over a neutral sample project (`trail-notes`: a small Node CLI and
    a static preview site). Each scene was driven and captured over the Chrome
    DevTools Protocol, once in the light theme and once with the Tokyo Night
    theme package installed for dark. The main app shots are 2880×1800 (2×);
    shots with web pages inside are 1440×900, because guest pages mis-size
    under emulated device scale.
17. **Formats.** Each capture ships as AVIF (quality 62) and WebP (quality 80)
    at full size, plus a half-width 256-colour PNG fallback, for light and
    dark: `public/media/<key>-<light|dark>.<avif|webp|png>`. The hero loop is
    H.264 MP4 and VP9 WebM, each under 2 MB, 1440×900.
18. **No layout shift.** Every `<img>` and `<video>` has width and height. The
    first picture of a page is eager with high fetch priority and has preload
    links per colour scheme. Everything else loads lazily.
19. **Motion.** The home hero loop plays muted over its still; under
    `prefers-reduced-motion: reduce` it is hidden and the still shows. There is
    no other animation beyond hover colour and a 0.98 press.

## Copy

20. Facts come from the app's guide, its UI strings and code, and what the
    captures show. No testimonials, customer logos, rankings, or numbers
    without a source in the app; no placeholder text; no company hosts,
    addresses or paths.
21. Names match the app's labels (Settings → Model, Allow once, Work mode).

## Libraries

Next.js (static export), React, Tailwind CSS 4 (for the build; the rules are
hand-written in `app/globals.css`) and `next/font`. Nothing else ships.
Notices: `THIRD_PARTY_NOTICES.md`.
