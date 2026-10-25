// Lifecycle denials are recorded but must not block the caller; echo the event for audit assertions.
let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ action: "deny", reason: "bad stdin" }));
    return;
  }
  process.stdout.write(
    JSON.stringify({ action: "deny", reason: "lifecycle deny for " + p.event }),
  );
});
