# Site design

The product site at the canonical host. This file records the decisions so a
later change keeps them, not a component catalogue.

## Argument

The page is a list of claims, one per section, each with its proof:

| Section | Claim | Proof on the page |
| --- | --- | --- |
| Hero | Ave is a desktop agent that asks before it changes anything. | The workbench, two tiles, one approval waiting in the dock. |
| Permissions | The host decides, in four modes, with hard blocks no mode lifts. | The mode picker: six real requests change result as the mode changes. |
| Workbench | Four conversations run side by side, driven from the keyboard. | A four-tile window and the composer keys. |
| Models | You choose the model, key, server or subscription. | The provider names, set as the picture. |
| Plugins | Plugins come from git and are checked by hash. | The deep links, the four source kinds, the rules. |
| Alongside | Indexing, meetings, routines and sub-agents run beside you. | The chat list, where each of them shows up. |
| Download | It runs on three systems; unsigned builds take one step more. | The three installers, and the guide. |

## Idea

Ave's tiled workbench and its approval dock are the page's pictures: the site
shows the app's own interface, built in HTML at true size (`data-ui`
fragments), instead of screenshots or illustrations. The one live thing is the
permission mode picker; it is plain radio buttons and `:has()`, so it works
without script.

## Tokens

All colours are roles in `app/globals.css`. Light page, no dark mode.

- Ground `--bg` #f1f2ed, surface `--surface` #e3e6dd, ink #0e1a14, muted #45514a.
- Accent `--accent` #c4f04a (lime): the approval colour. Used for the action on
  the dark field, the selected mode, and the download field.
- Fields: hero and plugins on the ground; permissions on the dark field;
  models and alongside on the surface; download on lime; footer dark.

Measured contrast (WCAG): ink on ground 15.9, muted on ground 7.4, muted on
surface 6.6, dark-field text 14.9, dark-field muted 8.5, ink on lime 13.5.

## Type

IBM Plex Sans KR (one family for Hangul and Latin) through `next/font`, weights
400/500/600. Sizes: display, section head, lead, body, small. Monospace only in
real code and inside interface fragments.

## Rules

- Headlines stay within two lines at 360, 768 and 1440 px.
- No eyebrows, gradients, glass, icon cards or index numbers. Rules (lines)
  only in real tables and inside interface fragments.
- Motion: one hero line reveal, the fragment's typing and dock, section
  entrances gated on hydration. Everything is visible without script, and
  `prefers-reduced-motion` drops all travel.
- 360 px: no horizontal page scroll. Code blocks scroll inside themselves.
