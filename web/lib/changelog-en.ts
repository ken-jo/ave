import { inline, type Inline, type Release } from "./changelog.js";

/**
 * The English release notes the English pages show. The repository's
 * CHANGELOG.md is written in Korean; each entry here is the same release's
 * items, in the same order, rewritten as a headline and short bullet points.
 * Text in `backticks` renders as code.
 *
 * `englishRelease` ties the two together: a release in CHANGELOG.md without an
 * entry here, different block kinds, or per-list item-count mismatches
 * fails the build, so the English page cannot fall behind or drift.
 */

interface EnItem {
  title: string;
  points: string[];
}

type EnBlock =
  | { kind: "h3"; text: string }
  | { kind: "list"; items: EnItem[] };

const EN: Record<string, EnBlock[]> = {
  "v0.15.0": [
    {
      kind: "h3",
      text: "Before you update"
    },
    {
      kind: "list",
      items: [
        {
          title: "0.15.0 is the first host protocol 5 release",
          points: [
            "Released hosts move directly from protocol 3 to 5; protocol 4 was never released. Protocol-3 extensions cannot run, so update them to protocol 5. Marketplace extensions are being republished with this release.",
            "For your own extensions, re-vendor the contract from the v0.15.0 tag and republish with `hostProtocol: \"5\"` and `minAppVersion: \"0.15.0\"`. (#378, #445, #450)"
          ]
        },
        {
          title: "One responsive workspace replaces app modes",
          points: [
            "The old app-mode setting is removed during the upgrade; other settings are retained. (#255)"
          ]
        },
        {
          title: "Shell sandboxing and extension confinement have separate settings",
          points: [
            "Shell sandboxing covers commands and the workspace terminal. Extension confinement covers workers, processes, hooks and MCP stdio servers.",
            "An enabled old setting migrates to both settings enabled; a disabled one leaves both disabled. Scripts that used `AVE_SANDBOX_ENABLED=1` to confine extensions must also set `AVE_PLUGIN_WORKER_CONFINEMENT=1`. (#14)"
          ]
        },
        {
          title: "Windows shell local-network access defaults to OFF",
          points: [
            "Find it in Settings → Permissions. When off, each command uses the approved-host route. When on, supported PCs can run shells in containers, but commands can accept connections from the local network and loopback.",
            "Changes apply to the next command without restarting. Extension confinement retains its separate network policy. (#560)"
          ]
        },
        {
          title: "Uninstalling on Windows keeps your data",
          points: [
            "Chats, settings, memories, credentials and extension data survive interactive and silent uninstall, as well as updates. There is no data-deletion question; reinstalling can reuse the retained data. (#552, #556)"
          ]
        },
        {
          title: "Korean UI and color schemes are built in",
          points: [
            "The marketplace Korean language pack is withdrawn. Theme packages are replaced by built-in color schemes.",
            "Existing appearance settings migrate to the new schemes. Language and UI fonts are retained; code and terminal fonts start from the defaults. (#449, #483)"
          ]
        }
      ]
    },
    {
      kind: "h3",
      text: "New features"
    },
    {
      kind: "list",
      items: [
        {
          title: "The workspace adapts to the window width",
          points: [
            "Narrow windows show the focused tile and hide split, close, maximize and new-tile controls. Hidden conversations keep running; widening the window restores the layout.",
            "The sidebar remembers expanded, icons-only or hidden state. The sidebar and work panel can overlay the content without resizing the OS window. (#255)"
          ]
        },
        {
          title: "Conversations, terminals and pages share the project tree",
          points: [
            "Delegated conversations appear beneath their parents. Preview items or open folders to browse files, with syntax colors, line numbers and file information for code.",
            "Project removal shows which work will stop and can be undone. (#311, #413, #424, #425, #427, #432, #544)"
          ]
        },
        {
          title: "Each browser or terminal panel can keep its own conversation",
          points: [
            "Panel conversations and selections are restored. When you take over the browser, the agent waits until you explicitly resume it. File uploads and drag gestures are supported. (#23, #61, #78, #157)"
          ]
        },
        {
          title: "Preview documents and tables inside the app",
          points: [
            "Read-only previews cover CSV, TSV, XLSX, XLS and ODS tables, PDFs, presentations and document outlines.",
            "An optional document engine, installed during onboarding or from document settings, adds page conversion and formula recalculation. Watch the agent work in documents, browsers and terminals as it happens. (#199, #224, #254, #278, #284, #285, #288)"
          ]
        },
        {
          title: "Follow and steer work from the work board",
          points: [
            "See stages, elapsed time and descriptions; send further instructions or stop running work; jump to the related conversation or tool approval. The board no longer limits the number of items. (#393, #394, #396, #398, #412)"
          ]
        },
        {
          title: "Project attention requests gather in one place",
          points: [
            "Handle proposals, plan approvals and failed routines together, with outstanding requests shown in the title bar. The notification center keeps history and withdraws approvals already handled. (#402, #403, #408, #421, #426, #491, #528, #529)"
          ]
        },
        {
          title: "Manage schedules in day, week and month views",
          points: [
            "Edit or pause project schedules and display them on the work board. Manage the next run of a conversation-linked schedule and see run time and token usage. (#406, #417, #419, #422, #429, #434)"
          ]
        },
        {
          title: "See where memories came from and how they were used",
          points: [
            "Review sources, changes and use in answers. Edit a memory or undo its save from the result. The default project's memories are separate from global memories. (#395, #397, #399, #400, #410, #414, #416, #435)"
          ]
        },
        {
          title: "Review file changes by hunk and rewind conversations",
          points: [
            "Review or undo the last turn's changes, or restore files when rewinding the conversation. Running work and completed tool results are saved continuously for recovery after an unexpected exit. (#47, #171, #259)"
          ]
        },
        {
          title: "Choose queue order and a separate compaction model",
          points: [
            "Reorder waiting messages, control running commands and choose a model for compaction. Provider settings are built in; installed subscription CLIs can be discovered and connected, with the actual model and billing route shown.",
            "Sign in to remote MCP servers from Settings. (#49, #122, #156, #231, #257, #265, #280)"
          ]
        },
        {
          title: "Capture web pages into conversations",
          points: [
            "Capture an element, a selected area or the full content. Preview hidden agent tabs or watch them in a small floating window. (#364, #476, #537, #538)"
          ]
        },
        {
          title: "Customize colors, fonts, shortcuts and notification sounds",
          points: [
            "Adjust glass tint and chat, code and terminal fonts, remap shortcuts, and choose accessibility sounds for completion, interruption and approval requests. (#449, #473, #518, #522, #523, #526, #555)"
          ]
        }
      ]
    },
    {
      kind: "h3",
      text: "Permissions and security"
    },
    {
      kind: "list",
      items: [
        {
          title: "Consistent approval choices and remembered scopes",
          points: [
            "Choose a permission reviewer model. Allow writes and `auto` modes admit recoverable project file changes without repeated approval, while file and executable identity checks and sensitive control-file protection remain in force. (#184, #217, #223, #261, #312, #315)"
          ]
        },
        {
          title: "Stronger shell, network and protected-path checks",
          points: [
            "Command aliases, path aliases and links cannot bypass checks. Home content whose trust cannot be established must be approved or removed in Settings. Permission-rule and audit-record ordering is corrected. (#387, #442, #443, #444, #487, #489, #490, #492)"
          ]
        },
        {
          title: "Stronger Windows process teardown and permission revocation",
          points: [
            "Extension, worker, hook and MCP server resources are not reused before process exit is confirmed. Failed permission revocation blocks the affected session. (#345, #351, #368, #371, #376, #379, #505, #517)"
          ]
        },
        {
          title: "Browser approvals stay bound to the requesting conversation, site and action",
          points: [
            "Agent control is withdrawn when you interact or the connection ends; project removal cancels pending work. Browser and terminal file-upload consent is also strengthened. (#262, #277, #458, #486, #530, #534, #542, #543)"
          ]
        }
      ]
    },
    {
      kind: "h3",
      text: "For extension developers"
    },
    {
      kind: "list",
      items: [
        {
          title: "Loopback OAuth requires host-issued state and PKCE S256",
          points: [
            "Send the single-use `state` returned by `authRedirect.open()` unchanged. Missing or altered state and replays are rejected. Migrate to the protocol-5 contract with `minAppVersion: \"0.15.0\"`."
          ]
        },
        {
          title: "Delegated workers communicate over standard streams instead of sockets",
          points: [
            "Each worker declares `output-only-v1` or `stdio-control-v1`; control-mode stdout is reserved for JSON-RPC frames. `udsArgName` and `socketPath` are removed.",
            "Ask the plugin to perform network work through `hostFetch`, and request a private worker state directory with `stateDirectory: true`. Pending calls end with the worker's termination reason and are not replayed. (#378)"
          ]
        },
        {
          title: "Extension UI uses MCP App resources",
          points: [
            "The old dedicated UI bridge, unused HostApi members and cross-extension event grants are removed. Re-vendor public types and the manifest, protocol and worker schemas from v0.15.0; changing only the version declarations is insufficient.",
            "Copy the new contract from the repository tag instead of a signed contract bundle. (#445, #450)"
          ]
        }
      ]
    },
    {
      kind: "h3",
      text: "Fixes"
    },
    {
      kind: "list",
      items: [
        {
          title: "Separate compaction models work with subscription connections",
          points: [
            "Compaction cancellation, credential scope and login and connection status displays are corrected. (#367, #392, #554)"
          ]
        },
        {
          title: "Conversation, tab and window restoration is steadier",
          points: [
            "Conversation ordering, titles, hidden-tile selection, terminal and web tabs, main-window changes and side-chat links are corrected. The opening screen uses the saved language. (#282, #307, #309, #354, #356, #357, #372, #377, #405, #496, #527)"
          ]
        },
        {
          title: "Browser input, capture and file previews are corrected",
          points: [
            "Address input, clicks and capture have fewer focus races; table quoting and calendar month boundaries are corrected. Browser reads avoid unnecessary waits, and file search continues past unreadable subfolders. (#222, #341, #415, #478, #537, #538, #541, #559)"
          ]
        },
        {
          title: "Terminal commands show warnings for files the agent changed",
          points: [
            "Changed-file warnings appear beside command output, and user input is distinguished from agent input. Windows terminals prefer an installed PowerShell 7. (#302, #306, #308, #314)"
          ]
        },
        {
          title: "Windows installation, startup and removal are steadier",
          points: [
            "App-exit checks, installer residue, terminal cleanup and sandbox preparation races are corrected. Packaging no longer requires the absent `dxil.dll` runtime file. (#352, #353, #551, #553, #556)"
          ]
        }
      ]
    }
  ],
  "v0.14.0": [{ kind: "list", items: [
    {
      title: "Ave’s website and distribution addresses",
      points: ["The website is `ave.agent-connector.ai`; downloads and updates come from `downloads.agent-connector.ai`."],
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
      title: "A signed contract bundle to download and verify",
      points: [
        "Each release publishes, at `https://downloads.agent-connector.ai/contract/v0.14.0/`, the plugin contract source, the manifest schema, the protocol 3 schema, the marketplace checker and the agent-plugin component extractor, with `bundle.json`, `SHA256SUMS` and its Sigstore signature.",
        "The release workflow makes the signature, so extension authors and marketplaces can check manifests and the protocol with this bundle, without Ave’s source.",
        "A tag’s files never change once published. (#113)",
      ],
    },
    {
      title: "Plugin contract identifiers moved to the Ave domain",
      points: [
        "Ave-specific `plugin.json` fields live under `extensions[\"ai.agent-connector.ave\"]`; a package’s prompt, agent, hook and routine files go in an `ai.agent-connector.ave/` folder.",
        "A skill package’s `$schema` is `https://ave.agent-connector.ai/schemas/skill/1/skill.schema.json`; the manifest and marketplace schemas are published under `https://ave.agent-connector.ai/schemas/plugin/3/` and `https://ave.agent-connector.ai/schemas/marketplace/2/`.",
        "The earlier address (`sdk.former-site.invalid`) is not recognised.",
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
        "The agent reads terminal output in the same window with `terminal_read`, as untrusted data.",
        "On macOS a sandboxed terminal shell controls only its own terminal device, so commands are not echoed twice, job control such as Ctrl-Z and `fg` works, and other terminal windows are out of reach. (#59, #106)",
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
      title: "Terminal and web panels in the main area",
      points: [
        "Open terminal and web panels in the main area beside the chat, and move them between the side panel and the main area without reloading.",
        "Split the main area into up to four panels; move panels by dragging the header or with keyboard commands, maximise them, or reopen a closed one.",
        "The first window’s panel layout comes back on the next launch: terminals reopen in their last folder with a new shell, pages at their last address.",
        "The side chat works on the terminal or page last brought into view.",
        "A shell’s notification sequence (OSC 9, OSC 777) marks that terminal as asking for attention, and Cmd/Ctrl+Shift+U goes to it; inside a terminal, `AVE_TERMINAL_ID` names its own tab. (#104)",
      ],
    },
    {
      title: "The agent works browser pages directly",
      points: [
        "In the conversation’s window, the agent reads side-panel and main-area web pages (`browser_snapshot`, `browser_screenshot`) and clicks, types, presses keys, navigates, and opens and closes tabs.",
        "Page content reaches it as untrusted data, and it never types into password, payment card or verification code fields.",
        "Actions that change a page ask on an approval card, and a tab you opened asks per site even to read it; approvals last until Ave restarts, per site or within the tabs the agent opened, and page-changing actions in a tab you opened ask every time.",
        "Tabs and panels the agent opened carry a marker and a stop button; clicking or typing in the page yourself stops pending actions, and navigating with the address bar, back, forward or reload ends the agent’s control.",
        "Routines and headless runs do not use the browser tools. (#102, #114)",
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
    {
      title: "Cost chip and audit statistics fixed",
      points: [
        "The cost chip of a model without price information says “pricing unknown” instead of “TBD”.",
        "The Audit tab in Settings counts permission records by decision, such as allowed or denied, and its top types no longer show `undefined`. (#106)",
      ],
    },
  ] }],
};

export interface EnRelease {
  blocks: (
    | { kind: "h3"; text: Inline[] }
    | { kind: "list"; items: { title: Inline[]; points: Inline[][] }[] }
  )[];
}

/** The English notes for one release; fails the build if they are missing or out of step with CHANGELOG.md. */
export function englishRelease(r: Release): EnRelease {
  const blocks = EN[r.name];
  if (!blocks) throw new Error(`lib/changelog-en.ts has no English notes for ${r.name}`);
  if (blocks.length !== r.blocks.length) {
    throw new Error(`lib/changelog-en.ts: ${r.name} has ${blocks.length} blocks, CHANGELOG.md has ${r.blocks.length}`);
  }
  return { blocks: blocks.map((block, index) => {
    const source = r.blocks[index]!;
    if (block.kind === "h3" && source.kind === "h3") {
      return { kind: "h3", text: inline(block.text) };
    }
    if (block.kind === "list" && source.kind === "list") {
      if (block.items.length !== source.items.length) {
        throw new Error(`lib/changelog-en.ts: ${r.name} block ${index + 1} has ${block.items.length} items, CHANGELOG.md has ${source.items.length}`);
      }
      return {
        kind: "list",
        items: block.items.map((it) => ({ title: inline(it.title), points: it.points.map((p) => inline(p)) })),
      };
    }
    throw new Error(`lib/changelog-en.ts: ${r.name} block ${index + 1} is ${block.kind}, CHANGELOG.md has ${source.kind}`);
  }) };
}

/** Releases with English notes that CHANGELOG.md does not list: a stale entry here. */
export function staleEnglishNotes(names: string[]): string[] {
  return Object.keys(EN).filter((n) => !names.includes(n));
}
