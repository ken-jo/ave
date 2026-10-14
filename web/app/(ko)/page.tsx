import type { Metadata } from "next";
import { Footer, Header } from "@/components/chrome";
import { Home } from "@/components/home";

export const metadata: Metadata = { alternates: { canonical: "/", languages: { ko: "/", en: "/en/" } } };

export default function Page() {
  return (
    <>
      <Header locale="ko" path="/" over />
      <Home locale="ko" />
      <Footer locale="ko" path="/" />
    </>
  );
}
