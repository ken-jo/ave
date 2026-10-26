// Decrypt stored credentials only in the desktop runtime and pass them through the child environment.
// Keep them out of argv and disk; this local-user smoke is unsuitable for shared CI.
import { app, safeStorage } from "electron";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_KEY = "llm.apiKey.openrouter";

// Derive the configured store path from the packaged product name.
app.setName("Ave");

// GUI-subsystem stdout may be unavailable; mirror progress to a status file.
const STATUS_PATH = join(process.cwd(), "smoke-live-model.status.txt");
const lines = [];
function report(message) {
  lines.push(message);
  console.log(`[smoke:llm] ${message}`);
  writeFileSync(STATUS_PATH, `${lines.join("\n")}\n`, "utf-8");
}

// Redact secrets even when downstream tools echo them.
function redactSecret(text, secret) {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function fail(message) {
  report(`FAILED: ${message}`);
  app.exit(1);
}

function readStoredKey() {
  if (!safeStorage.isEncryptionAvailable()) {
    return fail("OS encryption unavailable — the stored key cannot be decrypted.");
  }
  const secretsPath = join(app.getPath("userData"), "ave-secrets.json");
  if (!existsSync(secretsPath)) {
    return fail(`no secret store at ${secretsPath} — configure a key in Settings first.`);
  }
  const stored = JSON.parse(readFileSync(secretsPath, "utf-8"))?.[SECRET_KEY];
  if (typeof stored !== "string" || stored.length === 0) {
    return fail(`${SECRET_KEY} is not set — add an OpenRouter key in Settings first.`);
  }
  return safeStorage.decryptString(Buffer.from(stored, "base64"));
}

// Avoid top-level await: the main-process loader may start the app before the module body completes.
app.whenReady().then(() => {
  let apiKey;
  try {
    apiKey = readStoredKey();
  } catch (err) {
    return fail(`could not read ${SECRET_KEY}: ${err.message}`);
  }
  if (!apiKey) return;

  // Reports must expose neither the credential nor its length.
  report(`decrypted ${SECRET_KEY} — running suite`);

  const child = spawn(
    "bun",
    ["run", "test:vitest", "--", "test/smoke/live-model.smoke.test.ts"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, AVE_SMOKE_OPENROUTER_KEY: apiKey },
    },
  );

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("exit", (code) => {
    report(`suite exited with code ${code}`);
    report("--- suite output ---");
    // Redact provider output before console or status writes; errors may contain credentials.
    report(redactSecret(output.trimEnd(), apiKey));
    app.exit(code ?? 1);
  });
});
