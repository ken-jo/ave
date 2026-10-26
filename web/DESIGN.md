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
| `/` | Hero loop, the feature tour (one step per feature page), the workbench, what agents work with, three ways to connect a model, safety, extension kinds, the latest release, download. |
| `/browser/`, `/terminal/`, `/models/`, `/plugins/`, `/security/` | One feature each: hero shot, a split, a bento of crops, facts or a second split, 5–8 questions, next steps. Models adds every provider the app knows (read from `src/shared/llm-vendor-defaults.ts` at build time); Plugins adds the official catalog by kind (`lib/marketplace.json`). |
| `/download/` | One card per system with the first-launch steps, then connecting a model, leading on to the start guide. |
| `/docs/**` | The guide (`lib/docs.ts`), one template. |
| `/changelog/` | `CHANGELOG.md` at build time, Ave's releases (v0.14.0 and later) each with an anchor; the `## Unreleased` section at the top is checked but not shown. The English page shows each release as a headline and bullet points from `lib/changelog-en.ts`, which the build holds to the same releases and item counts. |
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
12. **Density.** Home about 1,700 English words and 17 media (the tour adds
    each feature page's hero lead, first three points and two shots, and the
    package stack adds seven catalog packages); feature pages 600–900
    English words and 6–7 media. Korean pages carry the same content.

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
16. **How they were made.** The real app runs with an isolated neutral
    temporary `HOME`, `AVE_HOME` and browser profile, production mode,
    English locale and a mock keychain. A local scripted model with a fake
    key answers a fixed scenario over `trail-notes`, a sample Node CLI
    and local preview site. This demonstrates real tool execution and UI
    with a scripted conversation. Each scene is captured through the
    DevTools Protocol in the light theme and the Tokyo Night theme package.
    `browser-live`, `browser-live-nav` and `terminal-live` were captured
    from app main 135a26642 on 2026-10-21 at 2880×1800 (2×).
    `browser-side`, `browser-done`, `terminal-side`, `terminal-main`,
    `terminal-ask` and `web-main` use the same build and retain their existing
    1440×900 (1×) dimensions by reducing the 2× source before encoding.
    The app uses `--force-device-scale-factor=2`, no emulated scale,
    and a 1440×900 content area so embedded pages size correctly.
    The main browser and terminal panes each have their own docked chat.
    Browser chat uses real `browser_snapshot` and `browser_navigate`
    results. Terminal chat reads the failed run with `terminal_read`
    using `limit` so the result includes output, requests `terminal_run`
    approval, then runs that command in the same visible shell. The rerun
    still shows five passing tests and one failure; a real source-file read
    grounds the diagnosis. The approval picture precedes execution, and
    the final picture follows the command block and source result.
    The scripted model checks each outcome against the preceding real tool
    results and aborts on a failed tool or unsupported statement. The
    screenshot driver refuses captures after an abort. No personal
    profiles or names appear, and visible paths use the neutral capture home.
17. **Formats.** Each capture ships as AVIF (quality 62) and WebP (quality 80)
    at full size, plus a half-width 256-colour PNG fallback, for light and
    dark: `public/media/<key>-<light|dark>.<avif|webp|png>`. The hero loop is
    H.264 MP4 and VP9 WebM, each under 2 MB, 1440×900.
18. **No layout shift.** Every `<img>` and `<video>` has width and height. The
    first picture of a page is eager with high fetch priority and has preload
    links per colour scheme. Everything else loads lazily.
19. **Motion.** Only the home page moves, and it never moves the page: no
    scroll hijacking, snapping, smooth-scroll takeover or `scrollTo`. The
    server renders every element visible and final; script only enhances.
    - The hero loop plays muted over its still; under
      `prefers-reduced-motion: reduce` it is hidden and the still shows.
    - **Feature tour** (`components/tour.tsx`). One step per feature page,
      taken from that page's hero. On screens 1024 px and wider, with script
      and motion allowed (one media query, `PINNED`, shared by the CSS and the
      script), each step is a viewport-tall block and a sticky stage beside
      them holds a framed capture. One scroll progress for the tour drives the
      frame's position, scale and rotation through a pose per step, the
      cross-fade between captures, and the current step (`aria-current="step"`
      on the step, marked by colour, not opacity, and highlighted in the
      stage's index). A step changes exactly at the middle of its cross-fade.
      The frame follows the scroll position 1:1 and moves continuously
      between step centres, so scrolling back retraces every frame; only the
      inset capture drifts on a stiff spring. Everywhere else (narrow screens, reduced
      motion, no script) the tour is a plain stack of steps, each with its
      capture untransformed, and is exactly as long as its content.
    - **Package stack** (`components/pkg-stack.tsx`). Under the extension
      kinds, one real package per kind from the official catalog, with the
      install review's fields. With PINNED it is an overlapping stack: scroll
      walks through it (and back), a pointed-at or focused kind brings its
      card forward and is highlighted, and pointing at the stack fans it out.
      Otherwise a plain grid of cards.
    - **Entrances.** Home sections that start below the fold enter once, their
      parts one after the other (`components/motion.tsx`). A section on screen
      at load, or scrolled past, is never hidden; with reduced motion nothing
      is.
    - Beyond that: hover colour and a 0.98 press.

Print shows every element in its static form.

## Copy

20. Facts come from the app's guide, its UI strings and code, and what the
    captures show. Packages come only from the catalog snapshot
    (`scripts/marketplace-snapshot.mjs` writes `lib/marketplace.json` from a
    recorded commit of ken-jo/agent-marketplace), and `lib/marketplace.ts`
    fails the build for a package name the snapshot does not have. No testimonials, customer logos, rankings, or numbers
    without a source in the app; no placeholder text; no company hosts,
    addresses or paths.
21. Names match the app's labels (Settings → Model, Allow once, Split pane).

## Libraries

Next.js (static export), React, Tailwind CSS 4 (for the build; the rules are
hand-written in `app/globals.css`), `next/font`, and Motion (`motion/react`,
home page only, through `LazyMotion` with the `domAnimation` features loaded
after hydration). Nothing else ships; feature pages load no motion code.
Notices: `THIRD_PARTY_NOTICES.md`.
