# Site design

The product site at the canonical host. These are the rules a change must keep.
Each one is written so it can be checked on the built page. They were derived
from a study of a reference product site (appendix A) and translated into Ave's
own material: no text, image, illustration or typeface was taken from it.

## Argument

The page is a list of claims, one per section, each with its proof. The
argument stays "the agent that asks first"; the redesign changed how it is set,
not what it says.

| Section | Claim | Proof on the page |
| --- | --- | --- |
| Hero | Ave is a desktop agent that asks before it changes anything. | The workbench, two tiles, one approval waiting in the dock. |
| Intro | It is a desktop app; writes, commands and network requests pass the host's check. | One paragraph, its first sentence in ink. |
| Permissions | The host decides, in four modes, with hard blocks no mode lifts. | The mode picker: six real requests change result as the mode changes. |
| Workbench | Four conversations run side by side, driven from the keyboard. | A four-tile window and the composer keys. |
| Models | You choose the model, key, server or subscription. | The provider names. |
| Plugins | Plugins come from git and are checked by hash. | The deep links, the four source kinds, the rules. |
| Alongside | Indexing, meetings, routines and sub-agents run beside you. | The chat list, where each of them shows up. |
| Download | It runs on three systems; unsigned builds take one step more. | The three installers, and the guide. |

## Principles

### Layout

1. **One frame.** Content sits in a frame of at most 1248 px with a side margin
   of `clamp(16px, 6.67vw, 96px)`. From 1024 px the frame shows 1 px vertical
   rules on both edges; sections are separated by 1 px horizontal rules. Rules
   are `--line` (ink at 8 %), never darker.
2. **One idea per section, centred on a 45 rem measure.** Headings and lead
   text sit in a 45 rem (720 px) column. Wider material (windows, tables, card
   rows) may use the full frame; running text never exceeds 64 ch.
