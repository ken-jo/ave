# Third-Party Notices

Ave is licensed under the MIT License (see [LICENSE](./LICENSE)).
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
