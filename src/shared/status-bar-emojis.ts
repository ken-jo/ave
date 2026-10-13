export const STATUS_BAR_RUNTIME_EMOJIS = {
  tools: "🔧",
  plugins: "🧩",
  mcps: "🔌",
} as const;

export const STATUS_BAR_OS_EMOJIS = {
  darwin: "🍎",
  win32: "🪟",
  linux: "🐧",
  fallback: "💻",
} as const;

export const STATUS_BAR_VENDOR_EMOJIS = {
  claude: "🟧",
  openai: "🟦",
  gemini: "🟢",
  azureFoundry: "🔷",
  vertexAi: "🟣",
  fallback: "🤖",
} as const;
