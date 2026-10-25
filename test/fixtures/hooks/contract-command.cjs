let input = "";
process.stdin.on("data", (part) => { input += part; });
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  switch (process.argv[2]) {
    case "echo":
      process.stdout.write(JSON.stringify({ action: "allow", reason: "received", received: payload }));
      break;
    case "silent": break;
    case "block":
      process.stderr.write("Policy requires a focused correction before proceeding.");
      process.stdout.write('{"action":"allow","reason":"cannot override exit 2"}');
      process.exitCode = 2;
      break;
    case "failure":
      process.stderr.write("Command failed to read its policy file.");
      process.exitCode = 7;
      break;
    case "signal": process.kill(process.pid, "SIGTERM"); break;
    case "invalid": process.stdout.write("invalid JSON"); break;
    case "slow": setInterval(() => {}, 1000); break;
    case "decision": process.stdout.write('{"decision":"block","reason":"Review required"}'); break;
    case "large": process.stdout.write("x".repeat(32 * 1024)); break;
    default: throw new Error("Unknown contract fixture mode");
  }
});
