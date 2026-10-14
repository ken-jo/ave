# Third-party notices for the site in web/

The site's own code is covered by the repository's terms. It ships, adapts or
loads the following third-party work.

## Packages bundled into the site

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| next | 15.5.24 | MIT | Framework and static export |
| react, react-dom | 18.3.1 | MIT | Rendering |
| tailwindcss, @tailwindcss/postcss | 4.3.3 | MIT | Utility CSS and theme tokens (build time) |
| motion | 13.4.6 | MIT | Beam pulses and the scroll-linked model orbit |
| framer-motion (dependency of motion) | 13.5.1 | MIT | Motion's React layer |
| motion-dom (dependency of motion) | 13.5.1 | MIT | Motion's DOM renderer |
| motion-utils (dependency of motion) | 13.5.0 | MIT | Motion's shared helpers |
| @radix-ui/react-slot | 1.3.3 | MIT | `asChild` on the shadcn/ui button |
| @radix-ui/react-compose-refs (dependency of react-slot) | 1.1.5 | MIT | Ref merging inside Slot |
| class-variance-authority | 0.7.1 | Apache-2.0 | Button variants |
| clsx | 2.1.1 | MIT | Class joining in `cn` |
| tailwind-merge | 3.7.0 | MIT | Class merging in `cn` |

The list is the runtime dependency closure of `web/package.json`'s
dependencies, read from `web/node_modules`. `tslib` (declared by
framer-motion) is not imported by the ES builds the site bundles, and
`loose-envify` is a build transform, so neither ships; React's `scheduler`
(MIT) ships inside the framework. Each package's full licence text is in its
published package.

## Fonts (self-hosted through next/font)

| Font | Licence |
| --- | --- |
| Geist, Geist Mono | SIL Open Font License 1.1 |
| Noto Sans KR | SIL Open Font License 1.1 |

## Code adapted from other projects

### shadcn/ui

`components/ui/button.tsx` and `lib/utils.ts` follow shadcn/ui's Button and
`cn` helper.

```
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Magic UI

The beam pulse and the orbit in `components/scenes.tsx` are adapted from
Magic UI's AnimatedBeam and OrbitingCircles (repository
`magicuidesign/magicui`, registry files as of commit `85f97fd27b05`). The
adaptation draws beams from fixed coordinates so they render on the server.

```
MIT License

Copyright (c) Magic UI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
