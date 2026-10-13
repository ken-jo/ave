import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Ave User Guide",
    template: "%s · Ave Docs",
  },
};

export default function EnDocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
