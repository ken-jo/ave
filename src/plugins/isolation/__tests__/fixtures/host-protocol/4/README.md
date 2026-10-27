Protocol 4 manifests, method frames, notifications, and conversations are pinned here.
Each `plugins/<id>` directory is a complete plugin — its `plugin.json`, its own
`entry.mjs` and its recorded `expected.jsonl` — so a directory validator can take
it as is. `invoker.mjs` is the golden invoker every method frame is recorded
through. `old-bundles/` holds manifests this host must refuse — `meeting`
declares the retired protocol 2, `samplemail` declares protocol 3, and
`local-indexer` declares no protocol — and
their entries are import traps: the old-bundle case must refuse each manifest
before anything imports its entry.
