# Third-Party Notices

Ave is proprietary software, Copyright (c) 2026 Ken Jo. All rights reserved
(see [LICENSE](./LICENSE)).
This file attributes third-party software that ships with, or is bundled into,
Ave distributions but is licensed separately from Ave itself. Listing a
component here does not change its license, nor relicense Ave.

---

## @anthropic-ai/sandbox-runtime

- **Version:** 0.0.59 (pinned, exact)
- **License:** Apache License, Version 2.0
- **Copyright:** © Anthropic PBC
- **Repository:** https://github.com/anthropic-experimental/sandbox-runtime
- **Full license text:** bundled in the installed package at
  `node_modules/@anthropic-ai/sandbox-runtime/LICENSE`
  (also available at https://www.apache.org/licenses/LICENSE-2.0)

The Anthropic Sandbox Runtime (ASRT) wraps OS-level security boundaries around
spawned processes. Ave distributions bundle ASRT's prebuilt vendor binaries
(Linux `seccomp` BPF filter + loader, Windows `srt-win`) under
`node_modules/@anthropic-ai/sandbox-runtime/vendor/`. These binaries are
extracted from the Electron asar archive at packaging time (see the
`build.asarUnpack` entry in `package.json`) so they remain executable at
runtime.

A copy of the Apache License 2.0, as required by Section 4 of the license,
accompanies the bundled package at the path noted above.

---

## models.dev model metadata

- **What is included:** a normalized subset of the models.dev model catalog
  (context and output limits, modalities, capability flags, reasoning
  controls, listed prices) for the providers Ave vendors map to, kept at
  `src/core/model-catalog/bundled-snapshot.json`. The generator input it is
  made from is `scripts/model-catalog/models-dev-input.json`; where and when
  that input was downloaded is in `scripts/model-catalog/models-dev-source.json`.
- **License:** MIT
- **Copyright:** Copyright (c) 2025 models.dev
- **Repository:** https://github.com/anomalyco/models.dev
- **Full license text:** reproduced below, also kept at
  `scripts/model-catalog/models-dev-LICENSE.txt` and carried inside the
  bundled snapshot's `license` field.

```text
MIT License

Copyright (c) 2025 models.dev

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

---

## SheetJS Community Edition (`xlsx`)

- **Version:** 0.20.3 (pinned, exact; installed from the official tarball
  https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz with its integrity hash in
  `bun.lock`)
- **License:** Apache License, Version 2.0
- **Copyright:** Copyright (C) 2012-present SheetJS LLC
- **Repository:** https://git.sheetjs.com/sheetjs/sheetjs
- **Full license text:** https://www.apache.org/licenses/LICENSE-2.0 (also in
  the installed package at `node_modules/xlsx/LICENSE`)

Bundled into the main process to parse xlsx/xls/ods files for the side-panel
table preview. Ave does not modify SheetJS source files. Attribution notice
required by https://docs.sheetjs.com/docs/miscellany/license :

```text
SheetJS Community Edition -- https://sheetjs.com/

Copyright (C) 2012-present   SheetJS LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

## Papa Parse

- **Version:** 5.7.0 (pinned, exact)
- **License:** MIT
- **Repository:** https://github.com/mholt/PapaParse

Bundled into the main process to parse CSV/TSV files for the side-panel table
preview.

```text
The MIT License (MIT)

Copyright (c) 2015 Matthew Holt

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## react-data-grid

- **Version:** 7.0.0-beta.61 (pinned, exact)
- **License:** MIT
- **Repository:** https://github.com/adazzle/react-data-grid

Bundled into a lazily-loaded renderer chunk (with its stylesheet) as the
side-panel table preview grid.

```text
The MIT License (MIT)

Original work Copyright (c) 2014 Prometheus Research
Modified work Copyright 2015 Comcast

For the original source code please see https://github.com/prometheusresearch-archive/react-grid

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## @microsoft/mxc-sdk runtime dependency inventory

- **Version:** 1.0.1 (MIT), including `mxc_ffi.dll` and `wslcsdk.dll`.
- **koffi:** 3.3.6 (MIT), including the matching `@koromix/koffi-win32-x64` or `@koromix/koffi-win32-arm64` native addon.
- **semver:** 7.7.4 (ISC).
- **node-pty:** 1.1.0 (MIT), shared with the existing terminal runtime.

License texts and the native API header notices embedded by the FFI and terminal addons are included under `resources/licenses/mxc/`. Installed-byte hashes for the selected runtime artifacts are recorded in `src/permissions/mxc-launcher-pins.json`. Native packaged loading and dynamic DLL dependencies require verification on each target architecture.
