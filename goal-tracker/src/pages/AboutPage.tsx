import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { ArrowRight, Check, Compass, Gem, Hammer, Hexagon, Trophy, TriangleAlert, Utensils, Warehouse, X } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useCachedBoard } from '../lib/boards.ts';
import { CLAIM, FREE_FOOD_CHESTS, HOME, MARKET_REGION } from '../lib/claim.ts';
import { buildView, countedPlayers } from '../lib/derive.ts';
import { TIER_NAMES, day, num, pct } from '../lib/format.ts';
import { useGame, type GameCtx } from '../lib/game.ts';
import { useLoad, type Loaded } from '../lib/hooks.ts';
import { Link } from '../lib/router.tsx';
import type { ClaimDetail, Push, StockSnapshot } from '../lib/shapes.ts';
import { Bar, Card, Notice, Pill, SectionLabel, Skeleton, TierChip, cx } from '../ui/kit.tsx';
import { StorageRead, useStock } from '../ui/storage.tsx';
import { KIND_LABEL } from './BoardPage.tsx';

const PUSHES = HOME + '/pushes';

/**
 * Facts about the group, in one place so they are easy to correct.
 * Tier, members and supplies are read live; these are not.
 */
const GROUP = {
  home: 'Rocky Gardens',
  /** EA2 track record. The Mythic count is Chelsey's recollection ("6 or 7") until checked. */
  ea2: { pushes: 3, mythics: '6+' },
  /** The tier that opens Mythic tool pushes, and the one the trading hub waits for. */
  mythicTier: 6,
  hubTier: 7,
};

