import type { ChatThemePreference, ResolvedTheme } from "./types.js";
import type { AveTokenName } from "@ave/plugin-sdk/ui/tokens";

// Derives the full set of --ave-* CSS custom properties from the current
// (resolved shell theme, chat theme) combination. Values are literal HSL
// strings so plugins can apply them without needing any of the host's
// --p-* palette or var() chain. The mapping mirrors src/styles.css exactly;
// update both files when adding a new theme.
const _H = (h: number, s: number, l: number) => `hsl(${h}, ${s}%, ${l}%)`;

// Theme-invariant tokens — same across dark/light/HC.
// Not sent separately; spread into every base map at resolve time.
const _INVARIANT: Record<string, string> = {
  "--ave-radius-xs":       "0.15rem",
  "--ave-radius-lg":       "0.75rem",
  "--ave-radius-full":     "9999px",
  "--ave-text-xs":         "0.75rem",
  "--ave-text-sm":         "0.875rem",
  "--ave-text-base":       "1rem",
  "--ave-text-lg":         "1.125rem",
  "--ave-weight-normal":   "400",
  "--ave-weight-medium":   "500",
  "--ave-weight-semibold": "600",
  "--ave-space-1":         "0.25rem",
  "--ave-space-2":         "0.5rem",
  "--ave-space-3":         "0.75rem",
  "--ave-space-4":         "1rem",
  "--ave-motion-fast":     "150ms",
  "--ave-motion-normal":   "200ms",
};

const _DARK_BASE: Record<string, string> = {
  "--ave-bg":              _H(222.2, 84,   4.9),
  "--ave-surface":         _H(222.2, 84,   7  ),
  "--ave-surface-overlay": _H(222.2, 60,   10 ),
  "--ave-fg":              _H(210,   40,  98  ),
  "--ave-fg-muted":        _H(215,   20,  65  ),
  "--ave-fg-disabled":     _H(215,   16,  40  ),
  "--ave-primary":         _H(217.2, 91.2,59.8),
  "--ave-primary-fg":      _H(210,   40,  98  ),
  "--ave-secondary":       _H(217,   33,  17  ),
  "--ave-secondary-fg":    _H(210,   40,  98  ),
  "--ave-danger":          _H(0,     62.8,30.6),
  "--ave-danger-fg":       _H(210,   40,  98  ),
  "--ave-warning":         _H(48,    97,  77  ),
  "--ave-warning-fg":      _H(30,    80,  25  ),
  "--ave-success":         _H(142,   71,  45  ),
  "--ave-success-fg":      _H(210,   40,  98  ),
  "--ave-border":          _H(217,   33,  17  ),
  "--ave-ring":            _H(224.3, 76.3,48  ),
  "--ave-radius":          "0.6rem",
  "--ave-radius-sm":       "0.25rem",
};

const _LIGHT_BASE: Record<string, string> = {
  "--ave-bg":              _H(0,     0,  100  ),
  "--ave-surface":         _H(0,     0,  100  ),
  "--ave-surface-overlay": _H(220,   9,   90  ),
  "--ave-fg":              _H(222,   47,  11  ),
  "--ave-fg-muted":        _H(215,   16,  47  ),
  "--ave-fg-disabled":     _H(215,   16,  65  ),
  "--ave-primary":         _H(224.3, 76.3,48  ),
  "--ave-primary-fg":      _H(210,   40,  98  ),
  "--ave-secondary":       _H(210,   40,  96  ),
  "--ave-secondary-fg":    _H(222,   47,  11  ),
  "--ave-danger":          _H(0,     84,  60  ),
  "--ave-danger-fg":       _H(210,   40,  98  ),
  "--ave-warning":         _H(48,    96,  89  ),
  "--ave-warning-fg":      _H(30,    80,  25  ),
  "--ave-success":         _H(142,   71,  45  ),
  "--ave-success-fg":      _H(210,   40,  98  ),
  "--ave-border":          _H(214,   32,  91  ),
  "--ave-ring":            _H(217.2, 91.2,59.8),
  "--ave-radius":          "0.6rem",
  "--ave-radius-sm":       "0.25rem",
};

