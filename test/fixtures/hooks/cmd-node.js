// Echo trust origin through the command-hook wire payload.
let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ action: "deny", reason: "bad stdin" }));
    return;
  }
  process.stdout.write(
    JSON.stringify({ action: "allow", reason: "node ok origin=" + payload.trustOrigin }),
  );
});
