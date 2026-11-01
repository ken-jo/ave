Ave packages the @napi-rs/canvas 1.1.0 native binary (skia.<platform>.node,
https://github.com/Brooooooklyn/canvas) to render PDF preview pages.

- The @napi-rs/canvas wrapper and platform packages include MIT terms and a
  BSD-3-Clause notice for the bundled broken-image data: LICENSE.
- The binary statically links Skia (BSD-3-Clause), the third-party libraries
  enabled by scripts/build-skia.js and scripts/skia-gn-args.cjs at tag
  v1.1.0 (brotli, expat, FreeType, HarfBuzz, Highway, ICU, libjpeg-turbo,
  libjxl, libpng, libwebp, Wuffs, zlib), libavif and libaom with their
  vendored code, and the Rust crates locked in that tag's Cargo.lock.
  THIRD-PARTY-NOTICES.txt collects their license texts unchanged from the
  upstream files at the revisions pinned by Skia's DEPS or Cargo.lock.
  Where a crate archive omits its license file, the section identifies the
  exact repository revision or canonical license text URL used instead.
  The local skia-fontations bridge uses the pinned Skia source and license.
  FreeType is used under the FreeType License (FTL).

pdf.js (pdfjs-dist) ships its own LICENSE and wasm/LICENSE_* notices inside
the packaged application.
