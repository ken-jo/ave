// Keep dispatch in runCommand and transport in http-client; this entry only wires the CLI.
// Exit codes: 0 success/help, 2 discovery/usage error, 1 rejected dispatch.
import { CLI_COMMANDS, runCommand } from "../src/cli/commands.js";
import { createHttpLocalApi, readLocalApiConnection } from "../src/cli/http-client.js";
import { createAveClient, AveClientError } from "../src/sdk/index.js";

function usageText(): string {
  const commands = CLI_COMMANDS.map((c) => `  ${c.name.padEnd(20)} ${c.summary}`).join("\n");
  return [
    "Ave CLI — talk to a running Ave instance over its loopback local API.",
    "",
    "Usage:",
    "  bun run cli -- <command> [args...]",
    "",
    "Commands:",
    commands,
    "",
    "The local API server is OFF by default. Enable it, then restart Ave:",
    "  - Settings → System → localApiServer (settings.system.localApiServer = true), or",
    "  - set the environment variable AVE_LOCAL_API=1",
  ].join("\n");
}

const SERVER_NOT_RUNNING =
  "local API server is not running (enable settings.system.localApiServer or AVE_LOCAL_API=1 and restart Ave)";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    console.log(usageText());
    return 0;
  }

  const conn = await readLocalApiConnection();
  if (conn === null) {
    console.error(SERVER_NOT_RUNNING);
    return 2;
  }

  // Use the shared client contract with the cli origin.
  const httpApi = createHttpLocalApi(conn);
  const client = createAveClient(httpApi, "cli");

  try {
    const result = await runCommand(argv, client);
    if (!result.ok) {
      // Send usage errors to stderr so stdout stays pipeable.
      console.error(usageText());
      return 2;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof AveClientError) {
      console.error(`error: ${err.code} (channel: ${err.channel})`);
      return 1;
    }
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
