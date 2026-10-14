# Site design

The product site at the canonical host. These are the rules a change must keep.
Each one is written so it can be checked on the built page. The layout rules
were derived from a study of a reference product site (appendix A) and
translated into Ave's own material: no text, image, illustration or typeface
was taken from it.

## Argument

"Ave" is Latin for hello. The page greets, then shows Ave as a **harness**: the
place where you, your agents, the models you choose and your own computer meet.
Each section is one claim with its proof. Permissions are not a section; one
factual line in the intro says the host checks writes, commands and network
requests first and links to the guide.

| Section | Claim | Proof on the page |
| --- | --- | --- |
| Hero | Hello, I'm Ave: the desktop harness where the four meet. | The harness scene: your message, Ave, the providers, your computer's files, shell, plugins and MCP servers. |
| Intro | Ave is a desktop app on three systems; you stay in control. | One paragraph, its first sentence in ink, and the one line about the permission check. |
| Workbench | Four conversations run side by side, driven from the keyboard. | A four-tile window beside the composer keys. |
| Models | You choose the model, key, server or subscription. | The providers on a ring around Ave. |
| Plugins | Plugins come from git and are checked by hash. | The marketplace scene, the deep links, the four source kinds. |
| Alongside | Indexing, meetings, routines and sub-agents run beside you. | Each of them flowing into the chat list. |
| Download | It runs on three systems; unsigned builds take one step more. | The three installers, and the guide. |

## Principles

### Layout

1. **One frame.** Content sits in a frame of at most 1248 px with a side margin
   of `clamp(16px, 6.67vw, 96px)`. From 1024 px the frame shows 1 px vertical
   rules on both edges, except around the hero and the closing call-to-action
   panels, which stand free; sections are separated by 1 px horizontal rules.
   Rules are `--line` (ink at 8 %), never darker.
2. **One idea per section, centred on a 45 rem measure.** Headings and lead
   text sit in a 45 rem (720 px) column. Wider material (scenes, windows,
   tables) may use the full frame; running text never exceeds 64 ch.
