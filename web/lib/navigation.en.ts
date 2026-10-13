import type { NavGroup } from "./navigation";

export const navigationEn: NavGroup[] = [
  {
    title: "Getting Started",
    eyebrow: "Getting Started",
    items: [
      { title: "Ave Overview", href: "/en/docs/" },
      { title: "Install & First Run", href: "/en/docs/getting-started/install" },
      { title: "Login & First Screen", href: "/en/docs/getting-started/login" },
      { title: "App Updates", href: "/en/docs/getting-started/updates" },
    ],
  },
  {
    title: "Desktop Chat",
    eyebrow: "Host · Chat",
    items: [
      { title: "Chat Screen Layout", href: "/en/docs/chat/layout" },
      { title: "Message Queue & Tasks", href: "/en/docs/chat/message-queue" },
      { title: "Tool & Thinking Display", href: "/en/docs/chat/tool-thinking" },
      { title: "Question Cards", href: "/en/docs/chat/question-cards" },
      { title: "Extension Panel", href: "/en/docs/chat/plugin-panel" },
      { title: "Permissions — Directory", href: "/en/docs/chat/permissions/directory" },
      { title: "Permissions — LLM Auto-review", href: "/en/docs/chat/permissions/llm-review" },
      { title: "Permissions — Risk Management", href: "/en/docs/chat/permissions/risk" },
    ],
  },
  {
    title: "Host Features",
    eyebrow: "Host Features",
    items: [
      { title: "Skills — Ability Bundles", href: "/en/docs/host/skills", badge: "NEW" },
      { title: "Agents — Small Units of Work", href: "/en/docs/host/agents", badge: "NEW" },
      { title: "MEMORY — What It Learned", href: "/en/docs/host/memory", badge: "NEW" },
      { title: "MCP — Bringing In External Tools", href: "/en/docs/host/mcp", badge: "NEW" },
      { title: "Onboarding — Getting Started Guide", href: "/en/docs/host/onboarding", badge: "NEW" },
      { title: "Trust & Security", href: "/en/docs/host/trust-security", badge: "NEW" },
      { title: "Extension Combination Recipes", href: "/en/docs/host/integration-recipes", badge: "NEW" },
    ],
  },
  {
    title: "Routines & Workflows",
    eyebrow: "Routines",
    items: [
      { title: "Routine Setup & Trigger Flow", href: "/en/docs/routines/overview" },
      { title: "Meeting End → Automatic Tasks", href: "/en/docs/routines/meeting-end" },
    ],
  },
  {
    title: "Extensions",
    eyebrow: "Extensions",
    items: [
      { title: "What Is an Extension?", href: "/en/docs/plugins" },
      { title: "Permission Grant Flow", href: "/en/docs/plugins/permission-grant" },
      { title: "Local Indexer", href: "/en/docs/plugins/local-indexer", badge: "RAG" },
      { title: "Meeting (Recording)", href: "/en/docs/plugins/meeting" },
    ],
  },
  {
    title: "Marketplace",
    eyebrow: "Marketplace",
    items: [
      { title: "Marketplace", href: "/en/docs/marketplace" },
      { title: "Folder Sources", href: "/en/docs/marketplace/folders" },
      { title: "Warnings and Policy", href: "/en/docs/marketplace/warnings" },
      { title: "Automatic Updates", href: "/en/docs/marketplace/updates" },
      { title: "Troubleshooting", href: "/en/docs/marketplace/troubleshooting" },
      { title: "Package Author Guide", href: "/en/docs/marketplace/authors" },
    ],
  },
  {
    title: "Architecture",
    eyebrow: "Architecture",
    items: [
      { title: "System Overview", href: "/en/docs/architecture/overview" },
      { title: "Diagrams (Stack · Flow)", href: "/en/docs/architecture/diagrams", badge: "NEW" },
      { title: "HostApi Contract", href: "/en/docs/architecture/host-api" },
      { title: "Storage — ~/.ave", href: "/en/docs/architecture/storage" },
      { title: "Permission Model", href: "/en/docs/architecture/permissions" },
    ],
  },
  {
    title: "Roadmap",
    eyebrow: "Roadmap",
    items: [
      { title: "Vision & Evolution", href: "/en/docs/roadmap", badge: "NEW" },
    ],
  },
];
