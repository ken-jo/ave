// The protocol-1 bundle's entry, as an import trap. The golden suite hands this
// path to the validation session with the protocol-1 manifest beside it, and
// the session must refuse that manifest before anything imports the entry.
throw new Error("protocol-1 entry must never be imported");
