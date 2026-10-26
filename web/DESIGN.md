# Site design

The product site at the canonical host. These are the rules a change must keep.
Each one can be checked on the built pages; the build checks the navigation
rules itself (`scripts/lib/web-export.mjs`, run by `bun run build`).

The system is called **Greeting**. It replaced the 2026-10-15 design on
2026-10-27. Its craft (inset cards, light display type, the product performing
in place of page animation) follows a measured study of reference product
sites. No text, picture, typeface or composition was taken from them.

## Argument

Ave means hello: *avē* is Latin for hello. Ave is an AWE, an agentic work
environment, which is the agents' counterpart of an IDE. It is a desktop app
where agents read and edit your files, run a terminal and drive a browser,
with the model you choose. Anything that changes something asks first.

The home page says this once and then shows it. A built Ave workspace performs
the same trail-notes session the captures show, from "hello" to the tests
passing. Details live on the feature pages and in the guide. The home page
only points at them.

| Page | What it covers |
| --- | --- |
| `/` | The hello card (brand line, AWE, CTAs, the built workspace), the AWE statement, the workbench capture, six tiles (web, terminal, files, models, approvals, plugins) each leading to its page, a dark closing card. |
| `/browser/`, `/terminal/`, `/models/`, `/plugins/`, `/security/` | One feature each, with its content unchanged: hero shot, a split, a bento of crops, facts or a second split, 5–8 questions, next steps. Models adds every provider the app knows (read from `src/shared/llm-vendor-defaults.ts` at build time). Plugins adds the official catalog by kind (`lib/marketplace.json`). |
| `/download/` | A dawn card holding one card per system: what it needs, the installer, the first-launch steps. Then connecting a model, leading on to the start guide. |
| `/docs/**` | The guide (`lib/docs.ts`), one template. |
| `/changelog/` | `CHANGELOG.md` at build time: Ave's releases (v0.14.0 and later), each with an anchor. The `## Unreleased` section at the top is checked but not shown. The English page shows each release as a headline and bullet points from `lib/changelog-en.ts`, which the build holds to the same releases and item counts. |
| `404.html`, `en/404.html` | Not-found page with links out. |

## Navigation

1. **Flat.** The header links the five feature pages, Docs and Changelog,
   plus the Download pill and the language switch. The footer is the full
   index:
   - the features;
   - download, the three systems and the changelog;
   - the guide.
2. **One label, one destination.** On a page, the same link text always leads
   to the same place. Labels come from `lib/nav.ts` only.
3. **No self-links and no in-page jumps.** A link to the page being shown is
   rendered as text with `aria-current="page"`. The exceptions are the logo on
   a home page and the skip link.
4. **No dead links.** Every internal link, anchor and media source resolves in
   the export.
5. **Download is close.** Every page reaches `/download/` in at most two
   clicks. In practice the header pill makes it one.
6. **Chains.**
   - Feature pages hand on to the guide, the next feature and Download.
   - The guide's previous/next runs from Download before the first page to the
     changelog after the last.
   - `/download/` leads to the start guide.
   - Every home tile leads to its feature page; the Files tile leads to the
     workbench guide.
7. **Language switch keeps the place.** It links the same path in the other
   language and carries the current `#hash` with it.
8. **Release switch.** `RELEASE_PUBLISHED` in `lib/downloads.ts` is the one
   switch. While it is true, each system card links its installer's stable
   `latest/` alias on the release channel. While it is false, the cards show
   "release in preparation" and the changelog link instead.

## Tokens

All colours are tokens on `:root` in `app/globals.css`.

| Token | Use |
| --- | --- |
| `--bg` `oklch(97.6% .004 85)` | Page ground (warm paper) |
| `--band` | The second ground |
| `--raised` | Cards |
| `--ink` | Text |
| `--ink-2` | Secondary text |
| `--muted` | Captions, footer |
| `--line` | Hairlines |
| `--line-strong` | Hairlines |
| `--dawn-1/2/3` | Only the hello and download cards' gradient (an ember glow in dark) |
| `--tile-a/b/c 1/2` | The tile and stage backs |
| `--title-dim` | The dimmed second line of the hero title (gradient-clipped text) |
| `--accent` | Bullets and selection |
| `--accent-ink` `oklch(45% .11 50)` | "More" links and eyebrows, readable on every ground |
| `--glow` | The closing card's warm glow |
| `--night` | The closing card |
| `--night-ink` | The closing card |
| `--focus` | The focus ring |

Radii:
- `--r-lg` 32 px: the inset hero, download and closing cards, 24 px on a phone.
- `--r` 18 px: cards.
- 22 px: tiles.
- 14 px: framed captures.
- 999 px: pills.

