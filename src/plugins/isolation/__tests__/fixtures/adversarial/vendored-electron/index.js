// The `electron` npm package's entry, in the shape that matters: it exports the
// PATH of the binary as a string. Loaded by `escape_electron` through this
// explicit path — the fixture has no `node_modules`, so the bare specifier
// `electron` never resolves to it (plugin-hostapi-protocol.md §9.8, escape 3).
module.exports = "/path/to/an/Electron/binary";
