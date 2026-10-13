import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Ave 사용자 가이드",
    template: "%s · Ave Docs",
  },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
