import type { Metadata } from "next";
import { Home } from "@/components/home";

export const metadata: Metadata = { alternates: { canonical: "/", languages: { ko: "/", en: "/en/" } } };

export default function Page() {
  return <Home locale="ko" />;
}
