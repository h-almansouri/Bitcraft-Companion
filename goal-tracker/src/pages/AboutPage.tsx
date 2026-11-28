import { useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Check, Factory, Gem, Hammer, MessageCircle, Minus, Sparkles, Trophy, Utensils, X } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useCachedBoard } from '../lib/boards.ts';
import { CLAIM, DISCORD_URL, FREE_FOOD_CHESTS, HOME, MARKET_REGION, playersAndAlts } from '../lib/claim.ts';
import { buildView, countedPlayers } from '../lib/derive.ts';
import { TIER_NAMES, day, num, pct, plural } from '../lib/format.ts';
import { useGame, type GameCtx } from '../lib/game.ts';
import { useLoad, type Loaded } from '../lib/hooks.ts';
import { Link } from '../lib/router.tsx';
import type { ClaimDetail, Push, StockSnapshot } from '../lib/shapes.ts';
import { Bar, Card, Notice, Pill, SectionLabel, Skeleton, TierChip, cx } from '../ui/kit.tsx';
import { StorageRead, useStock } from '../ui/storage.tsx';
import { KIND_LABEL } from './BoardPage.tsx';

const PUSHES = HOME + '/pushes';
const RESOURCES = HOME + '/resources';
const LOGO = HOME + '/logo.png';

/**
 * Facts about the group, in one place so they are easy to correct.
 * Tier and members are read live; these are not.
 */
const GROUP = {
  home: 'Rocky Gardens',
  /** EA2: two of us, three Mythic tool pushes, six Mythic tools. */
  ea2: { people: 'two', pushes: 'three', mythics: 'six' },
  /** The tier that opens Mythic tool pushes, the trading hub pitstop, and the end goal. */
  mythicTier: 6,
  hubTier: 7,
  goalTier: 10,
};

