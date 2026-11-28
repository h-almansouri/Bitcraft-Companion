import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Boxes,
  Eye,
  Gem,
  Lock,
  MessageCircle,
  Repeat,
  Scale,
  Search,
  ShieldCheck,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';
import { mergeMoves } from '../lib/activity.ts';
import { api } from '../lib/api.ts';
import { useCachedBoard } from '../lib/boards.ts';
import { CLAIM, DISCORD_URL, HOME, RESOURCE_HOUSES, isAlt, mainOf, type HouseKind } from '../lib/claim.ts';
import { countedPlayers } from '../lib/derive.ts';
import { ago, day, num, plural } from '../lib/format.ts';
import { useGame, type GameCtx } from '../lib/game.ts';
import { useLoad, type Loaded } from '../lib/hooks.ts';
import { Link } from '../lib/router.tsx';
import type { ChestActivity, ClaimDetail, ClaimMember, Push, StockSnapshot } from '../lib/shapes.ts';
import { Card, Drawer, Notice, Pill, SectionLabel, Skeleton, TierChip, cx, inputBase } from '../ui/kit.tsx';
import { BackButton, JumpBar, Section, SectionBreak, SectionHead, SubHead, jumpTo, titleFont, useLandOnHash } from '../ui/longpage.tsx';
import { StorageRead, useStock } from '../ui/storage.tsx';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'boxes', label: 'Storage boxes' },
  { id: 'claim-house', label: 'Claim house' },
  { id: 'faq', label: 'FAQ' },
  { id: 'tool-house', label: 'Tool house' },
] as const;

/** Short notes on the boxes with a special job, by chest nickname (any case). */
const BOX_NOTES: Record<string, string> = { dropbox: 'Claim push drop-off', food: 'Free food', 'tool mats': 'Tool upgrades' };

/** How many items a box card lists before "and N more". */
const PREVIEW = 5;
/** How many moves the activity list shows at first, and how many more each "Show more" adds. */
const MOVES_SHOWN = 10;
/** Back-to-back moves of the same thing by the same person this close together read as one. */
const MERGE_MINUTES = 5;

interface Item {
  id: string;
  name: string;
  tier: number;
  qty: number;
}

/** One chest on the page: a storage box around the claim, or a chest inside one of the shared houses. */
interface Chest {
  /** The storage location's id in the snapshot. */
  key: string;
  /** The chest's own id in the game, which its log is read by. */
  chestId: string;
  /** The house owner, for a chest inside one of the shared houses. */
  ownerId?: string;
  name: string;
  /** What kind of chest it is ("Sturdy Large Chest"). */
  detail: string;
  /** "Storage box", or the house's name. */
  place: string;
  /** Lowest tier first, then by name. */
  items: Item[];
  total: number;
}

const thingName = (ctx: GameCtx | null, id: string) => ctx?.game.things[id]?.name ?? (ctx ? 'Unknown item' : '…');
const thingTier = (ctx: GameCtx | null, id: string) => ctx?.game.things[id]?.tier ?? 0;

function itemsOf(pairs: [string, number][], ctx: GameCtx | null): Item[] {
  return pairs
    .map(([id, qty]) => ({ id, qty, name: thingName(ctx, id), tier: thingTier(ctx, id) }))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
}

const ownerOf = (kind: HouseKind, members: readonly ClaimMember[] | undefined) =>
  members?.find((m) => m.name.toLowerCase() === RESOURCE_HOUSES[kind].owner.toLowerCase());

