import { Shell, siteMetadata } from "@/components/shell";

export const metadata = siteMetadata("en");
export { viewport } from "@/components/shell";

export default function EnLayout({ children }: { children: React.ReactNode }) {
  return <Shell locale="en">{children}</Shell>;
}