3. **Pacing by bands, not colours.** Sections alternate between the white
   ground and the `--band` ground (#fafaf9). Dark is used once on the home page
   (the plugin code card). Tinted panels exist only to hold a picture or an
   action: the hero, the closing call to action, the stages that hold scenes
   and fragments, and the download system cards. No section field is tinted.
4. **Section rhythm.** Every section has the same vertical padding,
   `clamp(4rem, 2.5rem + 5vw, 7.5rem)`. Between blocks inside a section the
   steps are 0.75 / 1.25 / 2 / 3.5 rem; smaller values only inside a
   component (a button, a chip, a row).
5. **Picture, then points.** A section shows one picture (a scene or a
   fragment) and at most one row of 2–4 captions, or the picture beside a
   single stack of points. A caption is a bold ink title followed by a muted
   body in the same paragraph. No icons, no numbering.
6. **360 px works.** No horizontal page scroll at 360 px; code scrolls inside
   its own box; every multi-column row collapses to one column below 760 px;
   scenes switch to a narrow layout or a plain fallback below 1024 px.

### Type

7. **Families.** Geist (variable, OFL) for Latin, Noto Sans KR (variable, OFL)
   for Hangul through the font stack, Geist Mono (OFL) for code. All
   self-hosted through `next/font`, exposed to Tailwind as `font-sans` and
   `font-mono`.
8. **Scale, five steps.** Display `clamp(2.5rem, 1.9rem + 2.4vw, 3.5rem)`,
   section head `clamp(2rem, 1.6rem + 1.6vw, 2.75rem)`, lead
   `clamp(1.0625rem, 1rem + 0.35vw, 1.25rem)`, body 1 rem, small 0.875 rem.
   Docs add one article head (1.5 rem). Chrome (buttons, chips, table
   headers, scene labels) may use 0.6875–1.0625 rem; running text uses only the
   five steps.
9. **Weights.** 450 for display and heads, 500 for titles inside text and for
   buttons, 400 for everything else. No 700.
10. **Tracking and leading.** Display −0.02 em / 1.08; heads −0.015 em / 1.12;
    body 0 / 1.6. Hangul (`:lang(ko)`) never tighter than −0.01 em and never
    under 1.25 line height, with `word-break: keep-all`.
11. **Headlines are one sentence in at most two lines** at 360, 768 and
    1440 px, set in ink. Supporting text below a head is muted, never ink.
12. **Lead with the claim.** A paragraph that carries a claim starts with its
    claim sentence in ink and continues in muted text.

### Colour

13. **Neutral ground, one ink.** White ground, `--ink` #0b0d0c, `--muted`
    #5f6461 (6.0:1 on white, 5.8:1 on the band). The same values are Tailwind
    theme colours (`ink`, `muted`, `band`, `line`, `lime`, `accent-ink`).
14. **Lime is a mark, not text.** `--lime` #c4f04a appears only as the logo
    stroke, the glow of the tinted panels, the halo around the Ave hub, the
    beam pulses (lime to teal), text selection and the "responding" chip.
    Text that needs the accent uses `--accent-ink` #3a6510 (6.9:1 on white).
15. **AA everywhere.** Every text pair reaches 4.5:1, including text on the
    tinted panels (measured by pixel, not assumed).

### Shape and depth

16. **Two radii and a pill.** 10 px for controls, small cards and code; 24 px
    for panels and the code card; 16 px for scene nodes; a full pill for the
    primary call to action and chips.
17. **One shadow.** Only an interface fragment's window casts a shadow
    (`0 1px 2px` plus a long soft drop at 18 % ink). Scene nodes and cards use
    a 1 px inset ring. The hub's halo is a ring, not a shadow.

### Pictures

18. **Show the app and its parts by name.** Pictures are either Ave's own
    interface built in HTML at true size (`[data-ui]` fragments) or a harness
    scene whose nodes carry only names the app uses (providers, files, shell,
    plugins, MCP servers, marketplace.json, SHA-256). No screenshots, stock
    imagery, logos of third parties, or illustration of things the app does
    not do.
19. **Scenes are composed frames first.** A scene's nodes are HTML at fixed
    coordinates and its beams are SVG paths rendered on the server, so the
    picture is complete without script and under reduced motion; motion only
    adds the pulse.

### Motion

20. **Motion explains flow.** Motion does four jobs: (a) a beam pulse shows
    which way work moves through the harness, one beam after another; (b) the
    model ring turns a little with scroll; (c) blocks enter once as they reach
    the viewport; (d) hover and press show state. Nothing loops faster than
    one pulse per 1.5 s, nothing bounces, no parallax, no scroll hijacking.
21. **Numbers.** Beam pulse: 1.5 s, `cubic-bezier(0.22, 1, 0.36, 1)`, next beam
    1.1 s later, a pause of 1.5 s before the sequence repeats; scenes below the
    fold start when they enter view. Orbit: ±30° over the section's scroll
    range. Entrances: opacity and a 12 px rise, 520 ms, the same ease, at most
    four staggered children 60 ms apart. Colour transitions 150 ms. Press:
    scale 0.98.
22. **Off when asked, visible without script.** Under
    `prefers-reduced-motion: reduce` nothing travels, turns, fades or scales:
    pulses rest mid-beam, the ring stands still, press scaling and arrow
    nudges are off (`motion-safe:` utilities). Without script every block and
    every scene is visible.

### Interaction

23. **Header.** Sticky, 64 px. On the home page it sits over the hero panel,
    transparent, and turns solid white with a hairline within the first 96 px
    of scroll through a CSS scroll timeline (no script); browsers without
    scroll timelines, and reduced-motion settings, get the solid bar above the
    panel. Wordmark left, three
    section links centred, language and one ink "Download" button right.
    Under 760 px the links and the language switch move into a `<details>`
    menu that opens without script. The footer is light: link columns,
    a hairline, then the notice and the language link.
24. **Links in text** are underlined at 1 px with a 0.2 em offset; hover
    changes only the underline colour. Section labels above heads are links to
    the matching guide page, in `--accent-ink` with a chevron.
25. **Focus is always visible:** 2 px `--focus` ring at 3 px offset on every
    interactive element, including the menu summary and buttons.

### Copy

26. **A warm greeting, then facts from the source.** The hero greets ("Hello,
    I'm Ave"); everything after it is taken from the app's code and UI strings
    (`web/lib/home.ts`, `web/lib/docs.ts`). A wording change never adds a
    capability.
27. **Control is stated, not sold.** Permissions get one factual line and a
    link to the guide; no section, table or mode picker on the home page, and
    no "Permissions" item in the header.
28. **Headings name the thing;** no exclamation marks, no rhetorical
    questions, no superlatives that the app cannot prove.

### Docs and download

29. **Download:** centred title, three system cards each holding a small
    install fragment (the installer's file name and its first-launch steps),
    one button, then one setup section per system at `#mac`, `#windows`,
    `#linux`, steps numbered, commands with a copy button.
30. **Docs:** an index of caption cards; an article page with a 14 px sticky
    page list on the left and the article in the 45 rem measure.

### Budget

31. **JavaScript per route** (first load, as `next build` reports it): home at
    most 170 kB, every other route at most 120 kB. Motion loads only on the
    home page, through `LazyMotion` with the `domAnimation` feature set.

## Libraries

Adopted (exact versions, all at least two weeks old when added):

| Library | Version | Licence | Why |
| --- | --- | --- | --- |
| Tailwind CSS + `@tailwindcss/postcss` | 4.3.3 | MIT | Theme tokens and utilities for the scenes and new components; the hand-written rules live in `@layer components` so utilities override them. `web/postcss.config.mjs` also keeps Next from loading the desktop app's root PostCSS setup. |
| shadcn/ui Button pattern (copied) with `class-variance-authority` 0.7.1, `@radix-ui/react-slot` 1.3.3, `clsx` 2.1.1, `tailwind-merge` 3.7.0 | — | MIT, Apache-2.0 (cva) | One button with variants; `asChild` renders a Next `Link`. |
| Motion (`motion/react`) | 13.4.6 | MIT | Beam pulses, in-view start, reduced-motion detection, scroll-linked orbit. Loaded through `LazyMotion` (principle 31). |
| Magic UI AnimatedBeam and OrbitingCircles (adapted) | — | MIT | The pulse-along-a-path and orbit techniques, rewritten to draw from fixed coordinates so they render on the server (principle 19). |
| Geist, Geist Mono, Noto Sans KR via `next/font/google` | — | OFL 1.1 | Principle 7. |

Notices: `web/THIRD_PARTY_NOTICES.md`.

Considered and not adopted:

| Library | Why not |
| --- | --- |
| Lenis (smooth scroll) | Replaces native scrolling; conflicts with principle 20 and with reduced-motion and keyboard scrolling. |
| three.js / react-three-fiber | A 3D scene does not earn its weight here; the harness reads clearly in 2D at a fraction of the bytes. |
| Radix / Base UI primitives beyond Slot | The site has no dialogs, menus or popovers that need them; the mobile menu is a `<details>` so it works without script. |
| Rive | Needs authored `.riv` files and a WASM runtime; the scenes are HTML and SVG. |
| Analytics (PostHog, Google Tag Manager) | The site does not track visitors. |
| The reference's display face | Proprietary; Geist at 450 stands in. |

## Appendix A — evidence from the reference

Captured 2026-10-14 with headless Chromium at 1440 and 390 px.

| Source | What it shows |
| --- | --- |
| `https://aside.com/` (HTML, computed styles) | h1 48/52 px, weight 400, −0.48 px tracking; h2 44/48 px, weight 450; h3 30/40 px; lead 20/28 px muted (`neutral-500`); body 16/24 px; nav links 14 px weight 500. Frame 1248 px between vertical rules at x = 96 and 1344; text column 718 px; alternating white and #fafafa sections divided by `border-black/6`. |
| same page, `:root` custom properties | `--radius: .625rem` (10 px); `--brand: var(--color-sky-500)`; `--border: #e5e5e5`; white `--background`. |
| `/_next/static/immutable/chunks/17h1bvs2_--1b.css` | `@font-face{font-family:displayFont;src:url(../media/AsideDisplay_Variable-…woff2)…font-weight:100 900}` (proprietary), Geist and Geist Mono faces. |
| `/_next/static/immutable/chunks/1jxel7-mby27e.css` | Tailwind v4 output (`@layer properties`, `--container-4xl:56rem`, `--tw-ease`); `cubic-bezier(.22,1,.36,1)` as the custom ease; `animation-timeline:scroll(self)` for scroll masks. |
| `/_next/static/immutable/chunks/0b6izlgii83fg.js` | `ease:[.22,1,.36,1]` in component transitions. |
| `/_next/static/immutable/chunks/0ru0u1tk1wzhc.js` | `window.MotionIsMounted=!0` and `whileInView`: the Motion library. |
| `/_next/static/immutable/chunks/2-w-g1enq2j5p.js`, requests `https://unpkg.com/@rive-app/webgl2@2.42.2/rive.wasm` and `/assets/usecases.riv` | Rive runtime and one Rive animation; durations 0.34–0.52 s with the same ease. |
| `/_next/static/immutable/chunks/3j52grh0a-k37.js` | `data-base-ui` attributes: Base UI components. |
| `/_next/static/immutable/chunks/turbopack-*.js`, `self.__next_f` | Next.js with Turbopack. |
| Computed styles on the home page | Colour transitions 150 ms `cubic-bezier(0.4,0,0.2,1)`; the only CSS animations are a spinner and scroll masks. |
| `https://aside.com/download` | Centred title, three step cards with captions "bold key, muted rest". |
| `https://aside.com/features/browser-agent` | Same frame, rules and caption rows on a sub page. |

Lenis, GSAP, ScrollTrigger and Three.js were not found in the reference's
loaded bundles.
