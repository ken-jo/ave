# Third-party notices for the site in web/

The site's own code is covered by the repository's terms. It ships, adapts or
loads the following third-party work.

## Packages bundled into the site

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| next | 16.4.2 | MIT | Framework and static export |
| react, react-dom | 19.3.1 | MIT | Rendering |
| tailwindcss, @tailwindcss/postcss | 4.3.3 | MIT | CSS build (build time) |

The list is the runtime dependency closure of `web/package.json`'s
dependencies, read from `web/node_modules`. `loose-envify` is a build
transform and does not ship; React's `scheduler` (MIT) ships inside the
framework. Each package's full licence text is in its published package.

## Fonts (vendored in `public/fonts`, served from the site)

| Font | Version | Licence | Files |
| --- | --- | --- | --- |
| Pretendard Variable, dynamic subset (Kil Hyung-jin) | 1.3.9 | SIL Open Font License 1.1 | `public/fonts/pretendard/`, licence in `LICENSE.txt` there |
| JetBrains Mono, variable, latin and latin-ext (The JetBrains Mono Project Authors) | 5.3.0 of `@fontsource-variable/jetbrains-mono` | SIL Open Font License 1.1 | `public/fonts/jetbrains-mono/`, licence in `LICENSE.txt` there |

The font files are unmodified; the JetBrains Mono stylesheet keeps only the
latin and latin-ext faces of the package's `wght.css`.

## Pictures

The screenshots are captures of Ave itself, made for this site (see
`DESIGN.md`, "Media"). The dark captures show Ave with the Tokyo Night theme
package from the official marketplace installed, since the app has no
built-in dark theme. The built workspace fragments on the home page are drawn
for this site from the app's own UI strings (`DESIGN.md`, "Built fragments"),
and so is the download glyph in `components/icons.tsx`.
