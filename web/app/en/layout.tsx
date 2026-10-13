import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Ave — Quiet about signals, clear about decisions",
    template: "%s · Ave",
  },
  description:
    "Ave reads signals from your mail, meetings, documents, and calendar on your own PC and turns them into one proposal when it matters. Write actions always start with your approval.",
  openGraph: {
    title: "Ave — Quiet about signals, clear about decisions",
    description: "Signals stay quiet; execution starts with your approval. Ave, the AI work host on your PC.",
    type: "website",
    siteName: "Ave",
  },
};

/** English tree — Korean stays at the root; <html lang> is ko, so mark the subtree. */
export default function EnLayout({ children }: { children: React.ReactNode }) {
  return <div lang="en">{children}</div>;
}