const _HC_BASE: Record<string, string> = {
  "--ave-bg":              _H(0,   0,   0  ),
  "--ave-surface":         _H(0,   0,   0  ),
  "--ave-surface-overlay": _H(0,   0,  10  ),
  "--ave-fg":              _H(0,   0, 100  ),
  "--ave-fg-muted":        _H(0,   0,  80  ),
  "--ave-fg-disabled":     _H(0,   0,  50  ),
  "--ave-primary":         _H(60, 100,  50  ),
  "--ave-primary-fg":      _H(0,   0,   0  ),
  "--ave-secondary":       _H(0,   0,  15  ),
  "--ave-secondary-fg":    _H(0,   0, 100  ),
  "--ave-danger":          _H(0, 100,  50  ),
  "--ave-danger-fg":       _H(0,   0, 100  ),
  "--ave-warning":         _H(48, 100,  50  ),
  "--ave-warning-fg":      _H(0,   0,   0  ),
  "--ave-success":         _H(120, 100,  40  ),
  "--ave-success-fg":      _H(0,   0,   0  ),
  "--ave-border":          _H(0,   0, 100  ),
  "--ave-ring":            _H(60, 100,  50  ),
  "--ave-radius":          "0.6rem",
  "--ave-radius-sm":       "0.25rem",
};

// Accent tokens that override any shell base for ACME brand theme.
// Spread AFTER surface so ACME-red danger and vivid-purple primary
// always win even if a surface map accidentally defines them.
const _ACME_ACCENT: Record<string, string> = {
  "--ave-primary":     _H(253, 100, 65),   // #734dff vivid purple SEND
  "--ave-primary-fg":  _H(0,     0, 100),
  "--ave-ring":        _H(263,  70,  50),   // p-purple-600
  "--ave-danger":      _H(1,    98,  59),   // #FD312E ACME red
  "--ave-danger-fg":   _H(0,     0, 100),
};

const _ACME_LIGHT_SURFACE: Record<string, string> = {
  "--ave-bg":           _H(40,  25,  92),   // Grey-6 #F0ECE4
  "--ave-surface":      _H(44,  37,  94),   // Grey-7 #F6F3EB
  "--ave-fg":           _H(0,    0,  15),   // Grey-1 #262626
  "--ave-fg-muted":     _H(43,   3,  43),   // Grey-3 #716F6A
  "--ave-secondary":    _H(44,  37,  94),
  "--ave-secondary-fg": _H(0,    0,  15),
  "--ave-border":       _H(40,  10,  78),   // Grey-4 #CBC8C2
};

const _ACME_DARK_SURFACE: Record<string, string> = {
  "--ave-bg":           _H(0,    0,  15),   // Grey-1 #262626
  "--ave-surface":      _H(0,    0,  18),
  "--ave-fg":           _H(44,  37,  94),   // Grey-7 #F6F3EB
  "--ave-fg-muted":     _H(40,   5,  60),
  "--ave-secondary":    _H(0,    0,  20),
  "--ave-secondary-fg": _H(44,  37,  94),
  "--ave-border":       _H(0,    0,  28),
};

export function resolvePluginTokens(
  theme: ResolvedTheme,
  chatTheme: ChatThemePreference,
): Record<AveTokenName, string> {
  const base = theme === "light" ? _LIGHT_BASE : theme === "high-contrast" ? _HC_BASE : _DARK_BASE;
  // HC locks primary/ring to yellow; no chat-theme overlay applies.
  if (theme === "high-contrast") return { ..._INVARIANT, ...base } as Record<AveTokenName, string>;
  switch (chatTheme) {
    case "lg": {
      const surface = theme === "dark" ? _ACME_DARK_SURFACE : _ACME_LIGHT_SURFACE;
      // surface first, then accent — accent must always win (ACME red, vivid purple).
      return { ..._INVARIANT, ...base, ...surface, ..._ACME_ACCENT } as Record<AveTokenName, string>;
    }
    case "purple":
      return { ..._INVARIANT, ...base, "--ave-primary": _H(262, 83, 58), "--ave-primary-fg": _H(0, 0, 100), "--ave-ring": _H(263, 70, 50) } as Record<AveTokenName, string>;
    case "orange":
      return theme === "dark"
        ? { ..._INVARIANT, ...base, "--ave-primary": _H(25, 95, 53), "--ave-primary-fg": _H(0, 0, 100), "--ave-ring": _H(21, 90, 48) } as Record<AveTokenName, string>
        : { ..._INVARIANT, ...base, "--ave-primary": _H(21, 90, 48), "--ave-primary-fg": _H(0, 0, 100), "--ave-ring": _H(25, 95, 53) } as Record<AveTokenName, string>;
    case "blue":
      return theme === "dark"
        ? { ..._INVARIANT, ...base, "--ave-primary": _H(217.2, 91.2, 59.8), "--ave-ring": _H(224.3, 76.3, 48) } as Record<AveTokenName, string>
        : { ..._INVARIANT, ...base, "--ave-primary": _H(224.3, 76.3, 48), "--ave-ring": _H(217.2, 91.2, 59.8) } as Record<AveTokenName, string>;
    default:   // "default" — no overlay
      return { ..._INVARIANT, ...base } as Record<AveTokenName, string>;
  }
}