/** The page's sections, in order. The bar under the header jumps between them. */
const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'us', label: 'Who we are' },
  { id: 'roadmap', label: 'Roadmap' },
  { id: 'food', label: 'Food' },
  { id: 'tool-pushes', label: 'Tool pushes' },
  { id: 'layout', label: 'Claim layout' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

type Members = ClaimDetail['members'] | undefined;

/**
 * The storage read for this page. It asks for the same members as the All pushes page does,
 * so the two share one snapshot (and the food list comes out of it for free).
 */
function useClaimStock(pushes: Push[] | null, claim: Loaded<ClaimDetail>) {
  const open = (pushes ?? []).filter((p) => p.status !== 'done');
  const players = [...new Set(open.flatMap((p) => countedPlayers(p, claim.data?.members)))].sort();
  // Some push counts whoever is in the claim, and the member list is still on its way.
  const membersPending = claim.loading && open.some((p) => p.leftOut);
  return useStock(pushes && !membersPending ? `stock:${players.join(',')}` : null, players);
}

/**
 * Where you were before the last jump, so the floating button can take you back.
 * A tiny store rather than state, because jumps start from several places on the page.
 */
let returnTo: number | null = null;
const returnWatchers = new Set<() => void>();
function setReturnTo(y: number | null) {
  returnTo = y;
  returnWatchers.forEach((notify) => notify());
}
function useReturnTo() {
  return useSyncExternalStore(
    (notify) => {
      returnWatchers.add(notify);
      return () => {
        returnWatchers.delete(notify);
      };
    },
    () => returnTo,
  );
}

/** Smooth-scrolls to a section without stacking up history entries, remembering where you jumped from. */
function jumpTo(id: string, event?: MouseEvent) {
  const target = document.getElementById(id);
  if (!target) return;
  event?.preventDefault();
  setReturnTo(window.scrollY);
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.history.replaceState(null, '', '#' + id);
}

/**
 * The claim's front page, one long scroll: what Nowhere is and why someone might join,
 * for anyone who opens the link. The live parts (tier, members, food, pushes) come from
 * the same reads the All pushes page makes.
 */
export function AboutPage() {
  const claim = useLoad<ClaimDetail>('claim', () => api.claim());
  const board = useCachedBoard(CLAIM.slug);
  const pushes = board?.pushes ?? null;
  const { ctx } = useGame();
  const stock = useClaimStock(pushes, claim);

  // Opening the page at /nowhere#food lands on Food once it has rendered.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, []);

  return (
    <div className="pb-10">
      <Hero claim={claim.data} />
      <JumpBar />
      <div className="mt-10">
        <Overview />
        <SectionBreak />
        <WhoWeAre claim={claim.data} pushes={pushes ?? []} />
        <SectionBreak />
        <Roadmap pushes={pushes ?? []} members={claim.data?.members} ctx={ctx} stock={stock.data} loading={stock.loading} />
        <SectionBreak />
        <FreeFood ctx={ctx} stock={stock} />
        <SectionBreak />
        <ToolPushes />
        <SectionBreak />
        <ClaimLayout ctx={ctx} stock={stock} />
        <SectionBreak />
      </div>
      <BackToTop />
    </div>
  );
}

function Hero({ claim }: { claim: ClaimDetail | null }) {
  const heads = claim ? playersAndAlts(claim.members) : null;
  const stats: [string, ReactNode][] = [
    ['Claim tier', claim ? <span style={{ color: `color-mix(in oklab, var(--tier-${claim.tier}) 70%, var(--ink))` }}>Tier {claim.tier}</span> : null],
    [
      'Players',
      heads ? (
        <span>
          {num(heads.players.length)}
          {heads.alts.length > 0 && (
            <span className="ml-1.5 text-[13px] font-normal text-ink-2">
              + {heads.alts.length} {plural(heads.alts.length, 'alt')}
            </span>
          )}
        </span>
      ) : null,
    ],
    ['Home', `${GROUP.home}, R${MARKET_REGION.id}`],
  ];
  return (
    <section className="relative overflow-hidden rounded-card border border-line bg-surface">
      {/* A soft gold glow behind the words, like the lamp-lit sign in the logo. Decoration only. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse 70% 90% at 0% 0%, var(--accent-soft), transparent 70%)' }} />
      <img src={LOGO} alt="" aria-hidden="true" width={176} height={176} className="pointer-events-none absolute right-9 top-9 hidden h-44 w-44 rounded-full md:block" />

      <div className="relative px-5 pb-6 pt-8 sm:px-9 sm:pb-8 sm:pt-11">
        <img src={LOGO} alt="" aria-hidden="true" width={56} height={56} className="mb-3 h-14 w-14 rounded-full md:hidden" />
        <h1 className="text-[38px] font-semibold leading-tight sm:text-[50px]">{CLAIM.name}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2 sm:text-base md:max-w-[calc(100%-13rem)]">
          A small, active community building a claim together. Free food and tool upgrades are always around, so you can just play.
        </p>
        <div className="mt-6 flex flex-wrap gap-2.5">
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-accent bg-accent-dim px-4 text-[13px] font-medium text-accent-ink no-underline transition-colors hover:bg-accent hover:text-bg"
          >
            <MessageCircle size={15} />
            Join Nowhere on Discord
          </a>
          <Link to={PUSHES} className="inline-flex h-10 items-center gap-1.5 rounded-md border border-line-2 bg-surface-2 px-4 text-[13px] font-medium text-ink no-underline transition-colors hover:bg-surface-3">
            See what we're working on
            <ArrowRight size={15} />
          </Link>
          <a
            href="#tool-pushes"
            onClick={(e) => jumpTo('tool-pushes', e)}
            className="inline-flex h-10 items-center gap-1.5 rounded-md border border-line-2 bg-surface-2 px-4 text-[13px] font-medium text-ink no-underline transition-colors hover:bg-surface-3"
          >
            How tool pushes work
          </a>
        </div>

        <dl className="mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 md:max-w-[calc(100%-13rem)]">
          {stats.map(([label, value]) => (
            <div key={label} className="bg-surface px-4 py-3">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</dt>
              <dd className="num mt-1 flex min-h-6 items-center text-lg font-semibold leading-snug text-ink">{value ?? <Skeleton className="h-4 w-12" />}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/** Sticks under the header and lights up the section on screen. */
function JumpBar() {
  const [current, setCurrent] = useState<SectionId | null>(null);
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        // The first section, in page order, with any part in the band near the top of the screen.
        setCurrent(SECTIONS.find((s) => seen.get(s.id))?.id ?? null);
      },
      { rootMargin: '-120px 0px -55% 0px' },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <nav aria-label="On this page" className="sticky top-14 z-20 -mx-3 mt-4 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur sm:-mx-5 sm:px-5">
      <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={'#' + s.id}
            onClick={(e) => jumpTo(s.id, e)}
            aria-current={current === s.id ? 'true' : undefined}
            className={cx(
              'inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium no-underline transition-colors',
              current === s.id ? 'border-accent bg-accent-soft text-accent-ink' : 'border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            {s.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

/**
 * A round arrow button floating in the corner. After a jump (the bar, a card, a header button) it
 * takes you back to where you were, pointing up or down toward that spot. Otherwise, once you've
 * scrolled a way down, it goes to the top, and then offers the way back to where you were reading.
 */
function BackToTop() {
  const [y, setY] = useState(0);
  const back = useReturnTo();
  useEffect(() => {
    const check = () => setY(window.scrollY);
    check();
    window.addEventListener('scroll', check, { passive: true });
    return () => window.removeEventListener('scroll', check);
  }, []);
  // A saved spot right where you already are is no use, so the button falls back to "top".
  const returning = back !== null && Math.abs(back - y) > 200;
  const shown = returning || y > 600;
  const label = returning ? 'Back to where you were' : 'Back to top';
  const go = () => {
    if (returning && back !== null) {
      window.scrollTo({ top: back, behavior: 'smooth' });
      setReturnTo(null);
    } else {
      setReturnTo(window.scrollY);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    window.history.replaceState(null, '', window.location.pathname);
  };
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={go}
      className={cx(
        'fixed bottom-5 right-5 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-accent bg-accent-dim text-accent-ink shadow-lg shadow-black/30 transition-all hover:bg-accent hover:text-bg',
        shown ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
      )}
    >
      {returning && back !== null && back > y ? <ArrowDown size={18} /> : <ArrowUp size={18} />}
    </button>
  );
}

/** The line between sections, with a small gold diamond in the middle, so the long scroll reads in parts. Decoration only. */
function SectionBreak() {
  const line = (side: 'right' | 'left') => `linear-gradient(to ${side}, transparent, var(--line-2) 35%, color-mix(in oklab, var(--accent) 65%, var(--line-2)))`;
  return (
    <div aria-hidden="true" className="my-12 flex items-center gap-2.5 sm:my-16">
      <span className="h-px flex-1" style={{ background: line('right') }} />
      <span className="h-1.5 w-1.5 rotate-45 bg-accent/60" />
      <span className="h-3 w-3 rotate-45 border border-accent bg-accent-dim" />
      <span className="h-1.5 w-1.5 rotate-45 bg-accent/60" />
      <span className="h-px flex-1" style={{ background: line('left') }} />
    </div>
  );
}

/** Heading block shared by every section. */
function SectionHead({ id, eyebrow, title, children, extra }: { id?: SectionId; eyebrow: string; title: string; children?: ReactNode; extra?: ReactNode }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SectionLabel>{eyebrow}</SectionLabel>
        {extra}
      </div>
      <h2 id={id ? `${id}-title` : undefined} className="mt-1.5 text-[24px] font-semibold text-ink sm:text-[28px]">
        {title}
      </h2>
      {children && <div className="mt-2 space-y-2 text-[14px] leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}

/** A section the jump bar can land on, clear of the sticky header and bar. */
function Section({ id, children, className }: { id: SectionId; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cx('scroll-mt-32', className)}>
      {children}
    </section>
  );
}

/** Card and sub-section titles share the headings' serif. */
const titleFont = 'font-display font-semibold text-ink';

/** Short "if this is you" stories: everyone's playstyle has a place. */
const PLAYSTYLES: { who: string; story: string }[] = [
  { who: 'Love gathering?', story: "Head out and gather to your heart's content. We've got alts at base processing full-time, so drop off your haul, open craft, and get back out there." },
  { who: 'Rather stay home?', story: "If you'd rather hang at base and craft, most community crafts are open. Jump in on whatever's going." },
  { who: 'Chasing a goal?', story: "Let the group know. If you're pushing for something specific, like tiering up a specific profession, people are usually happy to help." },
];

const OVERVIEW: { icon: ReactNode; title: string; body: string; jump?: SectionId }[] = [
  {
    icon: (
      <>
        <Utensils size={17} />
        <Hammer size={17} />
      </>
    ),
    title: 'Free food and basic tool upgrades',
    body: 'Take whatever you need from the food chest and upgrade your tools with materials from the tools chest as you level up your professions. No obligation to restock materials, but as with all shared claim resources, please be respectful.',
    jump: 'food',
  },
  {
    icon: <Gem size={18} />,
    title: 'Optional tool pushes',
    body: 'For the min-maxers, we run tool pushes now and then, going for Epic, Legendary and Mythic tools. Totally optional, and the only contribution-based goal we track.',
    jump: 'tool-pushes',
  },
  {
    icon: <Factory size={18} />,
    title: 'Optimized passive stations',
    body: "Long term, we're building out as many passive stations as we can, laid out to maximize the personal cache and deployables range. This allows passive craft processing to be as efficient as possible.",
    jump: 'layout',
  },
];

function Overview() {
  return (
    <Section id="overview">
      <SectionHead id="overview" eyebrow="Overview" title="Play however you like" />

      <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 border-y border-line py-4 md:grid-cols-3">
        {PLAYSTYLES.map((p) => (
          <p key={p.who} className="text-[13px] leading-relaxed text-ink-2">
            <span className="block font-semibold text-accent-ink">{p.who}</span>
            {p.story}
          </p>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
        {OVERVIEW.map((o) => {
          const card = (
            <Card className={cx('h-full px-5 py-4', o.jump && 'transition-colors group-hover:border-accent')}>
              <span className="inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg bg-accent-soft px-2 text-accent-ink">{o.icon}</span>
              <h3 className={cx('mt-3 text-[17px]', titleFont)}>{o.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{o.body}</p>
            </Card>
          );
          const jump = o.jump;
          return jump ? (
            <a key={o.title} href={'#' + jump} onClick={(e) => jumpTo(jump, e)} className="group no-underline">
              {card}
            </a>
          ) : (
            <div key={o.title}>{card}</div>
          );
        })}
      </div>
    </Section>
  );
}

type Stage = 'done' | 'now' | 'next' | 'later' | 'goal';
type Milestone = { title: string; note?: string; reachedAt?: number; done?: boolean; now?: boolean; goal?: boolean };
const MILESTONES: Milestone[] = [
  { title: 'T5 claim', note: 'In our first two weeks', reachedAt: 5 },
  { title: 'A road from the ocean to the swamp', done: true },
  { title: 'A tool push', note: 'Rolling tools for everyone right now', now: true },
  { title: `T${GROUP.mythicTier} claim`, note: 'Unlocks Mythic tool pushes', reachedAt: GROUP.mythicTier },
  { title: 'Trader stands', note: 'So anyone can knock out traveler tasks quickly' },
  { title: `T${GROUP.hubTier} claim`, note: 'A pitstop for our trading hub: a regional bank and market, right alongside the ocean', reachedAt: GROUP.hubTier },
  { title: `T${GROUP.goalTier} claim`, note: 'The end goal, with port cities and outposts', reachedAt: GROUP.goalTier, goal: true },
];
const STAGE_PILL: Partial<Record<Stage, [string, 'accent' | 'info' | 'neutral']>> = { now: ['Now', 'accent'], next: ['Next', 'info'], goal: ['Long-term goal', 'neutral'] };

function WhoWeAre({ claim, pushes }: { claim: ClaimDetail | null; pushes: Push[] }) {
  const tier = claim?.tier ?? 5;
  const toolPush = pushes.find((p) => p.kind === 'tool-push' && p.status === 'active');
  // The "now" step only shows while a tool push is actually running.
  const steps = MILESTONES.filter((m) => !m.now || toolPush);
  const reached = (m: Milestone) => !!m.done || (m.reachedAt !== undefined && tier >= m.reachedAt);
  const next = steps.find((m) => !m.now && !reached(m));
  const stageOf = (m: Milestone): Stage => (reached(m) ? 'done' : m.now ? 'now' : m === next ? 'next' : m.goal ? 'goal' : 'later');

  return (
    <Section id="us" className="grid grid-cols-1 items-start gap-x-8 gap-y-5 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div>
        <SectionHead id="us" eyebrow="Who we are" title="Small crew, big plans">
          <p>
            Five of us started Nowhere. Three of us played EA2, and the rest are brand new to BitCraft. We hit a T5 claim in our first two weeks, settled in the{' '}
            {GROUP.home} in {MARKET_REGION.name} (R{MARKET_REGION.id}), and built a road from the ocean to the swamp.
          </p>
          <p>
            Back in EA2, just {GROUP.ea2.people} of us ran {GROUP.ea2.pushes} Mythic tool pushes and rolled {GROUP.ea2.mythics} Mythic tools. We'd love to do it again with the whole
            crew once we hit a T{GROUP.mythicTier} claim.
          </p>
          <p>
            The end goal is a T{GROUP.goalTier} claim with port cities and outposts. Along the way, we'll stop at T{GROUP.hubTier} to build a trading hub with a regional bank and
            market, right alongside the ocean and open to traders from across the map.
          </p>
        </SectionHead>
        <p className="mt-5 rounded-lg border border-line bg-surface-2 px-4.5 py-3.5 text-[13px] leading-relaxed text-ink-2">
          <span className="font-semibold text-ink">House rules?</span> Not many. Be a team player, be respectful, and no hate speech of any kind. Follow the game's rules too (no
          hacking or cheating). Beyond that, use your best judgment.
        </p>
      </div>

      <Card className="px-5 py-4 lg:mt-1">
        <SectionLabel>Where we're headed</SectionLabel>
        <ol className="mt-3">
          {steps.map((m, i) => {
            const stage = stageOf(m);
            const pill = STAGE_PILL[stage];
            const lit = stage === 'now' || stage === 'next';
            return (
              <li key={m.title} className="relative flex gap-3.5 pb-4 last:pb-0">
                {/* The line joining one step to the next. */}
                {i < steps.length - 1 && <span aria-hidden="true" className={cx('absolute bottom-0 left-[11px] top-6 w-px', stage === 'done' ? 'bg-good/50' : 'bg-line-2')} />}
                <span
                  className={cx(
                    'relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
                    stage === 'done' ? 'border-good bg-good-soft text-good' : lit ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line-2 bg-surface text-muted',
                  )}
                >
                  {stage === 'done' ? <Check size={13} strokeWidth={3} /> : <span className={cx('h-1.5 w-1.5 rounded-full', lit ? 'bg-accent-ink' : 'bg-muted')} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
                    {m.title}
                    {pill && <Pill tone={pill[1]}>{pill[0]}</Pill>}
                  </p>
                  {m.note && <p className="text-[13px] text-ink-2">{m.note}</p>}
                  {stage === 'now' && toolPush && (
                    <Link to={`${HOME}/${toolPush.slug}`} className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-accent-ink no-underline hover:underline">
                      {toolPush.name}
                      <ArrowRight size={13} />
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>
    </Section>
  );
}

/** Progress of a push against doing it from empty storage, counting members the way the push page does. */
function usePushView(push: Push, members: Members, ctx: GameCtx | null, stock: StockSnapshot | null) {
  return useMemo(
    () => (ctx && stock && push.status !== 'done' ? buildView(ctx, { ...push, players: countedPlayers(push, members) }, stock) : null),
    [push, members, ctx, stock],
  );
}

function Roadmap({ pushes, members, ctx, stock, loading }: { pushes: Push[]; members: Members; ctx: GameCtx | null; stock: StockSnapshot | null; loading: boolean }) {
  const open = pushes.filter((p) => p.status === 'active' || p.status === 'planned');
  const done = pushes.filter((p) => p.status === 'done');
  return (
    <Section id="roadmap">
      <SectionHead id="roadmap" eyebrow="Roadmap" title="What we're working on">
        <p>
          Claim goals, tool pushes, and shared claim resources all live on this site, so you can always see what resources are available and how they are being used.
          There is no requirement to contribute, and contributions outside of tool pushes are not tracked.
        </p>
      </SectionHead>

      {pushes.length > 0 && (
        <>
          <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr_300px]">
            {open.map((push) => (
              <LivePush key={push.slug} push={push} members={members} ctx={ctx} stock={stock} loading={loading} />
            ))}
            {open.length === 0 && <p className="text-[13px] text-ink-2">Between pushes right now.</p>}
            {done.length > 0 && (
              <Card className="px-4 py-3.5">
                <SectionLabel>Done so far</SectionLabel>
                <ul className="mt-2.5 space-y-2">
                  {done.map((push) => (
                    <li key={push.slug}>
                      <Link to={`${HOME}/${push.slug}`} className="flex items-center gap-2.5 text-[13px] no-underline">
                        <Trophy size={15} className="shrink-0 text-good" />
                        <span className="min-w-0 flex-1 truncate font-medium text-ink hover:text-accent-ink">{push.name}</span>
                        <span className="shrink-0 text-xs text-muted">{day(push.completedAt ?? push.updatedAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
          <Link to={PUSHES} className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent-ink no-underline hover:underline">
            All pushes
            <ArrowRight size={14} />
          </Link>
        </>
      )}
    </Section>
  );
}

/** One open push as a newcomer would want it: how far along, and what is still needed. */
function LivePush({ push, members, ctx, stock, loading }: { push: Push; members: Members; ctx: GameCtx | null; stock: StockSnapshot | null; loading: boolean }) {
  const view = usePushView(push, members, ctx, stock);
  const gather = view?.todos.filter((t) => t.kind === 'gather').sort((a, b) => b.row.tier - a.row.tier) ?? [];
  return (
    <Link to={`${HOME}/${push.slug}`} className="group min-w-0 no-underline">
      <Card className="h-full px-4 py-3.5 transition-colors group-hover:border-accent">
        <div className="flex items-start gap-2">
          <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', push.status === 'active' ? 'bg-accent' : 'bg-warn')} />
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{push.name}</h3>
          <Pill>{KIND_LABEL[push.kind]}</Pill>
        </div>
        {push.goals.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-2">Lined up next.</p>
        ) : view ? (
          <div className="mt-2 space-y-1.5">
            {(
              [
                ['Gathered', view.progress.gather.pct],
                ['Processed', view.progress.process.pct],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex items-center gap-3">
                <span className="w-[68px] shrink-0 text-xs text-ink-2">{label}</span>
                <Bar value={value} className="flex-1" />
                <span className="num w-9 text-right text-[13px] font-semibold text-accent-ink">{pct(value)}</span>
              </div>
            ))}
          </div>
        ) : loading || !ctx ? (
          <Skeleton className="mt-3 h-2" />
        ) : (
          <p className="mt-2 text-[13px] text-ink-2">Open it to see where it stands.</p>
        )}
        {gather.length > 0 && (
          <p className="mt-2 line-clamp-2 text-xs text-ink-2">
            Still needed: {gather.slice(0, 3).map((t) => `${num(t.qty)} ${t.row.name}`).join(', ')}
            {gather.length > 3 && ` and ${gather.length - 3} more`}
          </p>
        )}
      </Card>
    </Link>
  );
}

/** What each food does beyond health and stamina, from public/food-buffs.json (`npm run food-buffs`). */
type FoodBuffs = Record<string, { name: string; minutes: number; stats: [string, number, number][] }[]>;

/** Plain names for the game's stat ids. Anything not listed is spelled out from its id. */
const STAT_LABEL: Record<string, string> = {
  ExperienceRate: 'EXP',
  BuildingSpeed: 'construction speed',
  CooldownMultiplier: 'ability cooldowns',
  MovementMultiplier: 'movement speed',
  ActiveStaminaRegenRate: 'active stamina regen',
  ActiveHealthRegenRate: 'active health regen',
};
const statLabel = (id: string) => STAT_LABEL[id] ?? id.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** "+5% EXP, −10% gathering and crafting speed": gains first, gathering and crafting merged when they match. */
function describeBuff(stats: [string, number, number][]): string {
  const parts: { label: string; value: number; pct: boolean }[] = [];
  const craft = stats.find(([s]) => s === 'CraftingSpeed');
  const gather = stats.find(([s]) => s === 'GatheringSpeed');
  const merged = craft && gather && craft[1] === gather[1] && craft[2] === gather[2];
  for (const [id, value, isPct] of stats) {
    if (merged && id === 'CraftingSpeed') continue;
    parts.push({ label: merged && id === 'GatheringSpeed' ? 'gathering and crafting speed' : statLabel(id), value, pct: !!isPct });
  }
  const amount = (p: (typeof parts)[number]) => {
    const n = p.pct ? Math.round(Math.abs(p.value) * 1000) / 10 : Math.abs(p.value);
    return `${p.value < 0 ? '−' : '+'}${n}${p.pct ? '%' : ''}`;
  };
  return parts
    .sort((a, b) => Number(b.value > 0) - Number(a.value > 0))
    .map((p) => `${amount(p)} ${p.label}`)
    .join(', ');
}
const duration = (minutes: number) => (minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hr` : `${minutes} min`);

function FreeFood({ ctx, stock }: { ctx: GameCtx | null; stock: Loaded<StockSnapshot> & { refresh: () => void } }) {
  const buffs = useLoad<FoodBuffs>('food-buffs', () => fetch(HOME + '/food-buffs.json').then((r) => (r.ok ? r.json() : {})));

  const tiers = useMemo(() => {
    if (!stock.data || !ctx) return null;
    const totals = new Map<string, number>();
    for (const loc of stock.data.locations) {
      if (loc.kind !== 'claim' || !FREE_FOOD_CHESTS.includes(loc.name)) continue;
      for (const [id, qty] of loc.items) totals.set(id, (totals.get(id) ?? 0) + qty);
    }
    const byTier = new Map<number, { id: string; name: string; qty: number }[]>();
    for (const [id, qty] of totals) {
      const thing = ctx.game.things[id];
      const tier = thing?.tier ?? 0;
      if (!byTier.has(tier)) byTier.set(tier, []);
      byTier.get(tier)!.push({ id, name: thing?.name ?? 'Unknown item', qty });
    }
    return [...byTier]
      .sort(([a], [b]) => b - a)
      .map(([tier, items]) => ({ tier, items: items.sort((a, b) => b.qty - a.qty), total: items.reduce((sum, i) => sum + i.qty, 0) }));
  }, [stock.data, ctx]);

  // The foods in the chest that do something extra, best tier first.
  const buffed = useMemo(() => {
    if (!tiers || !buffs.data) return null;
    return tiers.flatMap(({ tier, items }) =>
      items.flatMap((item) => (buffs.data![item.id] ?? []).map((b, i) => ({ key: `${item.id}:${i}`, tier, name: item.name, effect: describeBuff(b.stats), minutes: b.minutes }))),
    );
  }, [tiers, buffs.data]);

  const servings = tiers?.reduce((sum, t) => sum + t.total, 0) ?? 0;
  const found = stock.data?.locations.some((l) => l.kind === 'claim' && FREE_FOOD_CHESTS.includes(l.name));

  return (
    <Section id="food">
      <SectionHead id="food" eyebrow="Food" title="Food chest">
        <p>Everything in the {FREE_FOOD_CHESTS.join(' and ')} chest is free for claim members. No need to restock what you take, but just be mindful that it's shared. Here's what's in there right now.</p>
      </SectionHead>

      <Card className="mt-5 overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
            <Utensils size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink">{FREE_FOOD_CHESTS.join(' + ')} chest</p>
            <p className="num text-xs text-ink-2">{tiers ? `${num(servings)} to take` : 'Reading the chest…'}</p>
          </div>
          <StorageRead stock={stock} />
        </div>

        {stock.error && !stock.data ? (
          <div className="p-5">
            <Notice tone="warn">The chest can't be read right now ({stock.error}). Try again in a few minutes.</Notice>
          </div>
        ) : !tiers ? (
          <div className="grid grid-cols-2 gap-4 p-5 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : !found ? (
          <p className="px-5 py-6 text-[13px] text-ink-2">The {FREE_FOOD_CHESTS.join(' and ')} chest isn't showing up in the claim right now.</p>
        ) : tiers.length === 0 ? (
          <p className="px-5 py-6 text-[13px] text-ink-2">Empty right now. Check back soon.</p>
        ) : (
          <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 lg:grid-cols-5">
            {tiers.map(({ tier, items, total }) => (
              <div key={tier} className="bg-surface px-4 py-3.5">
                <div className="flex items-center gap-2">
                  {tier ? <TierChip tier={tier} /> : null}
                  <span className="text-[12px] font-semibold text-ink-2">{TIER_NAMES[tier] || 'Other'}</span>
                  <span className="num ml-auto text-[12px] text-muted">{num(total)}</span>
                </div>
                <ul className="mt-2.5 space-y-1">
                  {items.map((item) => (
                    <li key={item.id} className="flex items-baseline gap-2 text-[13px]">
                      <span className="min-w-0 flex-1 text-ink">
                        {item.name}
                        {buffs.data?.[item.id] && <Sparkles size={11} className="ml-1 inline align-[-1px] text-accent-ink" aria-label="has a buff" />}
                      </span>
                      <span className="num shrink-0 text-ink-2">{num(item.qty)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      {buffed && buffed.length > 0 && (
        <Card className="mt-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles size={15} className="text-accent-ink" />
            <h3 className={cx('text-[17px]', titleFont)}>Food buffs</h3>
          </div>
          <ul className="mt-3 divide-y divide-line">
            {buffed.map((b) => (
              <li key={b.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-[13px] first:pt-0 last:pb-0">
                <span className="flex min-w-0 items-center gap-2 font-medium text-ink sm:w-[260px]">
                  {b.tier ? <TierChip tier={b.tier} /> : null}
                  <span className="truncate">{b.name}</span>
                </span>
                <span className="min-w-0 flex-1 text-ink-2">{b.effect}</span>
                <span className="num shrink-0 text-xs text-muted">{duration(b.minutes)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-line pt-2.5 text-xs text-muted">Every food also restores health and stamina over time.</p>
        </Card>
      )}
    </Section>
  );
}

const TOOL_CARDS = [
  ['Percentage-based contributions', 'You get your percentage of everything the push rolls, as tools or gold.', 'accent'],
  ['Usually net positive', 'In EA2, what we rolled was usually worth more than the raw materials we put in.', 'good'],
  ['But bad rolls exist too', 'But also, rolls are random. An unlucky push can be worth less than what you put in.', 'warn'],
] as const;

const STEPS: { title: string; body: string }[] = [
  { title: 'The claim calls a push', body: "When the claim decides it wants to work on a tool push, the goal and the materials list go up here, so you can see what's needed and how far along it is." },
  { title: 'You hand stuff in', body: "Drop materials in the push's drop box. Each hand-in gets logged at that day's market price, averaged across every region." },
  { title: 'Contributions are tallied', body: "The fair market value of everyone's contribution gets totaled. Put in 15% of it, own 15% of what comes out." },
  { title: 'We roll', body: 'Materials become tools, and every tool rolled goes in the pot: Mythic, Legendary and Epic.' },
  { title: 'Tools are split', body: 'You take your share as tools, gold at market value, or a mix.' },
];

type Point = [kind: 'pro' | 'con' | 'neutral', text: string];
const MARKET_VALUE: Point[] = [
  ['neutral', 'You get exactly what your materials were worth'],
  ['pro', "You never come out behind, so bad rolls can't hurt you"],
  ['con', 'Lucky rolls go to the claim, not you'],
];
const PERCENTAGE: Point[] = [
  ['neutral', 'You get a percentage of everything rolled'],
  ['pro', 'A lucky push pays off for everyone who chipped in'],
  ['con', 'An unlucky push is shared too, so you can get back less'],
];

const FAQ: { q: string; a: string }[] = [
  { q: 'Do I have to join?', a: 'Nope. Tool pushes are optional like everything else, and the free basic tool upgrades are yours either way.' },
  { q: 'How little can I put in?', a: 'Any amount. Smaller hand-in, smaller share.' },
  {
    q: 'Which price counts?',
    a: "The average market price across every region on the day you hand something in. It's locked in, so a price drop later won't shrink what you put in.",
  },
  { q: 'Can I take gold instead of a tool?', a: 'Yep. Tools, gold at market value, or a mix.' },
];

/** How a tool push works, at the bottom of the page for anyone weighing whether to join one. */
function ToolPushes() {
  return (
    <Section id="tool-pushes" className="space-y-10">
      <div>
        <SectionHead
          id="tool-pushes"
          eyebrow="Tool pushes"
          title="Percentage-based contribution tracking"
          extra={<Pill tone="info">Mythic pushes unlock at tier {GROUP.mythicTier}</Pill>}
        >
          <p>
            For those who enjoy tool rolling, we periodically host tool pushes for Epic, Legendary, and Mythic tools. They're completely optional, and contributions are tracked
            to ensure all returns (or losses) are shared proportionately.
          </p>
        </SectionHead>
        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
          {TOOL_CARDS.map(([title, body, tone]) => (
            <Card key={title} className="px-5 py-4">
              <span className={cx('block h-1 w-8 rounded-full', tone === 'accent' ? 'bg-accent' : tone === 'good' ? 'bg-good' : 'bg-warn')} />
              <h3 className={cx('mt-3 text-[17px]', titleFont)}>{title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{body}</p>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <SubHead title="How it works" />
        <ol className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {STEPS.map((step, i) => (
            <li key={step.title}>
              <Card className="h-full px-4 py-4">
                <span className="num flex h-7 w-7 items-center justify-center rounded-full border border-accent text-[13px] font-semibold text-accent-ink">{i + 1}</span>
                <h4 className={cx('mt-3 text-[16px]', titleFont)}>{step.title}</h4>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{step.body}</p>
              </Card>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[13px] text-muted">A tracker on this site will log hand-ins and prices. It's in the works.</p>
      </div>

      <div>
        <SubHead title="Why percentage-based contributions?">
          We could just pay you market price for your materials. But in EA2, the tools we rolled were usually worth more than the raw materials that went in. By following a
          percentage-based contribution system, everyone has the potential to profit off positive rolls.
        </SubHead>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Compare title="Market value contributions" tag="Not how we do it" chosen={false} points={MARKET_VALUE} />
          <Compare title="Percentage-based contributions" tag="How we do it" chosen points={PERCENTAGE} />
        </div>
        <p className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <PointMark kind="pro" /> Pro
          <PointMark kind="con" /> Con
          <PointMark kind="neutral" /> Neutral
        </p>
      </div>

      <div>
        <SubHead title="FAQ" />
        <dl className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {FAQ.map((item) => (
            <Card key={item.q} className="px-5 py-4">
              <dt className="text-[14px] font-semibold text-ink">{item.q}</dt>
              <dd className="mt-1 text-[13px] leading-relaxed text-ink-2">{item.a}</dd>
            </Card>
          ))}
        </dl>
        <p className="mt-3 text-[13px] text-ink-2">
          More details are in the{' '}
          <Link to={RESOURCES} className="font-medium text-accent-ink">
            Resources tab
          </Link>
          .
        </p>
      </div>
    </Section>
  );
}

/** The passive stations that do the big processing runs, in the order the layout card shows them, with what each makes. */
const PROCESSING: [station: string, makes: string][] = [
  ['Loom', 'Cloth strips, for rope'],
  ['Tanning Tub', 'Tanned pelts, for leather'],
  ['Smelter', 'Molten metal, for ingots'],
  ['Kiln', 'Bricks, charcoal and pots'],
];

type StationRow = { id: string; name: string; tier: number; count: number };

/** "Looms", "Animal Hutches", "Apiaries": station names need more than an added "s". */
const stationPlural = (n: number, station: string) =>
  plural(n, station, /(ch|sh|s|x)$/.test(station) ? station + 'es' : /[^aeiou]y$/.test(station) ? station.slice(0, -1) + 'ies' : station + 's');

/**
 * The claim's layout plan, and the passive stations standing so far. The counts come from the
 * buildings list in the shared storage read, so this costs no extra Bitjita calls.
 */
function ClaimLayout({ ctx, stock }: { ctx: GameCtx | null; stock: Loaded<StockSnapshot> & { refresh: () => void } }) {
  const stations = useMemo(() => {
    if (!stock.data || !ctx) return null;
    const { game } = ctx;
    // A passive station is any building type with at least one passive craft (looms, smelters, ovens, hutches...).
    const passive = new Set(game.recipes.flatMap((r) => (r.passive && r.station ? [r.station] : [])));
    const groups = new Map<string, StationRow[]>();
    for (const loc of stock.data.locations) {
      if (loc.id !== 'built') continue;
      for (const [id, count] of loc.items) {
        const type = game.stationType[id];
        const station = type != null ? game.stations[type] : undefined;
        if (!station || !passive.has(station)) continue;
        const thing = game.things[id];
        // The column already says "Looms", so a row reads "Exquisite" rather than "Exquisite Loom".
        const name = thing?.name ?? station;
        const short = name.endsWith(' ' + station) ? name.slice(0, -station.length - 1) : name;
        if (!groups.has(station)) groups.set(station, []);
        groups.get(station)!.push({ id, name: short, tier: thing?.tier ?? 0, count });
      }
    }
    for (const rows of groups.values()) rows.sort((a, b) => b.tier - a.tier || b.count - a.count);
    return groups;
  }, [stock.data, ctx]);

  const countOf = (rows: StationRow[] | undefined) => (rows ?? []).reduce((sum, r) => sum + r.count, 0);
  const total = stations ? [...stations.values()].reduce((sum, rows) => sum + countOf(rows), 0) : 0;
  const others = stations ? [...stations].filter(([station]) => !PROCESSING.some(([p]) => p === station)) : [];

  return (
    <Section id="layout">
      <SectionHead id="layout" eyebrow="Claim layout" title="Passive stations">
        <p>
          Long term, we're building out as many passive stations as we can, laid out to maximize the personal cache and deployables range. This allows passive craft
          processing to be as efficient as possible.
        </p>
      </SectionHead>

      <Card className="mt-5 overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
            <Factory size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink">Passive stations so far</p>
            <p className="num text-xs text-ink-2">{stations ? `${num(total)} in the claim right now` : 'Counting stations…'}</p>
          </div>
          <StorageRead stock={stock} />
        </div>

        {stock.error && !stock.data ? (
          <div className="p-5">
            <Notice tone="warn">The claim's buildings can't be read right now ({stock.error}). Try again in a few minutes.</Notice>
          </div>
        ) : !stations ? (
          <div className="grid grid-cols-2 gap-4 p-5 lg:grid-cols-4">
            {PROCESSING.map(([station]) => (
              <Skeleton key={station} className="h-24" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
              {PROCESSING.map(([station, makes]) => {
                const rows = stations.get(station) ?? [];
                const count = countOf(rows);
                return (
                  <div key={station} className="bg-surface px-4 py-3.5">
                    <div className="flex items-baseline gap-2">
                      <h3 className={cx('text-[16px]', titleFont)}>{stationPlural(count, station)}</h3>
                      <span className="num ml-auto text-[20px] font-semibold text-ink">{num(count)}</span>
                    </div>
                    <p className="text-xs text-muted">{makes}</p>
                    {rows.length ? (
                      <ul className="mt-2.5 space-y-1">
                        {rows.map((r) => (
                          <li key={r.id} className="flex items-center gap-2 text-[13px]">
                            {r.tier ? <TierChip tier={r.tier} /> : null}
                            <span className="min-w-0 flex-1 truncate text-ink">{r.name}</span>
                            <span className="num shrink-0 text-ink-2">{num(r.count)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2.5 text-[13px] text-ink-2">None yet</p>
                    )}
                  </div>
                );
              })}
            </div>
            {others.length > 0 && (
              <p className="border-t border-line px-5 py-2.5 text-xs text-muted">
                Also passive: {others.map(([station, rows]) => `${num(countOf(rows))} ${stationPlural(countOf(rows), station)}`).join(', ')}
              </p>
            )}
          </>
        )}
      </Card>
    </Section>
  );
}

/** A smaller heading inside a section. */
function SubHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h3 className={cx('text-[20px]', titleFont)}>{title}</h3>
      {children && <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{children}</p>}
    </div>
  );
}

const POINT_LABEL = { pro: 'Pro', con: 'Con', neutral: 'Neutral' } as const;

/** The little round marker before a pro, a con or a neutral point. */
function PointMark({ kind }: { kind: Point[0] }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full',
        kind === 'pro' ? 'bg-good-soft text-good' : kind === 'con' ? 'bg-bad-soft text-bad' : 'bg-surface-3 text-muted',
      )}
    >
      {kind === 'pro' ? <Check size={11} strokeWidth={3} /> : kind === 'con' ? <X size={11} strokeWidth={3} /> : <Minus size={11} strokeWidth={3} />}
    </span>
  );
}

function Compare({ title, tag, chosen, points }: { title: string; tag: string; chosen: boolean; points: Point[] }) {
  return (
    <Card className={cx('px-5 py-4', chosen && 'border-accent/60')}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className={cx('text-[17px]', titleFont)}>{title}</h4>
        <Pill tone={chosen ? 'accent' : 'neutral'}>{tag}</Pill>
      </div>
      <ul className="mt-3 space-y-2">
        {points.map(([kind, text]) => (
          <li key={text} className="flex items-start gap-2.5 text-[13px] text-ink-2">
            <span className="mt-0.5">
              <PointMark kind={kind} />
            </span>
            <span>
              <span className="sr-only">{POINT_LABEL[kind]}: </span>
              {text}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
