import type { SearchEntry } from "./search-index";

export const searchEntriesEn: SearchEntry[] = [
  // Getting Started
  { group: "Getting Started", href: "/en/docs/", title: "Ave AI Overview", snippet: "Desktop host · extension runtime · storage · server, 4 layers", keywords: ["overview", "intro"] },
  { group: "Getting Started", href: "/en/docs/getting-started/install", title: "Install & First Launch", snippet: "macOS arm64 / Windows / Linux AppImage · electron-updater · ave:// registration" },
  { group: "Getting Started", href: "/en/docs/getting-started/login", title: "Login & First Screen", snippet: "No Ave account · per-extension OAuth · private marketplace token", keywords: ["sso", "auth", "oauth", "token"] },
  { group: "Getting Started", href: "/en/docs/getting-started/updates", title: "App Updates", snippet: "electron-updater · autoDownload=false · 4h interval · channel=latest" },

  // Host · Chat
  { group: "Chat", href: "/en/docs/chat/layout", title: "Chat Screen Layout", snippet: "App · Sidebar · MainToolbar · PaneFrame tiles · ChatGroupSession · ChatView" },
  { group: "Chat", href: "/en/docs/chat/message-queue", title: "Message Queue & Tasks", snippet: "MessageQueuePanel + SessionTasksPanel · above the composer · hidden when empty" },
  { group: "Chat", href: "/en/docs/chat/tool-thinking", title: "Tool & Thinking Display", snippet: "Tool Registry · three sources · background shell · view image · tool search" },
  { group: "Chat", href: "/en/docs/chat/question-cards", title: "Question Cards", snippet: "AskUserQuestionItem · choice-only · choice/choices · recommendedIndex · altIndices" },
  { group: "Chat", href: "/en/docs/chat/plugin-panel", title: "Extension Panel", snippet: "manifest ui[] slots · bundled Skills · pure Tools · regex ^[a-zA-Z_][a-zA-Z0-9_]*$" },
  { group: "Chat", href: "/en/docs/chat/permissions/directory", title: "Permissions — Directory", snippet: "storage sandbox + host grant · ~/.ave/permissions.json (0o600)" },
  { group: "Chat", href: "/en/docs/chat/permissions/llm-review", title: "Permissions — LLM Autonomous Review", snippet: "Reviewer 4 modes: disabled/rule/llm/strict" },
  { group: "Chat", href: "/en/docs/chat/permissions/risk", title: "Permissions — Risk Management", snippet: "RiskLevel low/medium/high × 5 categories grid · agentApproval" },

  // Host Features
  { group: "Host Features", href: "/en/docs/host/skills", title: "Skills — Ability Packs", snippet: "Invoke frequent tasks with one line. Trigger keywords + tool mapping + risk level", keywords: ["skill", "skills", "keyword", "keywords"] },
  { group: "Host Features", href: "/en/docs/host/agents", title: "Agents — Small Units of Work", snippet: "An autonomous unit that does one task well. Agents spawn sub-agents and resume them", keywords: ["agent", "agents", "subagent"] },
  { group: "Host Features", href: "/en/docs/host/memory", title: "MEMORY — Remembering What You Told It", snippet: "Role · preferences · constraints. Automatic capture is off by default; project AGENTS.md is read too", keywords: ["memory", "AGENTS.md"] },
  { group: "Host Features", href: "/en/docs/host/mcp", title: "MCP — Bringing In External Tools", snippet: "A server's tools, resources, prompts and instructions. External tools are filtered out of risk-band auto-allow into a confirmation card", keywords: ["mcp", "external tools", "resource", "prompt"] },
  { group: "Host Features", href: "/en/docs/host/onboarding", title: "Onboarding — First-Run Guide", snippet: "Six-step guide on first launch + dims the screen and highlights its target + skippable", keywords: ["onboarding", "tour", "start"] },
  { group: "Host Features", href: "/en/docs/host/trust-security", title: "Trust & Security", snippet: "Source verification · version withdrawal · load-failure cards · secrets · audit log · no-fallback · connections the app opens", keywords: ["trust", "security", "audit", "network", "privacy", "models.dev", "model catalog"] },
  { group: "Host Features", href: "/en/docs/host/integration-recipes", title: "Integration Recipes — Combined Scenarios", snippet: "Meeting → action → schedule → reply · research → presentation · video call → minutes → team board", keywords: ["recipe", "integration", "scenario"] },

  // Routines
  { group: "Routines", href: "/en/docs/routines/overview", title: "Routine Registration & Trigger Flow", snippet: "RoutineEngine · triggers shutdown | schedule · per-fire fresh loop" },
  { group: "Routines", href: "/en/docs/routines/meeting-end", title: "Meeting End → Automatic Task", snippet: "meeting.summary.created → subscribed extension card" },

  // Plugins
  { group: "Extensions", href: "/en/docs/plugins", title: "Extensions — Overview", snippet: "static manifest · tools declared in the manifest · tool list fixed per server generation" },
  { group: "Extensions", href: "/en/docs/plugins/permission-grant", title: "Permission Grant Flow", snippet: "capabilities · tools[] · pluginAccess · agentApprovalScopes" },
  { group: "Extensions", href: "/en/docs/plugins/local-indexer", title: "Local Indexer", snippet: "kiwipiepy Pattern B · pymupdf4llm · FTS5 + LanceDB · chokidar · RRF (K=60)", keywords: ["RAG", "rrf", "fts5", "kiwi"] },
  { group: "Extensions", href: "/en/docs/plugins/meeting", title: "Meeting (Recording)", snippet: "OpenAI Whisper · PCM16LE 16kHz/3sec · 18 tools · meeting.ended", keywords: ["stt", "whisper", "audio"] },

  // Marketplace
  { group: "Marketplace", href: "/en/docs/marketplace", title: "Marketplace", snippet: "git repository marketplaces · official/managed/custom/direct sources · installs pinned to a commit · ave://install", keywords: ["marketplace", "git", "install"] },
  { group: "Marketplace", href: "/en/docs/marketplace/folders", title: "Folder Sources", snippet: "Choose folder… · local, removable, cloud-synced and network folders · Local folder badge · installs what you reviewed", keywords: ["folder", "share", "usb", "onedrive", "network"] },
  { group: "Marketplace", href: "/en/docs/marketplace/warnings", title: "Warnings and Policy", snippet: "Before Ave connects · http · internal network · this computer · internal downloads · requireHttps · blockPrivateNetworks · allowLocalSources", keywords: ["http", "warning", "policy", "internal", "private network"] },
  { group: "Marketplace", href: "/en/docs/marketplace/updates", title: "Automatic Updates", snippet: "start-up and daily checks · applied when the conversation pauses · why an update waits · switches per source and package · required packages", keywords: ["update", "automatic", "auto-update", "required", "skip"] },
  { group: "Marketplace", href: "/en/docs/marketplace/troubleshooting", title: "Marketplace Troubleshooting", snippet: "address, folder, policy and update messages with what to do · Copy details", keywords: ["error", "troubleshooting", "refused", "failed"] },
  { group: "Marketplace", href: "/en/docs/marketplace/authors", title: "Package Author Guide", snippet: "marketplace.json · ave-package.json · release/archive/tree · yanked · revocations.json", keywords: ["publish", "package"] },

  // Architecture
  { group: "Architecture", href: "/en/docs/architecture/overview", title: "System at a Glance", snippet: "4 layers · extensions · ~/.ave · servers" },
  { group: "Architecture", href: "/en/docs/architecture/diagrams", title: "Diagrams (Stack · Flow · Decisions)", snippet: "Stack · data flow · permission decision tree · extension lifecycle SVG", keywords: ["diagram", "visual", "topology"] },
  { group: "Architecture", href: "/en/docs/architecture/host-api", title: "HostApi Contract", snippet: "PluginHostApi surface · child-process boundary · asynchronous secret lookup", keywords: ["hostapi", "isolation", "process"] },
  { group: "Architecture", href: "/en/docs/architecture/storage", title: "Storage — ~/.ave", snippet: "Domain namespace · 0o700 dir · 0o600 file · audit/<YYYY-MM-DD>.jsonl" },
  { group: "Architecture", href: "/en/docs/architecture/permissions", title: "Permission Model", snippet: "Risk × category × 4 review modes · a sub-agent's asks go to its parent first", keywords: ["permissions", "subagent", "adjudication"] },

  // Roadmap
  { group: "Roadmap", href: "/en/docs/roadmap", title: "Vision & Evolution (v1–v4)", snippet: "Connector · sub-agent · idle utilization · Capability Pack · automation triggers · Hooks", keywords: ["roadmap", "future", "vision", "hook", "sub-agent"] },
];
