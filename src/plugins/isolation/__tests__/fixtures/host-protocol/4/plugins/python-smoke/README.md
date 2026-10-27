# python-smoke

The cross-language smoke (`docs/design/plugin-hostapi-protocol.md` §9.7 P5): a
`process` plugin written in Python that speaks the host protocol over its own
stdin and stdout.

- `plugin.json` declares `process: { command: "./bin/plugin" }` and no `env`.
  `PYTHONPATH` is a name the host reserves, so `bin/plugin` sets it itself,
  inside confinement, from the host-owned `PLUGIN_ROOT`.
- `bin/plugin` runs the interpreter named in `bin/python-path` with `-s` (no
  user site directory) on `plugin.py`. The test harness writes
  `bin/python-path` and `vendor/` into its temporary copy of this directory;
  neither is committed.
- `plugin.py` routes `ave/instance/*` to its own handlers and serves the MCP
  half with the stock `mcp` library, pinned at **2.2.0**, in memory, one
  message at a time. It answers `-32602` to any MCP request whose `_meta` lacks
  `io.modelcontextprotocol/protocolVersion` or
  `io.modelcontextprotocol/clientCapabilities`, before the library sees it.
- Beside `echo` it serves `escape_secrets` and `escape_network`, Admission's
  escapes 1 and 2 (`plugin-hostapi-protocol.md` §9.8 A2) from a child that is
  not JavaScript: a read of the host's secrets directory and of another
  plugin's data directory, after a write and read-back of its own as the
  in-sandbox control, and a raw socket to a loopback listener. They
  report what the platform answered; `adversarial-escapes.test.ts` runs them
  under the real wrap and asserts the refusals.
- `expected.jsonl` is its golden transcript, recorded by
  `host-protocol-golden.test.ts`.

## The interpreter

One interpreter, Python 3.10 or newer (`mcp` 2.2.0's floor), resolved by
`python-smoke-harness.ts`: `AVE_SMOKE_PYTHON` when set (CI sets it from
`actions/setup-python`), otherwise a uv-managed Python found with
`--managed-python` in `node_modules/.cache/ave-python-smoke/python`, installed
there by the app's development uv on a miss. A Python on `PATH` is never used.
