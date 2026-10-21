import type { Metadata } from "next";
import { FeatureView } from "@/components/feature";
import { featurePage } from "@/lib/features";

const meta = featurePage("en", "browser").meta;

export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: "/en/browser/", languages: { ko: "/browser/", en: "/en/browser/" } },
};

export default function Page() {
  return <FeatureView locale="en" feature="browser" />;
}
