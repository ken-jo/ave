// Reflect injected hook metadata to prove event context is present and secrets remain excluded.
let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const secretLeaked =
    process.env.ANTHROPIC_API_KEY !== undefined ||
    process.env.AVE_SECRET_PROBE !== undefined;
  const parts = [
    "EVENT=" + (process.env.AVE_HOOK_EVENT ?? "<unset>"),
    "TYPE=" + (process.env.AVE_HOOK_TYPE ?? "<unset>"),
    "SESSION=" + (process.env.AVE_HOOK_SESSION_ID ?? "<unset>"),
    "TOOL=" + (process.env.AVE_HOOK_TOOL_NAME ?? "<unset>"),
    "ORIGIN=" + (process.env.AVE_HOOK_TRUST_ORIGIN ?? "<unset>"),
    "SECRET=" + (secretLeaked ? "LEAKED" : "clean"),
  ];
  process.stdout.write(JSON.stringify({ action: "allow", reason: parts.join(" ") }));
});
