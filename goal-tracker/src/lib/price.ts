import type { TradePrice } from '../engine/gamedata.ts';
import type { Ref } from '../engine/types.ts';
import { num } from './format.ts';

/** Hex Coins, the game's money. The site calls it gold. */
export const COINS: Ref = 'i.1';

/** How many trades it takes to end up with `qty`, since one trade can hand over several at once. */
export const tradesFor = (price: TradePrice, qty: number) => Math.ceil(Math.ceil(qty - 1e-9) / price.per - 1e-9);

/** Gold that buying `qty` costs (0 when the trader wants something other than coins). */
export const goldFor = (price: TradePrice, qty: number) =>
  qty > 0 ? tradesFor(price, qty) * price.cost.filter((s) => s.id === COINS).reduce((sum, s) => sum + s.qty, 0) : 0;

/** What `trades` trades take, written out: "8,000 gold", or "16 Hermit Crab Shell" for a swap. */
export function costText(price: TradePrice, trades: number, nameOf: (id: Ref) => string): string {
  return price.cost.map((s) => `${num(s.qty * trades)} ${s.id === COINS ? 'gold' : nameOf(s.id)}`).join(' + ');
}

/** The price tag: "1,000 gold each", or "500 gold per 10" when one trade hands over several. */
export const eachText = (price: TradePrice, nameOf: (id: Ref) => string) => `${costText(price, 1, nameOf)} ${price.per === 1 ? 'each' : `per ${num(price.per)}`}`;
