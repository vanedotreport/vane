// Vane — outcome tracker. The experiment the whole thesis rests on.
//
// Take tokens indexed at birth, look at them 24h later, and ask whether anything observable AT
// LAUNCH predicted what happened. If nothing does, the product is a horoscope and this is the
// cheapest possible way to find that out.
//
// Outcome is deliberately mechanical: SILENCE. A token nobody has traded in hours is finished,
// whatever its chart says. No price feed, no "rug" judgement, no intent claim — just whether
// anyone is still there.

import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const FILE = process.argv[2] ?? "mints-24h.ndjson";
const SILENT_HOURS = Number(process.argv[3] ?? 6);   // no activity for this long = finished

let calls = 0;
async function rpc(m, p, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      if (r.status === 429) { await sleep(1400 * a); continue; }
      const j = await r.json();
      calls++;
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (a === tries) return null; await sleep(700 * a); }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const rows = readFileSync(FILE, "utf8").trim().split("\n").map(l => JSON.parse(l));
// A creator with several mints in one 80-second window is a launch bot, not a founder.
const creatorCount = new Map();
for (const r of rows) creatorCount.set(r.creator, (creatorCount.get(r.creator) ?? 0) + 1);

const now = Date.now() / 1000;
console.log(`tracking ${rows.length} mints created ~${((now - rows[0].time) / 3600).toFixed(1)}h ago`);
console.log(`"finished" = no transaction in the last ${SILENT_HOURS}h\n`);

const out = [];
for (const r of rows) {
  const sigs = await rpc("getSignaturesForAddress", [r.mint, { limit: 1000 }]);
  await sleep(110);
  const largest = await rpc("getTokenLargestAccounts", [r.mint]);
  await sleep(110);

  const lastTime = sigs?.length ? sigs[0].blockTime : r.time;
  const silentH = (now - lastTime) / 3600;
  const ageH = (now - r.time) / 3600;
  const txs = sigs?.length ?? 0;

  // concentration: top holder as a share of all held supply
  let topShare = null;
  const accts = largest?.value ?? [];
  if (accts.length) {
    const total = accts.reduce((a, b) => a + BigInt(b.amount), 0n);
    if (total > 0n) topShare = Number(BigInt(accts[0].amount) * 10000n / total) / 100;
  }

  out.push({
    mint: r.mint, creator: r.creator, venue: r.venue,
    freeze: !!r.freezeAuthority,
    repeatCreator: creatorCount.get(r.creator) > 1,
    ageH, txs, silentH, topShare,
    finished: silentH > SILENT_HOURS,
  });
  process.stdout.write(out[out.length - 1].finished ? "x" : "o");
}
process.stdout.write("\n\n");

const n = out.length, fin = out.filter(o => o.finished).length;
console.log(`--- outcome at ~24h ---`);
console.log(`  finished   ${fin}/${n}  (${(fin / n * 100).toFixed(0)}%)`);
console.log(`  still live ${n - fin}/${n}`);
console.log(`  median lifetime txs: ${out.map(o => o.txs).sort((a, b) => a - b)[Math.floor(n / 2)]}`);

// ---- does anything observable at launch predict it? ----
function split(name, pred) {
  const yes = out.filter(pred), no = out.filter(o => !pred(o));
  if (!yes.length || !no.length) { console.log(`  ${name.padEnd(26)} n/a (${yes.length} vs ${no.length})`); return null; }
  const ry = yes.filter(o => o.finished).length / yes.length;
  const rn = no.filter(o => o.finished).length / no.length;
  // Wilson lower bound on the difference is overkill at n=47; report raw with counts so the
  // reader can see how thin it is.
  console.log(`  ${name.padEnd(26)} ${(ry * 100).toFixed(0)}% of ${String(yes.length).padStart(3)} vs ${(rn * 100).toFixed(0)}% of ${String(no.length).padStart(3)}   Δ${((ry - rn) * 100).toFixed(0)}pp`);
  return { name, ry, rn, ny: yes.length, nn: no.length, delta: ry - rn };
}

console.log(`\n--- launch-time signal vs outcome (finished rate) ---`);
const signals = [
  split("freeze authority set", o => o.freeze),
  split("creator made >1 that minute", o => o.repeatCreator),
  split("venue: Pump.fun", o => o.venue.includes("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")),
  split("venue: Meteora DBC", o => o.venue.includes("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN")),
].filter(Boolean);

console.log(`\n--- activity distribution ---`);
for (const b of [[0, 10], [10, 100], [100, 1000], [1000, 1e9]]) {
  const c = out.filter(o => o.txs >= b[0] && o.txs < b[1]);
  const f = c.filter(o => o.finished).length;
  if (c.length) console.log(`  ${String(b[0]).padStart(5)}-${b[1] > 1e8 ? "  ∞" : String(b[1]).padStart(4)} txs: ${String(c.length).padStart(3)} tokens, ${f} finished`);
}

const conc = out.filter(o => o.topShare !== null);
if (conc.length) {
  const hi = conc.filter(o => o.topShare > 80);
  console.log(`\n  top holder >80% of supply: ${hi.length}/${conc.length}, ${hi.filter(o => o.finished).length} finished`);
}

writeFileSync("outcomes.json", JSON.stringify({ silentHours: SILENT_HOURS, n, finished: fin, signals, out }, null, 1));
console.log(`\nwrote outcomes.json  [${calls} rpc calls]`);
console.log(`\nCAVEAT: n=${n}, one 80-second slice of one day. Directional at best — this is the`);
console.log(`method working, not a result worth publishing.`);
