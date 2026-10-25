import type { Metadata } from "next";
import { FeatureView } from "@/components/feature";
import { featurePage } from "@/lib/features";

const meta = featurePage("ko", "browser").meta;

export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: "/browser/", languages: { ko: "/browser/", en: "/en/browser/" } },
};

export default function Page() {
  return <FeatureView locale="ko" feature="browser" />;
}
