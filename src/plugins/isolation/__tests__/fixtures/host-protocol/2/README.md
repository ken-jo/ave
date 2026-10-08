Protocol 2 manifests, method frames, notifications, and conversations are pinned here.
Each `plugins/<id>` directory is a complete plugin — its `plugin.json`, its own
`entry.mjs` and its recorded `expected.jsonl` — so a directory validator can take
it as is. Only the invoker's code (`../1/invoker.mjs`) is still shared with the
protocol-1 fixtures; the golden test passes that path explicitly. The protocol-1
`meeting` and `local-indexer` entries are import traps: the old-bundle case must
refuse their manifests before anything imports them.