/** The storage boxes around the claim and the chests inside each shared house. */
function chestsOf(stock: StockSnapshot | null, members: readonly ClaimMember[] | undefined, ctx: GameCtx | null) {
  if (!stock) return null;
  const chest = (loc: StockSnapshot['locations'][number], chestId: string, place: string, ownerId?: string): Chest => {
    const items = itemsOf(loc.items, ctx);
    return { key: loc.id, chestId, ownerId, name: loc.name.replace(/^House: /, ''), detail: loc.detail, place, items, total: items.reduce((sum, i) => sum + i.qty, 0) };
  };
  const note = (c: Chest) => (BOX_NOTES[c.name.toLowerCase()] ? 0 : 1);
  const boxes = stock.locations
    // Claim storage only: not the "buildings standing" tally, and not the Hexite reserve, which is no one's to take from.
    .filter((loc) => loc.kind === 'claim' && /^b\d+$/.test(loc.id) && !/reserve/i.test(loc.detail))
    .map((loc) => chest(loc, loc.id.slice(1), 'Storage box'))
    .sort((a, b) => note(a) - note(b) || a.name.localeCompare(b.name));
  const house = (kind: HouseKind) => {
    const owner = ownerOf(kind, members);
    if (!owner) return [];
    return stock.locations
      .filter((loc) => loc.kind === 'player' && loc.ownerId === owner.id && loc.id.startsWith('h'))
      .map((loc) => chest(loc, loc.id.split(':')[1] ?? '', RESOURCE_HOUSES[kind].name, owner.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  return { boxes, claim: house('claim'), tools: house('tools') };
}

/**
 * The storage read for this page. It asks for the same members as the About and All pushes
 * pages (plus the two house owners, who are normally among them), so they all share one snapshot.
 */
function useResourceStock(pushes: Push[] | null, claim: Loaded<ClaimDetail>) {
  const open = (pushes ?? []).filter((p) => p.status !== 'done');
  const owners = (Object.keys(RESOURCE_HOUSES) as HouseKind[]).map((k) => ownerOf(k, claim.data?.members)?.id).filter((id): id is string => !!id);
  const players = [...new Set([...open.flatMap((p) => countedPlayers(p, claim.data?.members)), ...owners])].sort();
  // The house owners are found in the member list, so wait for it (or for it to fail).
  return useStock(pushes && !claim.loading ? `stock:${players.join(',')}` : null, players);
}

/** Matches every word of a search, in any order. */
const matches = (name: string, query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = name.toLowerCase();
  return words.every((w) => text.includes(w));
};

/**
 * Claim resources, one long scroll: the storage boxes anyone can use and the admins-only claim
 * house up top, a general FAQ, and the tool house at the bottom for people in tool pushes.
 * Every chest can be opened to see what's inside and its latest deposits and withdrawals.
 */
export function ResourcesPage() {
  const claim = useLoad<ClaimDetail>('claim', () => api.claim());
  const board = useCachedBoard(CLAIM.slug);
  const pushes = board?.pushes ?? null;
  const { ctx } = useGame();
  const stock = useResourceStock(pushes, claim);
  const chests = useMemo(() => chestsOf(stock.data, claim.data?.members, ctx), [stock.data, claim.data, ctx]);
  const [opened, setOpened] = useState<{ chest: Chest; item: string | null } | null>(null);
  const open = (chest: Chest, item: string | null = null) => setOpened({ chest, item });
  useLandOnHash();

  // Claim pushes that count the claim house, so the page can point at them.
  const claimOwner = ownerOf('claim', claim.data?.members);
  const countedBy = (pushes ?? []).filter(
    (p) => p.kind === 'claim-tier' && p.status !== 'done' && !!claimOwner && countedPlayers(p, claim.data?.members).includes(claimOwner.id),
  );

  return (
    <div className="pb-10">
      <Intro />
      <JumpBar sections={SECTIONS} />
      <div className="mt-10">
        <Overview />
        <SectionBreak />
        <StorageBoxes chests={chests} stock={stock} ctx={ctx} onOpen={open} />
        <SectionBreak />
        <ClaimHouse chests={chests?.claim ?? null} found={!!claimOwner || !claim.data} stock={stock} countedBy={countedBy} onOpen={open} />
        <SectionBreak />
        <Faq />
        <SectionBreak />
        <ToolHouse chests={chests?.tools ?? null} found={!!ownerOf('tools', claim.data?.members) || !claim.data} stock={stock} onOpen={open} />
        <SectionBreak />
      </div>
      <ChestDrawer opened={opened} onClose={() => setOpened(null)} onPick={(item) => opened && setOpened({ ...opened, item })} ctx={ctx} />
      <BackButton />
    </div>
  );
}

function Intro() {
  return (
    <section className="relative overflow-hidden rounded-card border border-line bg-surface">
      {/* The same soft gold glow as the About page's header. Decoration only. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse 70% 90% at 0% 0%, var(--accent-soft), transparent 70%)' }} />
      <div className="relative px-5 py-7 sm:px-9 sm:py-9">
        <SectionLabel>Claim resources</SectionLabel>
        <h1 className="mt-1.5 text-[32px] font-semibold leading-tight sm:text-[42px]">Where our stuff lives</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          Everything {CLAIM.name} owns sits in one of three places. Here's who can use what, why it's set up this way, and what's in each one right now.
        </p>
      </div>
    </section>
  );
}

const PLACES: { id: string; icon: ReactNode; title: string; sub?: string; body: string; who: string; tracked: string; tone: 'good' | 'warn' | 'info' }[] = [
  {
    id: 'boxes',
    icon: <Boxes size={18} />,
    title: 'Storage boxes',
    body: 'The chests around the claim, Food included. Take what you need, put in what you like.',
    who: 'Everyone in the claim',
    tracked: 'No',
    tone: 'good',
  },
  {
    id: 'claim-house',
    icon: <Lock size={18} />,
    title: 'Claim house',
    sub: RESOURCE_HOUSES.claim.name,
    body: "The claim's main stockpile, contributions included. Claim pushes count what's in here.",
    who: 'Admins only',
    tracked: 'No',
    tone: 'warn',
  },
  {
    id: 'tool-house',
    icon: <Gem size={18} />,
    title: 'Tool house',
    sub: RESOURCE_HOUSES.tools.name,
    body: 'Just for tool pushes. What you put in and take out counts toward your share.',
    who: 'People in a tool push',
    tracked: 'Yes, every move',
    tone: 'info',
  },
];

function Overview() {
  return (
    <Section id="overview">
      <SectionHead id="overview" eyebrow="Overview" title="Three places, three sets of rules" />
      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
        {PLACES.map((p) => (
          <a key={p.id} href={'#' + p.id} onClick={(e) => jumpTo(p.id, e)} className="group no-underline">
            <Card className="flex h-full flex-col px-5 py-4 transition-colors group-hover:border-accent">
              <span
                className={cx(
                  'flex h-9 w-9 items-center justify-center rounded-lg',
                  p.tone === 'good' ? 'bg-good-soft text-good' : p.tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-info-soft text-info',
                )}
              >
                {p.icon}
              </span>
              <h3 className={cx('mt-3 text-[17px]', titleFont)}>{p.title}</h3>
              {p.sub && <p className="text-xs text-muted">{p.sub}</p>}
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{p.body}</p>
              <dl className="mt-auto grid grid-cols-2 gap-3 border-t border-line pt-3 text-[12px]">
                <div>
                  <dt className="text-muted">Who can take from it</dt>
                  <dd className="mt-0.5 font-semibold text-ink">{p.who}</dd>
                </div>
                <div>
                  <dt className="text-muted">Tracked</dt>
                  <dd className="mt-0.5 font-semibold text-ink">{p.tracked}</dd>
                </div>
              </dl>
            </Card>
          </a>
        ))}
      </div>

      {/* How stock moves between the first two. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-2 border-y border-line py-3.5 text-[13px] text-ink-2">
        <Pill tone="good">Storage boxes</Pill>
        <ArrowRight size={14} className="text-muted" />
        <span>every so often, admins move the extra</span>
        <ArrowRight size={14} className="text-muted" />
        <Pill tone="warn">Claim house</Pill>
        <ArrowRight size={14} className="text-muted" />
        <span>claim pushes count it</span>
      </div>
      <p className="mt-3 flex items-start gap-2 text-[13px] text-ink-2">
        <Eye size={15} className="mt-0.5 shrink-0 text-accent-ink" />
        <span>Wherever it is, anyone can see what's inside and every deposit and withdrawal. Click any chest or item below.</span>
      </p>
    </Section>
  );
}

type StockState = Loaded<StockSnapshot> & { refresh: () => void };

function StorageBoxes({
  chests,
  stock,
  ctx,
  onOpen,
}: {
  chests: ReturnType<typeof chestsOf>;
  stock: StockState;
  ctx: GameCtx | null;
  onOpen: (chest: Chest, item?: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const boxes = chests?.boxes ?? null;
  const shown = boxes && q ? boxes.filter((c) => c.items.some((i) => matches(i.name, q))) : boxes;
  // While searching, say how much of it is also tucked away in the claim house.
  const inHouse = useMemo(() => {
    if (!q || !chests) return [];
    const totals = new Map<string, Item>();
    for (const c of chests.claim)
      for (const i of c.items) {
        if (!matches(i.name, q)) continue;
        const seen = totals.get(i.id);
        totals.set(i.id, seen ? { ...seen, qty: seen.qty + i.qty } : { ...i });
      }
    return [...totals.values()];
  }, [q, chests]);

  return (
    <Section id="boxes">
      <SectionHead id="boxes" eyebrow="Storage boxes" title="Free for everyone in the claim" extra={<Pill tone="good">Open to all members</Pill>}>
        <p>
          Once you've joined the claim, everything in the storage boxes around it is yours to use, Food chest included. Grab what you need to upgrade your gear or finish
          processing something all the way through. You can drop things in too. Nothing here is tracked, so there's no score to keep.
        </p>
        <p>
          We keep the boxes stocked low on purpose. Every so often, an admin moves the extra into the claim house. There's always enough around to use, but if someone takes a
          big chunk, by accident or not, nobody's progress gets wiped out.
        </p>
      </SectionHead>

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <label className="relative min-w-0 flex-1 sm:max-w-xs">
          <span className="sr-only">Find an item in the boxes</span>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an item…" className={cx('h-9 w-full pl-8', inputBase)} />
          {query && (
            <button type="button" aria-label="Clear" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-ink">
              <X size={14} />
            </button>
          )}
        </label>
        <span className="num text-xs text-muted">{boxes ? `${boxes.length} ${plural(boxes.length, 'box', 'boxes')}` : ''}</span>
        <span className="ml-auto flex items-center gap-2.5">
          <StorageRead stock={stock} />
        </span>
      </div>

      {q && inHouse.length > 0 && (
        <p className="mt-3 text-[13px] text-ink-2">
          <span className="font-semibold text-ink">Also in the claim house:</span> {inHouse.map((i) => `${num(i.qty)} ${i.name}`).join(', ')}. Ask an admin if you need some.
        </p>
      )}

      <div className="mt-4">
        {stock.error && !stock.data ? (
          <Notice tone="warn">The boxes can't be read right now ({stock.error}). Try again in a few minutes.</Notice>
        ) : !shown ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-44" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p className="text-[13px] text-ink-2">{q ? `Nothing matching "${q}" in the boxes right now.` : 'No storage boxes showing up in the claim right now.'}</p>
        ) : (
          <ChestGrid chests={shown} query={q} onOpen={onOpen} />
        )}
      </div>
    </Section>
  );
}

function ChestGrid({ chests, query, onOpen }: { chests: Chest[]; query: string; onOpen: (chest: Chest, item?: string | null) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {chests.map((c) => (
        <ChestCard key={c.key} chest={c} query={query} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** A chest at a glance: its biggest stacks (or what matches the search). Click the chest or any item for its activity. */
function ChestCard({ chest, query, onOpen }: { chest: Chest; query: string; onOpen: (chest: Chest, item?: string | null) => void }) {
  const note = BOX_NOTES[chest.name.toLowerCase()];
  const listed = query ? chest.items.filter((i) => matches(i.name, query)) : [...chest.items].sort((a, b) => b.qty - a.qty).slice(0, PREVIEW);
  const rest = chest.items.length - listed.length;
  return (
    <Card className="flex flex-col overflow-hidden">
      <button type="button" onClick={() => onOpen(chest)} className="group flex items-start gap-3 border-b border-line px-4 py-3 text-left transition-colors hover:bg-surface-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-ink">{chest.name}</p>
          <p className="num mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {note && <Pill tone="accent">{note}</Pill>}
            <span>{chest.items.length ? `${num(chest.items.length)} ${plural(chest.items.length, 'kind')} · ${num(chest.total)} total` : 'Empty right now'}</span>
          </p>
        </div>
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent-ink opacity-80 group-hover:opacity-100">
          Activity
          <ArrowRight size={12} />
        </span>
      </button>
      {listed.length > 0 && (
        <ul className="px-2 py-1.5">
          {listed.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpen(chest, item.id)}
                title={`Recent moves of ${item.name}`}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] transition-colors hover:bg-surface-2"
              >
                <span className="flex w-7 shrink-0">{item.tier ? <TierChip tier={item.tier} /> : null}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{item.name}</span>
                <span className="num shrink-0 text-ink-2">{num(item.qty)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {rest > 0 && (
        <button type="button" onClick={() => onOpen(chest)} className="mt-auto border-t border-line px-4 py-2 text-left text-xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
          and {num(rest)} more {plural(rest, 'kind')}
        </button>
      )}
    </Card>
  );
}

/** The live chests of a shared house, or a line saying it isn't set up yet. */
function HouseChests({ kind, chests, found, stock, onOpen }: { kind: HouseKind; chests: Chest[] | null; found: boolean; stock: StockState; onOpen: (chest: Chest, item?: string | null) => void }) {
  const house = RESOURCE_HOUSES[kind];
  const total = chests?.reduce((sum, c) => sum + c.total, 0) ?? 0;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2.5">
        <SubHead title={`What's in ${house.name}`} />
        <span className="ml-auto flex items-center gap-2.5">
          <StorageRead stock={stock} />
        </span>
      </div>
      <div className="mt-3">
        {stock.error && !stock.data ? (
          <Notice tone="warn">The house can't be read right now ({stock.error}). Try again in a few minutes.</Notice>
        ) : !chests ? (
          <Skeleton className="h-28" />
        ) : !found ? (
          <Notice>Couldn't find {house.owner} in the claim, so there's no house to show.</Notice>
        ) : chests.length === 0 ? (
          <Card className="px-5 py-4 text-[13px] text-ink-2">
            Nothing to show yet. Once there are chests in {house.name} with something in them, they'll show up here with everything inside and every deposit and withdrawal.
          </Card>
        ) : (
          <>
            <p className="num mb-3 text-xs text-muted">
              {chests.length} {plural(chests.length, 'chest')} · {num(total)} items in all
            </p>
            <ChestGrid chests={chests} query="" onOpen={onOpen} />
          </>
        )}
      </div>
    </div>
  );
}

function ClaimHouse({
  chests,
  found,
  stock,
  countedBy,
  onOpen,
}: {
  chests: Chest[] | null;
  found: boolean;
  stock: StockState;
  countedBy: Push[];
  onOpen: (chest: Chest, item?: string | null) => void;
}) {
  const house = RESOURCE_HOUSES.claim;
  return (
    <Section id="claim-house" className="space-y-8">
      <SectionHead
        id="claim-house"
        eyebrow="Claim house"
        title="The claim's stockpile"
        extra={
          <Pill tone="warn">
            <Lock size={10} /> Admins only
          </Pill>
        }
      >
        <p>
          Most of the claim's resources live in {house.name}, contributions included. Only admins can get in, so the big piles are safe from slips and grabs.
        </p>
        <p>
          Anyone can still see inside, though. Claim pushes count what's in the house, so when a push's numbers go up or down, you can open the house below and see exactly why.
        </p>
        <p>
          Need something from it? Ask an admin on{' '}
          <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-ink">
            Discord
          </a>{' '}
          and they'll pull it out for you.
        </p>
      </SectionHead>
      {countedBy.length > 0 && (
        <p className="-mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
          <span className="font-semibold text-ink">Counted by:</span>
          {countedBy.map((p) => (
            <Link key={p.slug} to={`${HOME}/${p.slug}`} className="inline-flex items-center gap-1 font-medium text-accent-ink no-underline hover:underline">
              {p.name}
              <ArrowRight size={13} />
            </Link>
          ))}
        </p>
      )}
      <HouseChests kind="claim" chests={chests} found={found} stock={stock} onOpen={onOpen} />
    </Section>
  );
}

const FAQ: { q: string; a: ReactNode }[] = [
  { q: 'Can I take stuff from the boxes?', a: "Yep. Anything in the storage boxes is free for claim members, food included. Take what you need, just remember it's shared." },
  { q: 'Do I have to restock or pay anything back?', a: "Nope. If you've got extras, dropping them in a box always helps, but nobody's keeping score." },
  { q: 'Does anything I put in get tracked?', a: "Only in the tool house, for tool pushes. The boxes and the claim house aren't tracked." },
  {
    q: 'Where did all the [thing] go?',
    a: 'Most likely an admin moved it into the claim house. Open the box above and check its recent activity: every deposit and withdrawal shows who did it and when.',
  },
  {
    q: 'How do I get something from the claim house?',
    a: (
      <>
        Ask an admin on{' '}
        <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-ink">
          Discord
        </a>
        . They'll pull it out for you.
      </>
    ),
  },
  {
    q: 'Why not keep everything in the boxes?',
    a: "One slip, or one bad actor, could empty a box. Keeping the boxes light and the stockpile in the house keeps everyone's progress safe, with plenty still around to use.",
  },
  { q: 'Where do I drop stuff for a claim push?', a: "The Dropbox. The push's numbers pick it up the next time storage is read." },
  {
    q: 'How up to date is this?',
    a: 'Storage is read again every 15 minutes while the page is open, or press refresh. Deposits and withdrawals come from Bitjita, a community data site, and can run a few minutes behind the game.',
  },
];

function Faq() {
  return (
    <Section id="faq">
      <SectionHead id="faq" eyebrow="FAQ" title="Good to know" />
      <dl className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
        {FAQ.map((item) => (
          <Card key={item.q} className="px-5 py-4">
            <dt className="text-[14px] font-semibold text-ink">{item.q}</dt>
            <dd className="mt-1 text-[13px] leading-relaxed text-ink-2">{item.a}</dd>
          </Card>
        ))}
      </dl>
    </Section>
  );
}

const ACCESS: { title: string; body: string }[] = [
  { title: 'Sign up for the push', body: "Tell an admin you're in, and they'll give you access to the house." },
  { title: 'No push, no access', body: "If you're not in the push, you can't get in. That way nothing leaves the house without counting against someone." },
  { title: 'Heading out?', body: "Let an admin know. If you've taken out more than you've put in, square that up first." },
];

const STEPS: { title: string; body: string }[] = [
  { title: 'Put something in', body: "It's credited at that day's market price, averaged across every region." },
  { title: 'Take something out', body: "It counts against you at that day's price. Taking out your own stuff just cancels it, so moving things in and out never earns anything." },
  { title: 'Process it for credit', body: "Take out raw pelts and put back leather, and you're credited the difference. That's your processing." },
  { title: 'Only push materials count', body: "Anything that goes into the tools counts, raw materials included. Anything the push doesn't need earns nothing." },
  { title: 'Split the rolls', body: 'Rolled tools go back in the house so they\'re on record. Your share is your total out of everyone\'s, as tools, gold or a mix.' },
];

const SAFEGUARDS: { icon: ReactNode; title: string; body: string }[] = [
  { icon: <Eye size={15} />, title: "It's all out in the open", body: 'Every deposit and withdrawal shows up on this page, with who and when.' },
  { icon: <Repeat size={15} />, title: 'In and out cancels', body: 'Putting something back after taking it out never counts twice.' },
  { icon: <Scale size={15} />, title: 'Prices across every region', body: "One region's market is easy to push around. All of them together aren't." },
  { icon: <Users size={15} />, title: 'Claim stock earns for the claim', body: "Moving things over from the boxes or the claim house doesn't count for you." },
  { icon: <TriangleAlert size={15} />, title: 'Below zero shows in red', body: "Take out more than you've put in, and your name shows in red for everyone until you've put it back." },
  { icon: <ShieldCheck size={15} />, title: 'Only push materials count', body: 'Dumping in stuff the push doesn\'t need earns nothing.' },
];

const TOOL_FAQ: { q: string; a: string }[] = [
  {
    q: 'How is what I put in valued?',
    a: "At that day's market price: the average sale price across every region over the last week. It's locked in on the day you put it in, so a later price drop won't shrink it.",
  },
  {
    q: 'Why every region and not just Ossura?',
    a: "One region's market is thin enough that a few sales between your own characters could push the price up. Every region together is far harder to move.",
  },
  { q: 'What counts?', a: "Anything that goes into the tools, raw materials included. Anything else earns nothing, so feel free to take it back out." },
  {
    q: 'What if I take something out?',
    a: "Every withdrawal counts. Taking out your own stuff just cancels it at the price you were credited. Taking out more than you've put in counts against you at that day's price.",
  },
  { q: 'What if I put something in, take it out and put it back?', a: 'It only ever counts once, at the price from the first time.' },
  {
    q: "I processed someone else's materials. Do I get credit?",
    a: 'Yes, for the processing. Their raw pelts count against you when you take them, the leather counts for you when you put it back, and you keep the difference. Whoever put the pelts in keeps their credit.',
  },
  { q: 'Do my alts count?', a: 'Yep, for your main. Everything your alts put in or take out goes on your main\'s balance.' },
  {
    q: 'What about things moved from the boxes or the claim house?',
    a: 'They count for the claim, even when an admin moves them. The claim is one participant and gets its share like anyone else. What you bring of your own counts for you.',
  },
  {
    q: 'What does it mean if my name is red?',
    a: "You've taken out more than you've put in, maybe to process it. You don't get a share until you're back above zero, and anything still owed at the end is paid back to the pool.",
  },
  {
    q: 'Who rolls the tools?',
    a: "One character the claim picks. What it takes out to roll counts as used by the pool, not against anyone, and every tool it rolls goes back into the house so it's on record.",
  },
  { q: 'Can I take gold instead of a tool?', a: 'Yep. Take as much of your share as gold as you like. If you pick a tool and have points left over, the rest is paid in gold.' },
  { q: 'What if the rolls go badly?', a: 'Rolls are random, so an unlucky push can be worth less than what went in. Wins and losses are shared.' },
];

function ToolHouse({ chests, found, stock, onOpen }: { chests: Chest[] | null; found: boolean; stock: StockState; onOpen: (chest: Chest, item?: string | null) => void }) {
  const house = RESOURCE_HOUSES.tools;
  return (
    <Section id="tool-house" className="space-y-10">
      <SectionHead id="tool-house" eyebrow="Tool house" title={`${house.name}: just for tool pushes`} extra={<Pill tone="info">Tool push members only</Pill>}>
        <p>
          This part only matters if you're in a tool push, so if you're not, feel free to skip it. {house.name} holds everything for the push, and it's the one place on the claim
          where what you put in and take out is tracked, so everyone gets a fair cut of what's rolled.
        </p>
        <p>The tracker that does the math is still being built. Until it's live, the house's deposit and withdrawal log further down is the record.</p>
        <p>
          <Link to={`${HOME}#tool-pushes`} className="inline-flex items-center gap-1 font-medium text-accent-ink no-underline hover:underline">
            How tool pushes work
            <ArrowRight size={13} />
          </Link>
        </p>
      </SectionHead>

      <div>
        <SubHead title="Who gets in" />
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {ACCESS.map((a) => (
            <Card key={a.title} className="px-5 py-4">
              <h4 className={cx('text-[16px]', titleFont)}>{a.title}</h4>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{a.body}</p>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <SubHead title="How your share is counted" />
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
        <p className="mt-3 rounded-lg border border-line bg-surface-2 px-4.5 py-3.5 text-[13px] leading-relaxed text-ink-2">
          <span className="font-semibold text-ink">The claim chips in too.</span> It can stock shared inputs, like tannin, so you don't have to make them, and anything moved
          over from the boxes or the claim house counts for the claim rather than whoever carried it. When the claim comes out ahead, everyone does.
        </p>
      </div>

      <div>
        <SubHead title="Keeping it fair" />
        {/* Its own box rather than a Card, so the gold border isn't overridden by the card's hairline. */}
        <div className="mt-4 rounded-card border border-accent/60 bg-surface px-5 py-5 sm:px-6" style={{ backgroundImage: 'linear-gradient(to right, var(--accent-soft), transparent 60%)' }}>
          <h4 className={cx('text-[19px]', titleFont)}>Honestly? We trust you.</h4>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
            We trust everyone to use their best judgment. If someone's trying to game the system, this claim just isn't for them. Tool pushes are meant to benefit everyone:
            nobody should feel taken advantage of, and no one person should get to take advantage of everyone else.
          </p>
        </div>
        <p className="mt-4 text-[13px] text-ink-2">A few things keep it honest anyway:</p>
        <ul className="mt-3 grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2 lg:grid-cols-3">
          {SAFEGUARDS.map((s) => (
            <li key={s.title} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">{s.icon}</span>
              <span className="text-[13px] leading-relaxed text-ink-2">
                <span className="block font-semibold text-ink">{s.title}</span>
                {s.body}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <HouseChests kind="tools" chests={chests} found={found} stock={stock} onOpen={onOpen} />

      <div>
        <SubHead title="Tool house FAQ" />
        <dl className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {TOOL_FAQ.map((item) => (
            <Card key={item.q} className="px-5 py-4">
              <dt className="text-[14px] font-semibold text-ink">{item.q}</dt>
              <dd className="mt-1 text-[13px] leading-relaxed text-ink-2">{item.a}</dd>
            </Card>
          ))}
        </dl>
        <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-2">
          <MessageCircle size={14} className="text-accent-ink" />
          Something not covered?{' '}
          <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-ink">
            Ask on Discord
          </a>
        </p>
      </div>
    </Section>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** A chest opened: its latest deposits and withdrawals (all, or one item's) and everything inside. */
function ChestDrawer({
  opened,
  onClose,
  onPick,
  ctx,
}: {
  opened: { chest: Chest; item: string | null } | null;
  onClose: () => void;
  onPick: (item: string | null) => void;
  ctx: GameCtx | null;
}) {
  const chest = opened?.chest ?? null;
  const item = opened?.item ?? null;
  const activity = useLoad<ChestActivity>(chest ? `activity:${chest.chestId}` : null, () => api.activity(chest!.chestId, chest!.ownerId));
  const [limit, setLimit] = useState(MOVES_SHOWN);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => setLimit(MOVES_SHOWN), [chest?.key, item]);

  const groups = useMemo(() => mergeMoves((activity.data?.moves ?? []).filter((m) => !item || m.item === item), MERGE_MINUTES), [activity.data, item]);
  const all = activity.data?.moves ?? [];
  const oldest = all.length ? all[all.length - 1].at : null;
  const pick = (id: string | null) => {
    onPick(id);
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <Drawer
      open={!!chest}
      onClose={onClose}
      title={
        chest && (
          <>
            <p className={cx('truncate text-[18px] leading-tight', titleFont)}>{chest.name}</p>
            <p className="mt-0.5 text-xs text-muted">{[chest.place, chest.detail].filter(Boolean).join(' · ')}</p>
          </>
        )
      }
    >
      {chest && (
        <>
          <div ref={top} className="scroll-mt-4">
            <div className="flex flex-wrap items-center gap-2">
              <SectionLabel>Recent activity</SectionLabel>
              {item && (
                <button
                  type="button"
                  onClick={() => pick(null)}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-accent bg-accent-soft px-2 text-[11px] font-medium text-accent-ink"
                  aria-label={`Show every item, not just ${thingName(ctx, item)}`}
                >
                  {thingName(ctx, item)}
                  <X size={11} />
                </button>
              )}
            </div>

            {activity.loading && !activity.data ? (
              <div className="mt-3 space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : activity.error ? (
              <div className="mt-3">
                <Notice tone="warn">Couldn't load this chest's activity ({activity.error}).</Notice>
              </div>
            ) : groups.length === 0 ? (
              <p className="mt-3 text-[13px] text-ink-2">
                {item ? `No deposits or withdrawals of ${thingName(ctx, item)} in what's been logged here.` : 'Nothing logged for this chest yet.'}
              </p>
            ) : (
              <>
                <ul className="mt-2 divide-y divide-line">
                  {groups.slice(0, limit).map((g, i) => {
                    const main = isAlt(g.who) ? mainOf(g.who) : undefined;
                    return (
                      <li key={`${g.at}:${i}`} className="flex items-center gap-3 py-2.5">
                        <span
                          className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', g.kind === 'in' ? 'bg-good-soft text-good' : 'bg-surface-3 text-ink-2')}
                          aria-label={g.kind === 'in' ? 'Put in' : 'Taken out'}
                        >
                          {g.kind === 'in' ? <ArrowDownToLine size={14} /> : <ArrowUpFromLine size={14} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink">
                            <span className={cx('num shrink-0 font-semibold', g.kind === 'in' ? 'text-good' : 'text-ink')}>
                              {g.kind === 'in' ? '+' : '−'}
                              {num(g.qty)}
                            </span>
                            {item ? (
                              <span className="truncate">{thingName(ctx, g.item)}</span>
                            ) : (
                              <button type="button" onClick={() => pick(g.item)} className="truncate text-left hover:text-accent-ink hover:underline" title="Only show this item">
                                {thingName(ctx, g.item)}
                              </button>
                            )}
                          </p>
                          <p className="truncate text-xs text-muted">
                            {g.kind === 'in' ? 'Put in by ' : 'Taken by '}
                            <span className="text-ink-2">{g.who}</span>
                            {main && ` (${main}'s alt)`}
                            {g.trips > 1 && ` · ${g.trips} trips`}
                          </p>
                        </div>
                        <time dateTime={g.at} title={g.trips > 1 ? `${when(g.from)} to ${when(g.at)}` : when(g.at)} className="shrink-0 text-xs text-muted">
                          {ago(g.at)}
                        </time>
                      </li>
                    );
                  })}
                </ul>
                {groups.length > limit && (
                  <button type="button" onClick={() => setLimit(limit + MOVES_SHOWN)} className="mt-1 text-xs font-medium text-accent-ink hover:underline">
                    Show {Math.min(MOVES_SHOWN, groups.length - limit)} more
                  </button>
                )}
              </>
            )}
            {activity.data && (
              <p className="mt-3 text-[11px] leading-snug text-muted">
                From Bitjita, read {ago(activity.data.at)}.
                {oldest && (activity.data.more ? ` Covers the latest ${num(all.length)} moves, back to ${day(oldest)}.` : ` Goes back to ${day(oldest)}.`)}
              </p>
            )}
          </div>

          <div className="mt-6 border-t border-line pt-4">
            <div className="flex items-baseline gap-2">
              <SectionLabel>In this chest</SectionLabel>
              <span className="num text-[11px] text-muted">{chest.items.length ? `${num(chest.total)} total` : ''}</span>
            </div>
            {chest.items.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-2">Empty right now.</p>
            ) : (
              <ul className="mt-2">
                {chest.items.map((i) => (
                  <li key={i.id}>
                    <button
                      type="button"
                      onClick={() => pick(item === i.id ? null : i.id)}
                      aria-pressed={item === i.id}
                      className={cx(
                        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors',
                        item === i.id ? 'bg-accent-soft text-accent-ink' : 'hover:bg-surface-2',
                      )}
                    >
                      <span className="flex w-7 shrink-0">{i.tier ? <TierChip tier={i.tier} /> : null}</span>
                      <span className="min-w-0 flex-1 truncate">{i.name}</span>
                      <span className="num shrink-0 text-ink-2">{num(i.qty)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-muted">Click an item to see only its deposits and withdrawals.</p>
          </div>
        </>
      )}
    </Drawer>
  );
}
