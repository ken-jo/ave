// Pass the configured provider credential only to the isolated live-test child environment.
import { app, safeStorage } from "electron";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_KEY = "llm.apiKey.openrouter";

// Use the packaged product path; the generic runtime profile has no configured store.
app.setName("Ave");

const STATUS_PATH = join(process.cwd(), "smoke-live-app.status.txt");
const lines = [];
function report(message) {
  lines.push(message);
  console.log(`[smoke:app] ${message}`);
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

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    return fail("OS encryption unavailable — the stored key cannot be decrypted.");
  }
  const secretsPath = join(app.getPath("userData"), "ave-secrets.json");
  if (!existsSync(secretsPath)) {
    return fail(`no secret store at ${secretsPath} — configure a key in Settings first.`);
  }

  let apiKey;
  try {
    const stored = JSON.parse(readFileSync(secretsPath, "utf-8"))?.[SECRET_KEY];
    if (typeof stored !== "string" || stored.length === 0) {
      return fail(`${SECRET_KEY} is not set — add an OpenRouter key in Settings first.`);
    }
    apiKey = safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch (err) {
    return fail(`could not read ${SECRET_KEY}: ${err.message}`);
  }

  // Reports must expose neither the credential nor its length.
  report(`decrypted ${SECRET_KEY} — launching app suite`);

  const args = process.argv.slice(2);
  const child = spawn(
    "bunx",
    ["playwright", "test", "--config", "config/playwright.config.ts", ...(args.length ? args : ["test/e2e/ui/live-model-turn.spec.ts"])],
    {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, AVE_SMOKE_OPENROUTER_KEY: apiKey, E2E: "1" },
    },
  );

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("exit", (code) => {
    report(`suite exited with code ${code}`);
    report("--- suite output ---");
    // Provider errors may echo requests or credential-scoped URLs; redact all child output before reporting.
    report(redactSecret(output.trimEnd(), apiKey));
    app.exit(code ?? 1);
  });
});
