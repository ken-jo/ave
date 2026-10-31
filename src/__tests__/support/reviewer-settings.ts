export function reviewerSettings() {
  return {
    mode: "llm" as const,
    fallbackOnError: "deny" as const,
  };
}