The built workspace has its own `--a-*` tokens. They are copied from the
app's light theme and from the Tokyo Night package, as the captures show
them.

**Colour scheme.** Two themes follow `prefers-color-scheme`. The light
tokens sit on `:root`; the dark ones redefine them under the media query
(`color-scheme: light dark`, a `theme-color` per scheme).

The dark theme is a **warm night**, the same paper-and-ink logic after dusk
rather than an inversion:
- the ground is warm near-black (`oklch(15.5% .008 60)`);
- the ink is warm off-white;
- the dawn gradient becomes an ember glow at the top of the cards;
- tiles keep their hue at low lightness;
- the closing card is a lifted warm night with the same glow.

Captures switch to their dark (Tokyo Night) versions. The built workspace's
`--a-*` tokens take the Tokyo Night colours the dark captures show. The
previewed sample site stays light in both themes, as it does in the dark
captures.

Pastel gradients appear only behind captures and fragments.

**Contrast.** Every text pair meets WCAG AA (4.5:1) in both themes. Pairs
checked:
- ink, ink-2, muted and accent-ink on the ground, band, cards, dawn and the
  six tile backs;
- night text on the closing card;
- the workspace's text, muted, blue and status pairs.

The one exception is the hero title's dimmed second line on the light dawn,
at 4.2:1. It is display text of at least 44 px, so AA's 3:1 for large text
applies.

## Layout

9. **Frame.** Content sits in `.wrap`: at most 1200 px wide, with a gutter of
   `max(16px, 4vw)`.
   - The hello, download and closing cards are inset 16 px from the viewport
     (8 px on a phone).
   - There is no horizontal page scroll at 375 px.
   - Every multi-column row is one column on a phone.
   - Centred heads switch to left-aligned at 640 px and narrower.
10. **Pacing.** Sections are separated by air, not rules: `--sec` is
    72–140 px, and the statement section is 110–200 px.
11. **Patterns.**
    - *Hello card*: a centred head over the product, which rises from the
      card's bottom edge and is cropped by it.
    - *Statement*: one sentence.
    - *Stage*: a capture on a soft gradient field.
    - *Tiles*: a gradient back, a title, two sentences, a "more" link, and a
      cropped capture or fragment.
    - *Closing card*.
    - The interior pages keep their patterns: split, bento, choices, facts,
      questions, next steps.

## Type

12. **Fonts.** Pretendard Variable (dynamic subset) covers Latin and Hangul;
    JetBrains Mono is for code. Both are vendored in `public/fonts` with their
    OFL licences and linked from `components/shell.tsx`. No font CDN.
13. **Display type** is light and tight:
    - Hero: weight 430, -0.058em, line-height 1.0, and a gradient-dimmed
      second line.
    - `.h1`: weight 430, -0.05em.
    - `.h2`: weight 450, -0.04em.
14. **Korean and body text.** Korean sets the display type looser (-0.04 to
    -0.045em, line-height 1.12–1.24) and breaks with `word-break: keep-all`.
    Body text is 16/1.6 and leads are 17–19 px, at most 40em wide.

## Media

15. **Only real captures, apart from listed built fragments.**
    - Every picture is Ave itself, captured for this site: no illustrations,
      stock images or third-party logos.
    - The key of each picture is in `lib/media.json`. Copy can only name a
      key that exists (`lib/content.ts`).
    - The built fragments under "Built fragments" below are the only
      exception.
16. **How they were made.** The real app runs with:
    - an isolated, neutral temporary `HOME`, `AVE_HOME` and browser profile;
    - production mode;
    - the English locale;
    - a mock keychain.

    A local scripted model with a fake key answers a fixed scenario over
    `trail-notes`, a sample Node CLI and local preview site. This demonstrates
    real tool execution and UI with a scripted conversation. Each scene is
    captured through the DevTools Protocol in the light theme and the Tokyo
    Night theme package.

    Capture sizes:
    - `browser-live`, `browser-live-nav` and `terminal-live` were captured from
      app main 135a26642 on 2026-10-21 at 2880×1800 (2×).
    - `browser-side`, `browser-done`, `terminal-side`, `terminal-main`,
      `terminal-ask` and `web-main` use the same build. They keep their
      existing 1440×900 (1×) dimensions because the 2× source is reduced
      before encoding.
    - The app uses `--force-device-scale-factor=2`, no emulated scale, and a
      1440×900 content area, so embedded pages size correctly.

    The main browser and terminal panes each have their own docked chat:
    - Browser chat uses real `browser_snapshot` and `browser_navigate`
      results.
    - Terminal chat reads the failed run with `terminal_read`, using `limit`
      so the result includes output. It requests `terminal_run` approval,
      then runs that command in the same visible shell.
    - The rerun still shows five passing tests and one failure, and a real
      source-file read grounds the diagnosis.
    - The approval picture precedes execution. The final picture follows the
      command block and the source result.

    Safeguards:
    - The scripted model checks each outcome against the preceding real tool
      results and aborts on a failed tool or an unsupported statement.
    - The screenshot driver refuses captures after an abort.
    - No personal profiles or names appear, and visible paths use the neutral
      capture home.
