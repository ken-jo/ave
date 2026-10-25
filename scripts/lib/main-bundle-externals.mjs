// Builds and child-entry smoke checks share this external boundary.
export const MAIN_BUNDLE_EXTERNALS = [
  "electron",
  "electron-updater",
  "better-sqlite3",
  // Keep native addons external so filesystem-relative binding resolution works.
  "node-pty",
  // The decoder resolves its native addon and codec libraries from real packages.
  "sharp",
  "@sentry/electron",
  "fsevents",
  // Worker-based logging resolves transport files from real packages; keep its dependency tree external.
  "pino",
  "pino-pretty",
  "thread-stream",
  "@pinojs/redact",
  "pino-abstract-transport",
  "pino-std-serializers",
  "sonic-boom",
  "quick-format-unescaped",
  "split2",
  "safe-stable-stringify",
  "process-warning",
  "real-require",
  "atomic-sleep",
  "on-exit-leak-free",
  // Keep sandbox runtime packages external and vendor binaries unpacked.
  // Bundling rewrites module-relative paths and breaks binary resolution.
  "@anthropic-ai/sandbox-runtime",
  // External telemetry modules preserve native conditional exports and one shared context registry.
  "@opentelemetry/api",
  "@opentelemetry/sdk-trace",
  "@opentelemetry/context-async-hooks",
  "@opentelemetry/resources",
  "@opentelemetry/exporter-trace-otlp-http",
];
