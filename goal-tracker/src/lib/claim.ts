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

/** The market Mythic tool push hand-ins are priced against: the claim's own region. */
export const MARKET_REGION = { id: 8, name: 'Ossura' } as const;
