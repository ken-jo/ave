// Keep launch flags dependency-free and importable before compilation.
// Each consumer owns its gating policy.

// Restricted Windows GPU drivers can crash before a window appears.
// AVE_KEEP_GPU=1 opts out of these flags.
export const WINDOWS_SAFE_GPU_FLAGS = Object.freeze([
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-gpu-compositing",
]);

// Windows launchers bypass sandbox initialization failures in restricted desktops.
// Packaged launches without those launchers keep the default protection.
export const SANDBOX_BYPASS_FLAG = "--no-sandbox";
