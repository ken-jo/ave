import { inline, type Inline, type Release } from "./changelog";

/**
 * The English release notes the English pages show. The repository's
 * CHANGELOG.md is written in Korean; each entry here is the same release's
 * items, in the same order, rewritten as a headline and short bullet points.
 * Text in `backticks` renders as code.
 *
 * `englishRelease` ties the two together: a release in CHANGELOG.md without an
 * entry here, or an entry whose item count differs from the release's list,
 * fails the build, so the English page cannot fall behind or drift.
 */

export interface EnItem {
  title: string;
  points: string[];
}

const EN: Record<string, EnItem[]> = {
  "v0.14.0": [
    {
      title: "Ave is a new app",
      points: [
        "It starts empty: it does not update an installed predecessor app, or read that app’s settings and data.",
        "The website is `ave.agent-connector.ai`; downloads and updates come from `downloads.agent-connector.ai`.",
      ],
    },
    {
      title: "Ave’s identifiers and paths",
      points: ["App ID `ai.agent-connector.ave`, data folder `~/.ave`, environment variables `AVE_*`, link scheme `ave://`."],
    },
    {
      title: "Extension authors move to host protocol 3",
      points: [
        "Protocol 3 uses the `ave/*` wire and is the only protocol Ave supports.",
        "Re-vendor the contract (`contract/`) from the app’s release tag, declare `requires.hostProtocol: \"3\"` and `requires.minAppVersion: \"0.14.0\"` in the manifest, and publish again.",
        "Extensions built for protocol 2 are rejected before they start.",
        "This version’s protocol schema is published as `schemas/plugin-host-protocol/3/v0.14.0/protocol.schema.json`.",
      ],
    },
    {
      title: "Plugin contract identifiers moved to the Ave domain",
      points: [
        "Ave-specific `plugin.json` fields live under `extensions[\"ai.agent-connector.ave\"]`; a package’s prompt, agent, hook and routine files go in an `ai.agent-connector.ave/` folder.",
        "A skill package’s `$schema` is `https://ave.agent-connector.ai/schemas/skill/1/skill.schema.json`; the manifest and marketplace schemas are published under `https://ave.agent-connector.ai/schemas/plugin/3/` and `https://ave.agent-connector.ai/schemas/marketplace/2/`.",
        "Earlier identifiers are not recognised.",
      ],
    },
    {
      title: "Every extension runs in its own process",
      points: [
        "The same for every install path: marketplace, custom source, folder or direct install.",
        "With the OS sandbox on, an extension that reached the network without `hostFetch` is blocked; one that used home-relative paths or internal app APIs fails on those calls and needs an updated version.",
        "Diagnostics show each extension’s process and isolation state.",
      ],
    },
    {
      title: "On Windows, extension work runs inside the sandbox when it is on",
      points: [
        "Extension child processes, workers, hooks and MCP servers run inside the Windows sandbox.",
        "Windows does not isolate extensions from one another, and the app says so.",
        "Extensions that start their own executable through a `process` entry still do not run on Windows.",
      ],
    },
    {
      title: "Model facts come from the bundled model catalog",
      points: [
        "Context window, image input and tool support come from the catalog and what the provider reports, instead of a hand-kept table.",
        "Some models may show a different context size and compact at a different point.",
      ],
    },
    {
      title: "Skills load when needed",
      points: ["The prompt carries only each skill’s name and description; when the agent uses a skill, `skill_load` reads its body and shows it in the conversation as a tool result. (#83)"],
    },
    {
      title: "The agent’s file and shell tools changed",
      points: [
        "A file must be read before it is edited, and a file that changed after it was read must be read again.",
        "Paths that `apply_patch` changes go through permission review.",
        "Reading a long file returns what fits and where to continue.",
        "A `cd` in the shell carries over to the next command in the same conversation, and a running command’s output appears in its tool card as it arrives.",
        "Background processes a sub-agent started end when that sub-agent ends. (#72)",
      ],
    },
    {
      title: "Search, web and memory tools are built in",
      points: [
        "File search runs on ripgrep.",
        "`web_fetch` returns a page as Markdown and marks its content as untrusted data for the model.",
        "`memory_search`, `memory_read` and `memory_delete` let the agent find and read what it remembers, and withdraw a memory it proposed by mistake.",
        "Images returned by MCP tools reach the model as images, not base64 text. (#72)",
      ],
    },
    {
      title: "Project instructions and command files",
      points: [
        "From the repository root down to the project folder, each folder’s `AGENTS.md` (or `CLAUDE.md` when that is missing or empty) is read as instructions.",
        "Markdown files in `<project>/.ave/commands` and `<Ave home>/commands` become `/<name>` commands; a built-in command wins a name clash.",
        "`/model` changes the model for this conversation only, or returns it to `default`. (#72)",
      ],
    },
    {
      title: "Repeated prompt prefixes are read from cache",
      points: [
        "The time, environment and memory notes that changed every turn moved out of the system prompt, and Anthropic requests carry cache breakpoints.",
        "OpenAI and Azure Foundry receive the session ID as the cache key.",
        "Compaction summaries stay in the conversation, and `/compact <focus>` says what the summary should keep.",
        "Earlier conversations move to the new format when they are opened. (#72)",
      ],
    },
    {
      title: "Suggestion cards gather in a Suggestions conversation",
      points: [
        "Suggestions from extensions, alerts and routines no longer break into the open conversation.",
        "A card can continue in a new conversation; the Suggestions conversation cannot be archived, and comes back empty if deleted.",
        "Onboarding suggestions still show inside the conversation. (#57)",
      ],
    },
    {
      title: "Chat input and the conversation view",
      points: [
        "Pasted text up to 500 characters goes into the composer as is; longer text becomes a chip that opens to the original (the first 32K characters shown, all of it sent).",
        "Code blocks show their language and a copy button.",
        "Up and Down recall earlier input, and each conversation keeps its draft.",
        "Attach files by dropping them or with `@file`; Enter does not send while Korean input is still composing.",
        "Long conversations no longer rescan the whole history every turn. (#70, #82)",
      ],
    },
    {
      title: "The workspace terminal shows command blocks",
      points: [
        "Each command’s location, exit code, duration and output form one block, which can be attached to the chat.",
        "The agent reads terminal output in the same window with `terminal_read`, as untrusted data. (#59)",
      ],
    },
    {
      title: "Side-panel browser and multiple windows",
      points: [
        "Downloads in the side-panel browser go through the system save dialog and are never saved or opened automatically; full screen is not allowed.",
        "Several main windows can be open; approvals and questions appear in the window that asked, and answering in one closes the copies in the others. (#60)",
      ],
    },
    {
      title: "Remote connections are steadier",
      points: [
        "Remote A2A shows the other agent’s answer and follows the task to the end.",
        "The app starts and reports status even when an enabled gateway is not ready; a gateway that failed to start shows as failed rather than off, and one whose settings changed shows as waiting for a restart.",
        "Telegram confirms the connection to the phone that used the pairing code, reconnects after wake or network recovery, and keeps to rate-limit waits.",
        "Tailnet errors show on collapsed rows too, and `--serve` keeps running when Tailnet does not start. (#86)",
      ],
    },
    {
      title: "Permission checks changed",
      points: [
        "Shell commands that send file contents over the network (`curl` uploads, remote `scp` or `rsync`, `nc` and the like) count as high risk and always ask, in every mode.",
        "A damaged permission rules file blocks instead of being ignored.",
        "Approvals are remembered per scope rather than per exact call: `web_fetch` per `scheme://host:port` for public addresses, and only the exact URL for private-network addresses.",
        "When the arguments change within the same scope, the call is reviewed again and goes through without asking only when its risk is not higher. (#88)",
      ],
    },
  ],
};

export interface EnRelease {
  items: { title: Inline[]; points: Inline[][] }[];
}

/** The English notes for one release; fails the build if they are missing or out of step with CHANGELOG.md. */
export function englishRelease(r: Release): EnRelease {
  const items = EN[r.name];
  if (!items) throw new Error(`lib/changelog-en.ts has no English notes for ${r.name}`);
  const list = r.blocks.find((b) => b.kind === "list");
  const count = list && list.kind === "list" ? list.items.length : 0;
  if (items.length !== count) {
    throw new Error(`lib/changelog-en.ts: ${r.name} has ${items.length} items, CHANGELOG.md has ${count}`);
  }
  if (r.blocks.length !== 1) throw new Error(`${r.name}: expected a single list of changes to translate`);
  return { items: items.map((it) => ({ title: inline(it.title), points: it.points.map((p) => inline(p)) })) };
}

/** Releases with English notes that CHANGELOG.md does not list: a stale entry here. */
export function staleEnglishNotes(names: string[]): string[] {
  return Object.keys(EN).filter((n) => !names.includes(n));
}
