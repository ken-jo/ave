import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Ave AI — Quiet observation, precise suggestions, your approval",
    template: "%s · Ave AI",
  },
  description:
    "Ave AI quietly observes signals from mail, meetings, documents, and calendars, and suggests only at the right moment. Write actions always start with your approval.",
  openGraph: {
    title: "Ave AI — Quiet observation, precise suggestions",
    description:
      "Signals stay quiet; execution starts with your approval. Ave, the desktop AI workspace.",
    type: "website",
    siteName: "Ave AI",
  },
};

/** English tree — Korean stays at the root; <html lang> is ko, so mark the subtree. */
export default function EnLayout({ children }: { children: React.ReactNode }) {
  return <div lang="en">{children}</div>;
}
