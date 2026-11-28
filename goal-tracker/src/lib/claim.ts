/**
 * This is an internal tool for one claim. Both the site and the server read the
 * claim from here, and the server refuses to look up anything else.
 */
export const CLAIM = {
  /** The claim's id in the game (and on Bitjita). */
  id: '576460753011209206',
  /** Its place in the address bar: /nowhere/claim-t5-push */
  slug: 'nowhere',
  name: 'Nowhere',
} as const;

/**
 * The site lives inside the Companion app, which serves everything under /nowhere
 * from here (see server/embed.ts) and keeps every other address for itself.
 */
export const HOME = '/' + CLAIM.slug;
/** The site's own API. The Companion's /api/… is its pass-through to Bitjita, a different thing. */
export const API = HOME + '/api';
/** Pages of the site that sit where a push's address would, so no push may take these names. */
export const RESERVED_SLUGS = ['travelers', 'pushes', 'api', 'assets'];

/**
 * Chests whose contents members may take for free, listed live on the front page.
 * When the Storehouse's barter stand exists, it replaces the Food chest here.
 */
export const FREE_FOOD_CHESTS = ['Food'];

/** The claim's home region. Tool push hand-ins are priced across every region, not this one. */
export const MARKET_REGION = { id: 8, name: 'Ossura' } as const;

/**
 * Who's who: each person in the claim, their alts, and who gets the credit. This is the one
 * list to keep up to date when someone adds or swaps a character. Alts still count wherever
 * storage is counted. People pickers ("Who's on it", the person filter) offer the main only,
 * written "Velcruza (+ Vel, Cynth)"; head counts count people; and anything an alt hands in
 * to a tool push counts for the main. Anyone not listed is their own main.
 */
export const ROSTER: readonly { main: string; alts?: readonly string[] }[] = [
  { main: 'Velcruza', alts: ['Vel', 'Cynth'] },
  { main: 'chels', alts: ['pumapance'] },
  { main: 'skyediver', alts: ['whitelinx'] },
  { main: 'Frostyy' },
  { main: 'Silentstorm' },
];
const MAIN_OF = new Map(ROSTER.flatMap((p) => (p.alts ?? []).map((alt) => [alt.toLowerCase(), p.main] as const)));
/** The person a character belongs to, by in-game name (any case). */
export const mainOf = (name: string) => MAIN_OF.get(name.toLowerCase()) ?? name;
export const isAlt = (name: string) => MAIN_OF.has(name.toLowerCase());
/** A main's alts, by in-game name. */
export const altsOf = (name: string): readonly string[] => ROSTER.find((p) => p.main.toLowerCase() === name.toLowerCase())?.alts ?? [];
/** "Velcruza (+ Vel, Cynth)": a person and their alts, for people pickers. */
export function withAlts(name: string) {
  const alts = altsOf(name);
  return alts.length ? `${name} (+ ${alts.join(', ')})` : name;
}
/** Members split into people and their alts, for head counts. */
export function playersAndAlts<T extends { name: string }>(members: readonly T[]) {
  return { players: members.filter((m) => !isAlt(m.name)), alts: members.filter((m) => isAlt(m.name)) };
}

/** Where to find Nowhere on Discord. Shown in the About page header and the sidebar. */
export const DISCORD_URL = 'https://discord.gg/BFtdkDPmSy';
