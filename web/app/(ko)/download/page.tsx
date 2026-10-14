import type { Metadata } from "next";
import { Footer, Header } from "@/components/chrome";
import { DownloadPage } from "@/components/pages";

export const metadata: Metadata = {
  title: "내려받기",
  alternates: { canonical: "/download/", languages: { ko: "/download/", en: "/en/download/" } },
};

export default function Page() {
  return (
    <>
      <Header locale="ko" path="/download/" />
      <DownloadPage locale="ko" />
      <Footer locale="ko" path="/download/" />
    </>
  );
}
