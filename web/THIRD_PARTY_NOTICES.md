# Third-party notices for the site in web/

The site's own code is covered by the repository's terms. It ships, adapts or
loads the following third-party work.

## Packages bundled into the site

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| next | 15.5.24 | MIT | Framework and static export |
| react, react-dom | 18.3.1 | MIT | Rendering |
| motion, framer-motion, motion-dom | 14.3.0 | MIT | Home page scroll-linked and entrance animation |
| motion-utils | 14.1.1 | MIT | Shipped inside motion |
| tslib | 2.8.1 | 0BSD | Helpers shipped inside motion |
| tailwindcss, @tailwindcss/postcss | 4.3.3 | MIT | CSS build (build time) |

The list is the runtime dependency closure of `web/package.json`'s
dependencies, read from `web/node_modules`. `loose-envify` is a build
transform and does not ship; React's `scheduler` (MIT) ships inside the
framework. Each package's full licence text is in its published package.

## Fonts (self-hosted through next/font)

| Font | Licence |
| --- | --- |
| Geist, Geist Mono | SIL Open Font License 1.1 |
| Noto Sans KR | SIL Open Font License 1.1 |

## Pictures

The screenshots and the home page loop are captures of Ave itself, made for
this site (see `DESIGN.md`, "Media"). The dark captures show Ave with the
Tokyo Night theme package from the official marketplace installed, since the
app has no built-in dark theme. The line icons in `components/icons.tsx`
are drawn for this site.
