Protocol 5 method frames, notifications, and conversations are pinned here.
Each `plugins/<id>` directory contains a complete plugin and its recorded
`expected.jsonl`. `invoker.mjs` exercises each method frame through the real
child runtime. Unsupported protocol declarations are derived from a current
manifest in the golden test, without retaining per-version plugin bundles.
