import type { Metadata } from "next";
import { FeatureView } from "@/components/feature";
import { featurePage } from "@/lib/features";

const meta = featurePage("en", "models").meta;

export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: "/en/models/", languages: { ko: "/models/", en: "/en/models/" } },
};

export default function Page() {
  return <FeatureView locale="en" feature="models" />;
}
