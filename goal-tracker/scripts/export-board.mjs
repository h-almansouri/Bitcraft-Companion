// Saves the board from a running copy of the site into seed/board.json, so it can
// travel with the code to another host. A server whose storage is empty fills itself
// from that file when it starts (see server/embed.ts).
//
//   npm run export-board                      from the copy running on this computer
//   npm run export-board -- https://example   from any other running copy
//
// The password is never part of it: set a new one on the new site.
import { mkdirSync, writeFileSync } from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/+$/, '');
const res = await fetch(`${base}/nowhere/api/boards/nowhere`);
if (!res.ok) {
  console.error(`Could not read the board from ${base} (${res.status}). Is the site running there?`);
  process.exit(1);
}
const { locked, temporary, keyHash, ...board } = await res.json();
mkdirSync('seed', { recursive: true });
writeFileSync('seed/board.json', JSON.stringify(board, null, 2) + '\n');
console.log(`Saved ${board.pushes.length} push(es) to seed/board.json: ${board.pushes.map((p) => `${p.name} (${p.goals.length} goals)`).join(', ') || 'none'}`);
if (locked) console.log('That board has a password. It was not exported; set one on the new site.');