/** The page's sections, in order. The bar under the header jumps between them. */
const SECTIONS = [
  { id: 'offer', label: 'What we offer' },
  { id: 'us', label: 'Who we are' },
  { id: 'open', label: 'Out in the open' },
  { id: 'food', label: 'Food' },
  { id: 'tool-pushes', label: 'Tool pushes' },
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

/** Smooth-scrolls to a section without stacking up history entries. */
function jumpTo(id: string, event?: MouseEvent) {
  const target = document.getElementById(id);
  if (!target) return;
  event?.preventDefault();
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
  const region = claim.data?.region || board?.region || MARKET_REGION.name;

  // Opening the page at /nowhere#food lands on Food once it has rendered.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, []);

  return (
    <div className="pb-10">
      <Hero claim={claim.data} region={region} />
      <JumpBar />
      <div className="mt-10 space-y-16">
        <WhatWeOffer />
        <WhoWeAre claim={claim.data} pushes={pushes ?? []} />
        <OutInTheOpen pushes={pushes ?? []} members={claim.data?.members} ctx={ctx} stock={stock.data} loading={stock.loading} />
        <FreeFood ctx={ctx} stock={stock} />
        <ToolPushes />
      </div>
    </div>
  );
}

function Hero({ claim, region }: { claim: ClaimDetail | null; region: string }) {
  const stats: [string, ReactNode][] = [
    ['Claim tier', claim ? <span style={{ color: `color-mix(in oklab, var(--tier-${claim.tier}) 82%, var(--ink))` }}>Tier {claim.tier}</span> : null],
    ['Members', claim ? num(claim.members.length) : null],
    ['Home', `${GROUP.home}, R${MARKET_REGION.id}`],
    ['Supplies', claim ? num(claim.supplies) : null],
  ];
  return (
    <section className="relative overflow-hidden rounded-card border border-line bg-surface">
      {/* A soft teal glow and a large faint hexagon behind the words. Decoration only. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse 70% 90% at 0% 0%, var(--accent-soft), transparent 70%)' }} />
      <Hexagon aria-hidden="true" strokeWidth={0.6} className="pointer-events-none absolute -right-16 -top-20 hidden text-accent opacity-[0.07] sm:block" size={360} />

      <div className="relative px-5 pb-6 pt-8 sm:px-9 sm:pb-8 sm:pt-11">
        <SectionLabel className="text-accent-ink">
          BitCraft claim · {GROUP.home}, {region} (R{MARKET_REGION.id})
        </SectionLabel>
        <h1 className="mt-2 text-[34px] font-semibold leading-tight tracking-tight sm:text-[44px]">{CLAIM.name}</h1>
        <p className="mt-3 max-w-[60ch] text-[15px] leading-relaxed text-ink-2 sm:text-base">
          We're a small community of active players building something together. Free food and basic tool upgrades are on us, so you can spend your time playing the way you
          want to, with people who've got your back.
        </p>
        <div className="mt-6 flex flex-wrap gap-2.5">
          <Link to={PUSHES} className="inline-flex h-10 items-center gap-1.5 rounded-md border border-accent bg-accent-dim px-4 text-[13px] font-medium text-accent-ink no-underline transition-colors hover:bg-accent hover:text-white">
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

        <dl className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
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

/** Heading block shared by every section. */
function SectionHead({ id, eyebrow, title, children, extra }: { id?: SectionId; eyebrow: string; title: string; children?: ReactNode; extra?: ReactNode }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SectionLabel>{eyebrow}</SectionLabel>
        {extra}
      </div>
      <h2 id={id ? `${id}-title` : undefined} className="mt-1.5 text-xl font-semibold tracking-tight text-ink sm:text-[22px]">
        {title}
      </h2>
      {children && <div className="mt-2 max-w-[68ch] space-y-2 text-[14px] leading-relaxed text-ink-2">{children}</div>}
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

const OFFERS: { icon: ReactNode; title: string; body: string; jump?: SectionId }[] = [
  { icon: <Utensils size={18} />, title: 'Free food', body: "There's always food in the claim's free stock. Grab what you need, no asking.", jump: 'food' },
  { icon: <Hammer size={18} />, title: 'Free basic tool upgrades', body: 'Basic tool upgrades are on the house, so a worn-out tool never holds you back.' },
  { icon: <Compass size={18} />, title: 'Play your way', body: "No obligation to play a certain way. Level whatever you like, or nothing at all. Solo's welcome too." },
  {
    icon: <Gem size={18} />,
    title: 'Optional tool pushes',
    body: "Want in on Mythic tools? Tool pushes track who put in what so everyone gets a fair cut. That's the only thing we track.",
    jump: 'tool-pushes',
  },
];

function WhatWeOffer() {
  return (
    <Section id="offer">
      <SectionHead id="offer" eyebrow="What we offer" title="Everything you need to play your way.">
        <p>Nobody gets handed a job here. The claim is set up to back you up, whatever you feel like doing today.</p>
      </SectionHead>
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {OFFERS.map((o) => {
          const card = (
            <Card className={cx('h-full px-5 py-4', o.jump && 'transition-colors group-hover:border-accent')}>
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">{o.icon}</span>
              <h3 className="mt-3 text-[15px] font-semibold text-ink">{o.title}</h3>
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
  { title: 'Tier 5 claim', note: 'In our first two weeks', reachedAt: 5 },
  { title: 'A road from the ocean to the swamp', done: true },
  { title: 'A tool push', note: 'Rolling tools for everyone right now', now: true },
  { title: `Tier ${GROUP.mythicTier}`, note: 'Unlocks Mythic tool pushes', reachedAt: GROUP.mythicTier },
  { title: 'The Storehouse and trader stands', note: 'Free food and mats in one spot, and stands that make traveler tasks quick and easy' },
  { title: `Tier ${GROUP.hubTier}`, note: 'The region bank and market, and an oceanside trading hub for other regions', reachedAt: GROUP.hubTier, goal: true },
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
      <SectionHead id="us" eyebrow="Who we are" title="A small crew with big plans.">
        <p>
          Five of us started Nowhere: a mix of EA2 veterans and people brand new to BitCraft. Two weeks in, we had a tier 5 claim. We've made our home in the {GROUP.home} in{' '}
          {MARKET_REGION.name} (R{MARKET_REGION.id}), and we've built a road from the ocean to the swamp.
        </p>
        <p>
          Back in EA2 we ran {GROUP.ea2.pushes} Mythic tool pushes and rolled {GROUP.ea2.mythics} Mythic tools between us. We're itching to do it again once we hit tier{' '}
          {GROUP.mythicTier}. The big dream is tier {GROUP.hubTier}: the region bank and market, and an oceanside trading hub for players from other regions.
        </p>
      </SectionHead>

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

function OutInTheOpen({ pushes, members, ctx, stock, loading }: { pushes: Push[]; members: Members; ctx: GameCtx | null; stock: StockSnapshot | null; loading: boolean }) {
  const open = pushes.filter((p) => p.status === 'active' || p.status === 'planned');
  const done = pushes.filter((p) => p.status === 'done');
  return (
    <Section id="open">
      <SectionHead id="open" eyebrow="Out in the open" title="Nothing's hidden.">
        <p>
          Every push lives on this site: what we're going for, how far along we are, and what's still needed. If something catches your eye, put your name on it with the
          "Who's on it" picker, or drop materials in the Dropbox. Nobody's going to check up on you, and if you'd rather just do your own thing, that's totally fine.
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

      <div className="mt-6 rounded-lg border border-line bg-surface-2 px-4.5 py-3.5 text-[13px] leading-relaxed text-ink-2">
        <span className="font-semibold text-ink">House rules?</span> Not many. Be a team player, be respectful, and no hate speech of any kind. Play by the game's rules too (no
        hacking or cheating), and beyond that, use your best judgment.
      </div>
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

function FreeFood({ ctx, stock }: { ctx: GameCtx | null; stock: Loaded<StockSnapshot> & { refresh: () => void } }) {
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

  const servings = tiers?.reduce((sum, t) => sum + t.total, 0) ?? 0;
  const found = stock.data?.locations.some((l) => l.kind === 'claim' && FREE_FOOD_CHESTS.includes(l.name));

  return (
    <Section id="food">
      <SectionHead id="food" eyebrow="Food" title="Hungry? It's on us.">
        <p>Anything in the {FREE_FOOD_CHESTS.join(' and ')} chest is free to take. Here's what's in there right now.</p>
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
                      <span className="min-w-0 flex-1 text-ink">{item.name}</span>
                      <span className="num shrink-0 text-ink-2">{num(item.qty)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-3 flex gap-3.5 rounded-lg border border-dashed border-line-2 px-4.5 py-4">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2">
          <Warehouse size={16} />
        </span>
        <div className="text-[13px] leading-relaxed text-ink-2">
          <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
            The Storehouse <Pill tone="warn">Coming soon</Pill>
          </p>
          <p className="mt-1">
            We're building a Storehouse: a barter stand stocked with free food and materials, plus a drop box for anything you want to give. Most chests around the claim
            aren't open to everyone, so the Storehouse will be the one place to grab and drop. Trader stands are on the list too, so traveler tasks get quick and easy.
          </p>
        </div>
      </div>
    </Section>
  );
}

const TOOL_CARDS = [
  ['A share, not a buy-back', 'You get your percentage of every tool the push rolls, as tools or as gold.', 'accent'],
  ['Usually comes out ahead', 'In EA2, the tools we rolled were usually worth more than the raw materials that went in.', 'good'],
  ['You can get back less', 'Rolls are random. An unlucky push can be worth less than what you put in.', 'warn'],
] as const;

const STEPS: { title: string; body: string }[] = [
  { title: 'We call a push', body: "The goal and the materials it takes go up on this site, so everyone can see what's needed and how far along it is." },
  {
    title: 'You hand in materials',
    body: `Drop them in the push's drop box. Each hand-in gets logged and priced at that day's ${MARKET_REGION.name} (R${MARKET_REGION.id}) market value, and that price is locked in.`,
  },
  { title: 'Your share is set', body: "Everyone's gold value gets added up. Put in 15% of the total and you own 15% of what comes out." },
  { title: 'We roll', body: 'The materials become tools. Every tool the push rolls goes into the haul: Mythic, Legendary, Epic and everything below.' },
  { title: 'We split the haul', body: 'You get your share as tools, as gold at market value, or a mix of both.' },
];

/** The worked example. Everyone hands in the same; only the luck of the rolls changes. */
const EXAMPLE = { yours: 60_000, total: 400_000 };
const OUTCOMES = [
  { title: 'A lucky push', haul: 520_000, tone: 'good' as const },
  { title: 'An unlucky push', haul: 340_000, tone: 'bad' as const },
];

const FAQ: { q: string; a: string }[] = [
  { q: 'Do I have to join one?', a: 'Nope. Tool pushes are optional like everything else here, and the free basic tool upgrades are yours either way.' },
  { q: 'How little can I put in?', a: 'Any amount. A smaller hand-in just means a smaller share.' },
  {
    q: 'Which price counts?',
    a: `The ${MARKET_REGION.name} (R${MARKET_REGION.id}) market value on the day you hand something in. It's locked in, so a price swing later can't shrink what you put in.`,
  },
  { q: 'Can I take gold instead of a tool?', a: 'Yes. Tools, gold at market value, or a mix of the two.' },
];

/** How a Mythic tool push works, at the bottom of the page for anyone weighing whether to join one. */
function ToolPushes() {
  const share = EXAMPLE.yours / EXAMPLE.total;
  const toTop = (e: MouseEvent) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    window.history.replaceState(null, '', window.location.pathname);
  };
  return (
    <Section id="tool-pushes" className="space-y-10">
      <div>
        <SectionHead id="tool-pushes" eyebrow="Mythic tool pushes" title="Pool materials, share the haul." extra={<Pill tone="info">Starts at tier {GROUP.mythicTier}</Pill>}>
          <p>
            Mythic tools take a mountain of materials and a lot of luck, so we roll them together. Once we hit tier {GROUP.mythicTier}, anyone who wants in can chip in materials
            and get a share of everything the push rolls. It's the one thing we keep track of, so everyone gets a fair cut. We share the wins, and we share the risk.
          </p>
        </SectionHead>
        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
          {TOOL_CARDS.map(([title, body, tone]) => (
            <Card key={title} className="px-5 py-4">
              <span className={cx('block h-1 w-8 rounded-full', tone === 'accent' ? 'bg-accent' : tone === 'good' ? 'bg-good' : 'bg-warn')} />
              <h3 className="mt-3 text-[14px] font-semibold text-ink">{title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{body}</p>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <SubHead title="Step by step" />
        <ol className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {STEPS.map((step, i) => (
            <li key={step.title}>
              <Card className="h-full px-4 py-4">
                <span className="num flex h-7 w-7 items-center justify-center rounded-full border border-accent text-[13px] font-semibold text-accent-ink">{i + 1}</span>
                <h4 className="mt-3 text-[14px] font-semibold text-ink">{step.title}</h4>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{step.body}</p>
              </Card>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[13px] text-muted">A tracker on this site will log hand-ins and prices for us. It's in the works.</p>
      </div>

      <div>
        <SubHead title="Why a share, and not a buy-back?">
          We could just pay you market value for your materials. We don't, because in EA2 the tools we rolled (Mythic, Legendary, Epic and down) were usually worth more at
          market than the raw materials that went in. A share lets everyone ride that, and it keeps a push feeling like a group thing.
        </SubHead>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Compare title="A buy-back" tag="Not how we do it" good={false} lines={['You get exactly what your materials were worth', 'Lucky rolls go to the claim, not to you', "You can't come out ahead"]} />
          <Compare
            title="A share of the haul"
            tag="How we do it"
            good
            lines={['You get your percentage of everything the push rolls', 'A lucky push lifts everyone who chipped in', 'An unlucky push is shared too, so you can get back less']}
          />
        </div>
      </div>

      <div>
        <SubHead title="Same hand-in, two different pushes">
          Say you hand in {num(EXAMPLE.yours)} gold of materials out of {num(EXAMPLE.total)} gold in total. That's a {Math.round(share * 100)}% share, and what it's worth depends on
          what the push rolls.
        </SubHead>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {OUTCOMES.map((o) => (
            <Outcome key={o.title} title={o.title} haul={o.haul} tone={o.tone} share={share} />
          ))}
        </div>
      </div>

      <div className="flex gap-3.5 rounded-card border border-warn/40 bg-warn-soft px-5 py-4">
        <TriangleAlert size={20} className="mt-0.5 shrink-0 text-warn" />
        <div className="text-[14px] leading-relaxed text-ink-2">
          <p className="font-semibold text-warn">Heads up: you can get back less than you put in.</p>
          <p className="mt-1">
            Rolls are random, and a push can roll tools worth less than the materials that went in. Our EA2 pushes usually came out ahead, but that's a track record, not a
            promise. Put in what you're happy to share the risk on.
          </p>
        </div>
      </div>

      <div>
        <SubHead title="Good to know" />
        <dl className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {FAQ.map((item) => (
            <Card key={item.q} className="px-5 py-4">
              <dt className="text-[14px] font-semibold text-ink">{item.q}</dt>
              <dd className="mt-1 text-[13px] leading-relaxed text-ink-2">{item.a}</dd>
            </Card>
          ))}
        </dl>
      </div>

      <a href={HOME} onClick={toTop} className="inline-flex text-[13px] font-medium text-accent-ink no-underline hover:underline">
        Back to top
      </a>
    </Section>
  );
}

/** A smaller heading inside a section. */
function SubHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h3 className="text-[16px] font-semibold text-ink">{title}</h3>
      {children && <p className="mt-1.5 max-w-[68ch] text-[14px] leading-relaxed text-ink-2">{children}</p>}
    </div>
  );
}

function Compare({ title, tag, good, lines }: { title: string; tag: string; good: boolean; lines: string[] }) {
  return (
    <Card className={cx('px-5 py-4', good && 'border-accent/60')}>
      <div className="flex items-center gap-2">
        <h4 className="text-[15px] font-semibold text-ink">{title}</h4>
        <Pill tone={good ? 'accent' : 'neutral'}>{tag}</Pill>
      </div>
      <ul className="mt-3 space-y-2">
        {lines.map((line) => (
          <li key={line} className="flex items-start gap-2.5 text-[13px] text-ink-2">
            <span className={cx('mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full', good ? 'bg-accent-soft text-accent-ink' : 'bg-surface-3 text-muted')}>
              {good ? <Check size={11} strokeWidth={3} /> : <X size={11} strokeWidth={3} />}
            </span>
            {line}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Outcome({ title, haul, tone, share }: { title: string; haul: number; tone: 'good' | 'bad'; share: number }) {
  const cut = Math.round(haul * share);
  const diff = cut - EXAMPLE.yours;
  const widest = Math.max(haul, EXAMPLE.total);
  const bars: [string, number, string][] = [
    ['Materials in', EXAMPLE.total, 'var(--line-2)'],
    ['Tools rolled', haul, tone === 'good' ? 'var(--good)' : 'var(--bad)'],
  ];
  return (
    <Card className="px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[15px] font-semibold text-ink">{title}</h4>
        <span className={cx('num text-[13px] font-semibold', tone === 'good' ? 'text-good' : 'text-bad')}>
          {haul > EXAMPLE.total ? '+' : '−'}
          {Math.round((Math.abs(haul - EXAMPLE.total) / EXAMPLE.total) * 100)}% vs. materials
        </span>
      </div>
      <div className="mt-4 space-y-2">
        {bars.map(([label, value, color]) => (
          <div key={label} className="flex items-center gap-3">
            <span className="w-[84px] shrink-0 text-xs text-ink-2">{label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full" style={{ width: `${(value / widest) * 100}%`, background: color }} />
            </div>
            <span className="num w-[64px] shrink-0 text-right text-[13px] text-ink">{num(value)}</span>
          </div>
        ))}
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">You put in</dt>
          <dd className="num mt-0.5 text-[15px] font-semibold text-ink">{num(EXAMPLE.yours)}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">You get</dt>
          <dd className="num mt-0.5 text-[15px] font-semibold text-ink">{num(cut)}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Difference</dt>
          <dd className={cx('num mt-0.5 text-[15px] font-semibold', diff >= 0 ? 'text-good' : 'text-bad')}>
            {diff >= 0 ? '+' : '−'}
            {num(Math.abs(diff))}
          </dd>
        </div>
      </dl>
    </Card>
  );
}
