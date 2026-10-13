import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Ave AI User Guide",
    template: "%s · Ave AI Docs",
  },
};

export default function EnDocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
