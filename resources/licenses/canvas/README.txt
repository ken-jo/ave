Ave packages the @napi-rs/canvas 1.0.10 native binary (skia.<platform>.node,
https://github.com/Brooooooklyn/canvas) to render PDF preview pages.

- The @napi-rs/canvas wrapper and platform packages are MIT licensed: LICENSE.
- The binary statically links Skia (BSD-3-Clause), the third-party libraries
  enabled by scripts/build-skia.js at tag v1.0.10 (brotli, expat, FreeType,
  HarfBuzz, Highway, ICU, ICU4X, libjpeg-turbo, libjxl, libpng, libwebp,
  Wuffs, zlib), libavif and libaom with their vendored code, and the Rust
  crates locked in that tag's Cargo.lock. Their notices are collected in
  THIRD-PARTY-NOTICES.txt, each copied unchanged from the upstream source at
  the revision Skia's DEPS file or Cargo.lock pins. FreeType is used under
  the FreeType License (FTL).

pdf.js (pdfjs-dist) ships its own LICENSE and wasm/LICENSE_* notices inside
the packaged application.
