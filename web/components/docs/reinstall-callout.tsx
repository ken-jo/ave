import { Callout } from "./callout";
import { reinstallNotice } from "@/lib/reinstall";
import type { Locale } from "@/lib/i18n";

/** The Ave → Ave reinstall rule as a docs callout (same text as the landing notice). */
export function ReinstallCallout({ locale }: { locale: Locale }) {
  const notice = reinstallNotice(locale);
  return (
    <div id="reinstall" className="scroll-mt-24">
      <Callout tone="warn" title={notice.title}>
        <ul className="!my-1 list-disc pl-5">
          {notice.points.map((point) => (
            <li key={point} className="!my-1">
              {point}
            </li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}
