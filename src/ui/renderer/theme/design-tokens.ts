/** Shared shape, typography and motion values applied before paint and projected to embedded views. */
export const STATIC_DESIGN_TOKENS = {
  "--radius": "0.6rem", "--shape-radius-xs": "0.15rem", "--shape-radius-sm": "0.25rem",
  "--shape-radius-lg": "0.75rem", "--shape-radius-xl": "1rem", "--shape-radius-full": "9999px",
  "--type-size-12": "0.75rem", "--type-size-14": "0.875rem", "--type-size-16": "1rem",
  "--type-size-18": "1.125rem", "--type-size-20": "1.25rem", "--type-size-24": "1.5rem",
  "--type-size-30": "1.875rem", "--type-size-36": "2.25rem",
  "--type-leading-16": "1rem", "--type-leading-18": "1.125rem", "--type-leading-20": "1.25rem",
  "--type-leading-24": "1.5rem", "--type-leading-28": "1.75rem", "--type-leading-32": "2rem",
  "--type-leading-36": "2.25rem", "--type-leading-40": "2.5rem",
  // Dense steps are sized for the default 14px root (1rem = 14px), so they render 10px and 11px there
  // with the 1.5 line height those labels always had, and still follow the user's font-size scale.
  "--type-size-tiny": "0.7142857rem", "--type-leading-tiny": "1.0714286rem",
  "--type-size-dense": "0.7857143rem", "--type-leading-dense": "1.1785714rem",
  "--type-tracking-normal": "0em", "--type-tracking-wide": "0.015em",
  "--type-weight-normal": "400", "--type-weight-medium": "500", "--type-weight-semibold": "600", "--type-weight-bold": "700",
  "--space-1": "0.25rem", "--space-2": "0.5rem", "--space-3": "0.75rem", "--space-4": "1rem",
  "--motion-fast": "120ms", "--motion-normal": "180ms", "--motion-slow": "240ms", "--motion-layout": "300ms",
  "--motion-ease-out": "cubic-bezier(0.22, 1, 0.36, 1)",
  "--motion-ease-standard": "cubic-bezier(0.2, 0, 0, 1)", "--motion-ease-in-out": "cubic-bezier(0.4, 0, 0.2, 1)",
  "--border-width": "1px",
  "--shadow-sm-offsets": "0 1px 2px", "--shadow-md-offsets": "0 4px 12px",
  "--shadow-lg-offsets": "0 8px 24px", "--shadow-xl-offsets": "0 16px 48px",
} as const;
