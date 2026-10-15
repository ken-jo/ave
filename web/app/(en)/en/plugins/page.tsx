import type { Metadata } from "next";
import { FeatureView } from "@/components/feature";
import { featurePage } from "@/lib/features";

const meta = featurePage("en", "plugins").meta;

export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: "/en/plugins/", languages: { ko: "/plugins/", en: "/en/plugins/" } },
};

export default function Page() {
  return <FeatureView locale="en" feature="plugins" />;
}
