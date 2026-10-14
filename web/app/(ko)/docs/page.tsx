import type { Metadata } from "next";
import { Footer, Header } from "@/components/chrome";
import { DocsIndex } from "@/components/pages";

export const metadata: Metadata = {
  title: "문서",
  alternates: { canonical: "/docs/", languages: { ko: "/docs/", en: "/en/docs/" } },
};

export default function Page() {
  return (
    <>
      <Header locale="ko" path="/docs/" />
      <DocsIndex locale="ko" />
      <Footer locale="ko" path="/docs/" />
    </>
  );
}
