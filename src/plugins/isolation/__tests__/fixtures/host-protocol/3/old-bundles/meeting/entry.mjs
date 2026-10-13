// An old bundle's entry (protocol-2 manifest), as an import trap. The golden
// suite hands this path to the validation session with the old manifest beside
// it, and the session must refuse that manifest before anything imports the entry.
throw new Error("an old bundle's entry must never be imported");
