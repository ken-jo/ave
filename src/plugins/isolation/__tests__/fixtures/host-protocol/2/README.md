Protocol 2 manifests, method frames, notifications, and conversations are pinned here.
Unchanged fixture plugin code is shared from `../1/`: it exercises the same
host methods while the protocol-2 host and child record the new wire shape.
The indexer has its own `entry.mjs` here because its lease result now carries
an opaque identifier. The golden test passes each source path explicitly.
