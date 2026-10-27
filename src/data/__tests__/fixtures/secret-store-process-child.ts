import { SecretDocumentStore } from "../../secret-document-store.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeUtf8FileAtomicSync } from "../../../lib/atomic-file.js";

const [, , command, path, ...args] = process.argv;
const [key, value] = args;

const encryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret" as const,
  encryptString: (plaintext: string) => Buffer.from(`sealed:${plaintext}`, "utf-8"),
  decryptString: (ciphertext: Buffer) => {
    const decoded = ciphertext.toString("utf-8");
    if (!decoded.startsWith("sealed:")) throw new Error("invalid test ciphertext");
    return decoded.slice(7);
  },
};

if (command === "settings-rotate" || command === "settings-delete") {
  const file = join(path, "ave-secrets.json");
  const document = JSON.parse(readFileSync(file, "utf8")) as { mutation?: number; entries: Record<string, { encoding: string; value: string }> };
  if (command === "settings-rotate") document.entries[key] = { encoding: "external-key", value: Buffer.from("child-rotated-key").toString("base64") };
  else delete document.entries[key];
  document.mutation = (document.mutation ?? 0) + 1;
  writeUtf8FileAtomicSync(file, `${JSON.stringify(document)}\n`, 0o600);
} else {
  const store = new SecretDocumentStore({ path, policy: "packaged", encryption });
  if (command === "set") await store.set(key, value);
  else if (command === "delete") await store.delete(key);
  else if (command === "delete-many") await store.deleteMany(args);
  else throw new Error(`unknown secret-store child command: ${String(command)}`);
}