17. **Formats.** Each capture ships, for light and dark, as:
    - AVIF (quality 62) at full size;
    - WebP (quality 80) at full size;
    - a half-width 256-colour PNG fallback.

    The path is `public/media/<key>-<light|dark>.<avif|webp|png>`. The
    browser picks the theme with the colour-scheme media query. The earlier
    hero loop (H.264 MP4 and VP9 WebM, 1440×900) stays in `public/media` but
    is not shown.
18. **No layout shift.**
    - Every `<img>` and `<video>` has width and height.
    - A feature page's first picture is eager, with high fetch priority and a
      preload link per colour scheme.
    - Everything else loads lazily.
    - The home hero has no picture to wait for: its workspace is markup.

### Built fragments

Each fragment uses the app's own English UI strings (`src/i18n/messages`) and
the captures' trail-notes scenario. Each is one image to assistive technology
(`role="img"` with a description). An isolated capture replaces a fragment as
soon as one exists.

| Fragment | Where | Replaced by |
| --- | --- | --- |
| The hello workspace (sidebar, conversation, the Files, Preview and Terminal tabs of the work panel) | Home hero, `components/hello.tsx` | Not replaced: it is the performed demo. A Korean-UI capture set would let the Korean page show Korean labels. |
| The Files tab with `src/export.js` | Home "It edits your files" tile, `components/home.tsx` | A capture of the work panel's Files tab |

## Motion

19. Motion lives in the product, not the page:
    - no scroll hijacking, snapping, smooth-scroll takeover or `scrollTo`;
    - no motion library.

    The server renders every element visible and finished. Script only
    enhances, and only when `prefers-reduced-motion` allows it. When it runs,
    it marks the element `data-live` and replays it; every hidden or moving
    state in CSS is scoped to `[data-live]`.
    - **The hello workspace** (`HelloStage`) plays while at least a quarter of
      it is on screen, then loops:
      1. `hello` is typed and Ave answers.
      2. The task is typed and the Work toggle opens the work panel.
      3. Each tool call (`browser_snapshot`, Edit file, Terminal command)
         switches the panel's tab and acts in it. Preview rows are read, the
         json line is wiped in, and the test lines print.
      4. The group collapses to "Work complete" and Ave's report.

      Entrances use 460 ms `cubic-bezier(.32,.72,0,1)` and the panel uses
      expo-out 0.9 s.
    - **The statement** (`Statement`): its words sharpen in order as the
      sentence rises through the viewport, from opacity 0.16, 6 px blur and a
      0.12em offset. Opacity eases over 0.55 s, blur over 0.7 s, and the
      offset over 0.95 s expo-out. Scrolling back reverses it.
    - Beyond that: a 6 px tile lift on hover, hover colour, and a 0.98 press.

    Without script, and with reduced motion, the workspace shows the finished
    session and the statement is plain text. On narrow screens the finished
    workspace shows the conversation; while it plays, the work panel takes
    the column.

## Copy

20. Facts come from the app's guide, its UI strings and code, and what the
    captures show.
    - Packages come only from the catalog snapshot.
      `scripts/marketplace-snapshot.mjs` writes `lib/marketplace.json` from a
      recorded commit of ken-jo/agent-marketplace, and `pkg()` in
      `lib/marketplace.ts` fails the build for a package name the snapshot
      does not have.
    - No invented facts: no testimonials, customer logos, rankings, or numbers
      without a source in the app.
    - No placeholder text.
    - No company hosts, addresses or paths.
    - The brand line "Ave means hello" (ko "Ave는 라틴어로 hello.") and AWE
      are positioning, not product claims.
21. Names match the app's labels (Settings → Model, Allow once, Split pane,
    Work complete, Confirm writes).

## Libraries

- Next.js (static export).
- React.
- Tailwind CSS 4, for the build only; the rules are hand-written in
  `app/globals.css`.

The home page's motion is a small client component with no dependencies.
Feature pages ship no motion code. Notices are in `THIRD_PARTY_NOTICES.md`.
