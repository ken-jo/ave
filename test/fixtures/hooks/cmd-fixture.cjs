const { readFileSync } = require("node:fs");

function reply(action, reason) {
  process.stdout.write(JSON.stringify({ action, reason }));
}

const input = readFileSync(0, "utf8");
switch (process.argv[2]) {
  case "policy": {
    const { toolName = "" } = JSON.parse(input);
    if (toolName.includes("blocked")) reply("deny", `command policy denied ${toolName}`);
    else reply("allow", "command policy ok");
    break;
  }
  case "exit-fail":
    reply("allow", "ignored because exit != 0");
    process.exitCode = 3;
    break;
  case "bad-json":
    process.stdout.write("invalid JSON");
    break;
  case "slow":
    setTimeout(() => reply("allow", "should never be read"), 30_000);
    break;
  case "noenv": {
    const forbidden = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY", "AVE_SECRET_PROBE", "GOOGLE_API_KEY"];
    const leaked = forbidden.filter((name) => name in process.env);
    if (leaked.length > 0) reply("deny", `leaked: ${leaked.join(",")}`);
    else reply("allow", "no secret env");
    break;
  }
  default:
    throw new Error("Unknown hook fixture mode");
}
