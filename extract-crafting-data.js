// One-time script: fetch bitcraft-timer.com planner chunk and extract items+recipes
// Run: node extract-crafting-data.js
const https = require('https');
const fs = require('fs');
const path = require('path');

const SITE = 'https://bitcraft-timer.com';
// The planner data lives in a lazy-loaded chunk whose hashed filename changes every time the site
// rebuilds (e.g. after a game update). Rather than hardcode it, we discover it: scan the planner
// page's chunk references and pick the one that actually contains the items + recipes arrays.
const DATA_PAGES = ['/planner', '/'];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function findDataChunk() {
  const seen = new Set();
  const candidates = [];
  for (const page of DATA_PAGES) {
    let html;
    try { html = await fetchText(SITE + page); } catch (e) { continue; }
    (html.match(/\/_next\/static\/chunks\/[A-Za-z0-9._-]+\.js/g) || []).forEach(u => {
      if (!seen.has(u)) { seen.add(u); candidates.push(u); }
    });
  }
  console.log(`Probing ${candidates.length} candidate chunks for the data markers…`);
  for (const u of candidates) {
    let text;
    try { text = await fetchText(SITE + u); } catch (e) { continue; }
    if (text.includes('d=[{id:') && text.includes('Assemble Empty Bucket')) {
      console.log(`  found data chunk: ${u} (${(text.length/1024/1024).toFixed(2)} MB)`);
      return text;
    }
  }
  return null;
}

function extractArray(text, startMarker, endMarker) {
  const idx = text.indexOf(startMarker);
  if (idx < 0) return null;
  // walk back to find opening [
  let start = idx;
  while (start > 0 && text[start] !== '[') start--;
  if (endMarker) {
    const endIdx = text.indexOf(endMarker, idx);
    if (endIdx > 0) return text.slice(start, endIdx + 1);
  }
  // bracket-balance to find end
  let depth = 0, i = start, end = -1;
  while (i < text.length) {
    if (text[i] === '[' || text[i] === '{') depth++;
    else if (text[i] === ']' || text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    i++;
  }
  return end > 0 ? text.slice(start, end + 1) : null;
}

(async () => {
  console.log('Discovering crafting-data chunk on bitcraft-timer.com...');
  const text = await findDataChunk();
  if (!text) { console.error('Could not locate the data chunk (site structure may have changed).'); process.exit(1); }

  // Extract items array: starts at "d=[{id:" ends before "],r=new Map(d.map"
  console.log('Extracting items...');
  const dIdx = text.indexOf('d=[{id:');
  const dEnd = text.indexOf('],r=new Map(d.map');
  if (dIdx < 0 || dEnd < 0) { console.error('Could not find items array'); process.exit(1); }
  const itemsRaw = text.slice(dIdx + 2, dEnd + 1); // skip "d=" to get "[{id:...]"

  // Extract recipes array (starts with o=[{id:1e3)
  console.log('Extracting recipes...');
  const recipesRaw = extractArray(text, 'id:1e3,name:"Assemble Empty Bucket"', null);
  if (!recipesRaw) { console.error('Could not find recipes array'); process.exit(1); }

  // Eval both arrays
  console.log('Parsing items...');
  let items, recipes;
  try {
    items = eval(itemsRaw);
    console.log(`  ${items.length} items`);
  } catch (e) {
    console.error('Failed to parse items:', e.message);
    process.exit(1);
  }
  try {
    recipes = eval(recipesRaw);
    console.log(`  ${recipes.length} recipes`);
  } catch (e) {
    console.error('Failed to parse recipes:', e.message);
    process.exit(1);
  }

  // Hardcoded skills (extracted from bitcraft-timer.com React fiber)
  const skills = [
    {id:1, name:"ANY"},
    {id:2, name:"Forestry"},
    {id:3, name:"Carpentry"},
    {id:4, name:"Masonry"},
    {id:5, name:"Mining"},
    {id:6, name:"Smithing"},
    {id:7, name:"Scholar"},
    {id:8, name:"Leatherworking"},
    {id:9, name:"Hunting"},
    {id:10, name:"Tailoring"},
    {id:11, name:"Farming"},
    {id:12, name:"Fishing"},
    {id:13, name:"Cooking"},
    {id:14, name:"Foraging"},
    {id:15, name:"Construction"},
    {id:17, name:"Taming"},
    {id:18, name:"Slayer"},
    {id:19, name:"Merchanting"},
    {id:21, name:"Sailing"},
    {id:22, name:"Hexite Gathering"}
  ];

  // Strip iconAssetName to save space (not needed for planner)
  const cleanItems = items.map(i => ({
    id: i.id, name: i.name, description: i.description,
    tier: i.tier, tag: i.tag, rarity: i.rarity, iconAssetName: i.iconAssetName
  }));

  const out = { items: cleanItems, recipes, skills, extractedAt: Date.now() };
  const outPath = path.join(__dirname, 'craftingData.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`Saved to ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MB)`);
})();
