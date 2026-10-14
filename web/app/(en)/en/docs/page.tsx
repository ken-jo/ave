import type { Metadata } from "next";
import { Footer, Header } from "@/components/chrome";
import { DocsIndex } from "@/components/pages";

export const metadata: Metadata = {
  title: "Docs",
  alternates: { canonical: "/en/docs/", languages: { ko: "/docs/", en: "/en/docs/" } },
};

export default function Page() {
  return (
    <>
      <Header locale="en" path="/docs/" />
      <DocsIndex locale="en" />
      <Footer locale="en" path="/docs/" />
    </>
  );
}
