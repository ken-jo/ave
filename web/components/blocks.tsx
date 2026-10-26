import type { BentoBlock, Card, Faq, Point, SplitBlock } from "@/lib/content";
import type { Locale } from "@/lib/i18n";
import type { NavLink } from "@/lib/nav";
import { pagesCopy } from "@/lib/pages";
import { CopyButton } from "./client";
import { Item } from "./chrome";
import { Frame, Shot } from "./media";

/** The element a block wraps each of its parts in; the plain element by default. */
export type ItemComponent = (props: { as?: "div" | "article" | "li"; className?: string; children: React.ReactNode }) => React.ReactNode;

const Plain: ItemComponent = ({ as: Tag = "div", className, children }) => <Tag className={className}>{children}</Tag>;

/** Section heading: eyebrow, title, optional lead. */
export function SecHead({ id, eyebrow, title, body, Item = Plain }: { id: string; eyebrow?: string; title: string; body?: string; Item?: ItemComponent }) {
  return (
    <Item className="sec-head">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h2 id={id} className="h2">
        {title}
      </h2>
      {body ? <p className="lead">{body}</p> : null}
    </Item>
  );
}

export function Points({ points }: { points: Point[] }) {
  return (
    <ul className="points">
      {points.map(([lead, rest]) => (
        <li key={lead}>
          <b>{lead}</b>
          {/* A lead that is a sentence ("Copy and attach.") is followed by a space; a lead
              that is a name takes its particle or verb directly ("browser_snapshot" + "은 …"). */}
          {/[.:]$/u.test(lead) ? ` ${rest}` : rest}
        </li>
      ))}
    </ul>
  );
}

/** One real shot beside a dense list of what it shows. */
export function Split({ id, block, foot }: { id: string; block: SplitBlock; foot?: React.ReactNode }) {
  return (
    <div className={block.flip ? "split flip" : "split"}>
      <Frame pic={block.pic} />
      <div className="split-text">
        <p className="eyebrow">{block.eyebrow}</p>
        <h2 id={id} className="h2">
          {block.title}
        </h2>
        <p className="lead">{block.body}</p>
        <Points points={block.points} />
        {foot}
      </div>
    </div>
  );
}

function BentoCard({ card, Item }: { card: Card; Item: ItemComponent }) {
  const cls = ["card", card.w ? `w${card.w}` : ""].filter(Boolean).join(" ");
  return (
    <Item as="article" className={cls}>
      <div className={card.inset ? "card-media pad" : "card-media"}>
        <Shot pic={card.pic} />
      </div>
      <div className="card-body">
        <h3 className="h3">{card.title}</h3>
        <p>{card.body}</p>
      </div>
    </Item>
  );
}

export function Bento({ id, block, foot, Item = Plain }: { id: string; block: BentoBlock; foot?: React.ReactNode; Item?: ItemComponent }) {
  return (
    <>
      <SecHead id={id} eyebrow={block.eyebrow} title={block.title} body={block.body} Item={Item} />
      <div className="bento">
        {block.cards.map((c) => (
          <BentoCard key={c.title} card={c} Item={Item} />
        ))}
      </div>
      {foot ? <div className="sec-foot">{foot}</div> : null}
    </>
  );
}

/** A row of short facts, each with a rule above it. */
export function Facts({ id, title, items, Item = Plain }: { id?: string; title?: string; items: { title: string; body: string }[]; Item?: ItemComponent }) {
  return (
    <>
      {title && id ? <SecHead id={id} title={title} Item={Item} /> : null}
      <div className="facts">
        {items.map((f) => (
          <Item key={f.title} className="fact">
            <h3 className="h3">{f.title}</h3>
            <p>{f.body}</p>
          </Item>
        ))}
      </div>
    </>
  );
}

export function Faqs({ id, title, faqs }: { id: string; title: string; faqs: Faq[] }) {
  return (
    <>
      <SecHead id={id} title={title} />
      <div className="faq">
        {faqs.map((f) => (
          <details key={f.q}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </>
  );
}

/** "Read on" cards: each names one destination and says what is there. */
export function NextSteps({ id, title, items, path }: { id: string; title: string; items: { link: NavLink; body: string }[]; path: string }) {
  return (
    <>
      <SecHead id={id} title={title} />
      <div className="next">
        {items.map(({ link, body }) => (
          <div key={link.href} className="next-item">
            <Item link={link} path={path} className="more" />
            <p>{body}</p>
          </div>
        ))}
      </div>
    </>
  );
}

/** A command with a copy button. */
export function Command({ text, locale }: { text: string; locale: Locale }) {
  const w = pagesCopy(locale).ui;
  return (
    <div className="cmd">
      <code>{text}</code>
      <CopyButton text={text} label={w.copy} done={w.copied} />
    </div>
  );
}