3. **Pacing by bands, not colours.** Sections alternate between the white
   ground and the `--band` ground (#fafaf9). There is one dark surface on the
   home page (the plugin code panel) and two tinted panels (hero, closing call
   to action). No other section fields.
4. **Section rhythm.** Every section has the same vertical padding,
   `clamp(4rem, 2.5rem + 5vw, 7.5rem)`. Between blocks inside a section the
   steps are 0.75 / 1.25 / 2 / 3.5 rem; smaller values only inside a
   component (a button, a chip, a row).
5. **Captions, not cards.** A group of points is a row of 2–3 captions:
   a bold ink title followed by a muted body in the same paragraph. No icons,
   no borders around the text, no numbering.
6. **360 px works.** No horizontal page scroll at 360 px; code scrolls inside
   its own box; every multi-column row collapses to one column below 760 px.

### Type

7. **Families.** Geist (variable, OFL) for Latin, Noto Sans KR (variable, OFL)
   for Hangul through the font stack, Geist Mono (OFL) for code and for the
   interface fragments' code lines. All self-hosted through `next/font`.
8. **Scale, five steps.** Display `clamp(2.5rem, 1.9rem + 2.4vw, 3.5rem)`,
   section head `clamp(2rem, 1.6rem + 1.6vw, 2.75rem)`, lead
   `clamp(1.0625rem, 1rem + 0.35vw, 1.25rem)`, body 1 rem, small 0.875 rem.
   Nothing else on marketing pages; docs add one article head (1.5 rem).
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
    #5f6461 (6.0:1 on white, 5.8:1 on the band).
14. **Lime is a mark, not text.** `--lime` #c4f04a appears only as the logo
    stroke, the hero and closing glow, text selection and the "allow" state in
    the fragment. Text that needs the accent uses `--accent-ink` #3a6510
    (6.9:1 on white).
15. **Verdicts are text first.** Each permission result is a word with a dot:
    run #2e6a12, ask #8a5300, review #1d5d96, block #b42318, each at least
    5.9:1 on white and on the band.
16. **AA everywhere.** Every text pair reaches 4.5:1; large display text is
    not given an exception.

### Shape and depth

17. **Two radii and a pill.** 10 px for controls, small cards and code; 24 px
    for panels; a full pill for the primary call to action and the mode
    picker.
18. **One shadow.** Only the interface fragment's window casts a shadow
    (`0 1px 2px` plus a long soft drop at 18 % ink). Nothing else floats.

### Product as picture

19. **Show the app itself.** Pictures are Ave's own interface built in HTML at
    true size (`[data-ui]` fragments), set inside a tinted 24 px panel. No
    screenshots, no stock imagery, no illustration that the app cannot show.
20. **The hero window bleeds.** The hero fragment is cut by the bottom edge of
    its panel, so the window reads as the app continuing below the fold.

### Motion

21. **Three jobs only.** Motion (a) brings a block in once as it enters the
    viewport, (b) shows a state change (mode picker, hover, press), (c) plays
    the fragment's own behaviour (streaming text, the approval dock). Nothing
    moves on scroll after it has entered; no parallax, no scroll hijacking, no
    smooth-scroll library.
22. **Numbers.** Entrances: opacity and a 12 px rise, 520 ms,
    `cubic-bezier(0.22, 1, 0.36, 1)`, at most four staggered children 60 ms
    apart. Colour transitions 150 ms. Press: scale 0.98 for 120 ms.
23. **Off when asked, visible without script.** Under
    `prefers-reduced-motion: reduce` nothing travels or fades. Without script
    every block is visible: hidden starting states are only applied once a
    script has marked the document.

### Interaction

24. **Header.** Sticky, white, 64 px, with a hairline under it. Wordmark left,
    up to three section links centred (hidden under 760 px), language and one
    ink "Download" button right. The footer is light: link columns (sections,
    guide pages, systems), a hairline, then the notice and the language link.
25. **Links in text** are underlined at 1 px with a 0.2 em offset; hover
    changes only the underline colour. Section labels above heads are links to
    the matching guide page, in `--accent-ink` with a chevron.
26. **Focus is always visible:** 2 px `--focus` ring at 3 px offset on every
    interactive element, including the mode picker radios.

### Copy

27. **Short sentences; facts from the source.** Product facts are taken from
    the app's code and UI strings (`web/lib/home.ts`, `web/lib/docs.ts`); a
    wording change never changes a fact.
28. **Headings name the thing;** no exclamation marks, no rhetorical
    questions, no superlatives that the app cannot prove.

### Docs and download

29. **Download:** centred title, three system cards (name, format, one
    button), then one setup section per system at `#mac`, `#windows`,
    `#linux`, steps numbered, commands with a copy button.
30. **Docs:** an index of caption cards; an article page with a 14 px sticky
    page list on the left and the article in the 45 rem measure.

## Libraries

Chosen: **none added.** The page needs fonts and a small amount of CSS motion.

| Need | Choice | Licence | Why |
| --- | --- | --- | --- |
| Latin type | Geist via `next/font/google` | SIL OFL 1.1 | Open; the reference's body face, and close in tone to its proprietary display face. |
| Hangul type | Noto Sans KR via `next/font/google` | SIL OFL 1.1 | Variable, so weight 450 exists for Hangul too. |
| Code type | Geist Mono via `next/font/google` | SIL OFL 1.1 | Pairs with Geist. |
| Reveal on scroll | `IntersectionObserver` + CSS | — | Same effect as a motion library, no bundle cost, works without script. |

Libraries found on the reference and not adopted:

| Library | Why not |
| --- | --- |
| Custom display variable font | Proprietary; replaced by Geist at 450 (principle 7). |
| Motion (React animation) | Entrances here are CSS transitions; a runtime would add weight and break the no-script parity (principle 23). |
| Rive (`@rive-app/webgl2`) | Needs authored `.riv` animations and a WASM runtime; Ave's pictures are its own HTML interface (principle 19). |
| Base UI | No menus, dialogs or popovers on this site; native radios and `<details>` cover the interaction. |
| Tailwind CSS v4 | The site's CSS is one token file; the PostCSS setup was removed on purpose. |
| PostHog, Google Tag Manager, ad pixels | The site does not track visitors. |

Not found in the reference's loaded bundles: Lenis, GSAP, ScrollTrigger,
Three.js.

## Appendix A — evidence

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
