import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Ave AI 사용자 가이드",
    template: "%s · Ave AI Docs",
  },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
