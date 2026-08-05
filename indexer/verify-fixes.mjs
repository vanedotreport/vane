// Does the new parser actually fix the two bugs? Run it against real mainnet transactions and
// compare, rather than trusting that the code reads correctly.

import { readFileSync } from "node:fs";
import { extractMints, extractSwaps, byVenue, largestExtraction } from "./src/parse.mjs";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
async function rpc(m, p, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1400 * a)); continue; }
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (a === tries) return null; await new Promise(s => setTimeout(s, 800 * a)); }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===========================================================================
console.log("\n=== BUG 04 · fee payer is not the creator ===\n");

const rows = readFileSync("../data/mints-24h.ndjson", "utf8").trim().split("\n").map(JSON.parse);
const sample = rows.slice(0, 18);

let agree = 0, differ = 0, unresolved = 0, revokedInTx = 0;
const table = [];
for (const r of sample) {
  const tx = await rpc("getTransaction", [r.sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  await sleep(120);
  if (!tx) continue;
  const found = extractMints(tx, r.slot, r.time).find(m => m.mint === r.mint);
  if (!found) continue;

  const oldWay = r.creator;                 // what the previous indexer stored: the fee payer
  const newWay = found.creator;
  if (found.mintAuthorityRevoked) revokedInTx++;
  if (newWay === null) unresolved++;
  else if (newWay === oldWay) agree++;
  else differ++;

  table.push({ mint: r.mint.slice(0, 8), old: oldWay?.slice(0, 8) ?? "—",
               neu: newWay?.slice(0, 8) ?? "NULL", src: found.creator_source ?? found.source,
               cands: found.candidates.length, revoked: found.mintAuthorityRevoked });
}
console.log("  mint      fee-payer  resolved   source              cands  authRevoked");
for (const t of table)
  console.log(`  ${t.mint}  ${t.old.padEnd(9)}  ${t.neu.padEnd(9)}  ${String(t.src).padEnd(18)}  ${t.cands}      ${t.revoked}`);
console.log(`\n  same as fee payer : ${agree}`);
console.log(`  DIFFERENT         : ${differ}   <- these were attributed to the wrong wallet before`);
console.log(`  unresolved (null) : ${unresolved}   <- refuses to guess rather than naming someone wrong`);
console.log(`\n  mint authority revoked IN the creating tx: ${revokedInTx}/${table.length}`);
console.log(`  (the old indexer read initializeMint and reported 0/40 — it was reading the wrong moment)`);

// ===========================================================================
console.log("\n\n=== BUG 03 · a token trades on more than one pool ===\n");

const MINT = process.argv[2] ?? "HgsmQA1PXDVfBjps5UQkuXW8J26kSEkKPFWc44BrRChs";
let sigs = [], before = null;
while (sigs.length < 300) {
  const p = { limit: 300 - sigs.length }; if (before) p.before = before;
  const r = await rpc("getSignaturesForAddress", [MINT, p]);
  if (!r?.length) break;
  sigs.push(...r); before = r[r.length - 1].signature;
  if (r.length < p.limit) break;
}
sigs.reverse();

const tape = [];
for (const s of sigs) {
  const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  await sleep(70);
  if (!tx) continue;
  for (const sw of extractSwaps(tx, { mintFilter: MINT }))
    tape.push({ ...sw, slot: s.slot, index: 0, time: s.blockTime });
}

const venues = byVenue(tape);
console.log(`  ${tape.length} trades across ${venues.length} venue(s) — previously merged into one series\n`);
for (const v of venues) {
  const unit = v.quoteMint === "So11111111111111111111111111111111111111112" ? "SOL" : v.quoteMint.slice(0, 4) + "…";
  const nat = v.trades[0].native ? " native" : "";
  console.log(`  ${v.pool.slice(0, 12)}…  ${String(v.trades.length).padStart(4)} trades  ${v.volume.toFixed(3)} ${unit}${nat}`);
}

if (venues.length) {
  const v = venues[0];
  const { peak, floor, worst } = largestExtraction(v);
  const unit = v.quoteMint === "So11111111111111111111111111111111111111112" ? "SOL" : "quote";
  console.log(`\n  primary venue only:`);
  console.log(`    peak liquidity  ${peak.toFixed(4)} ${unit}`);
  console.log(`    dust floor      ${floor.toFixed(4)} ${unit}   <- sells below this cannot win on percentage`);
  if (!worst) console.log(`    largest sell    none above the floor — it bled out rather than being dumped`);
  else {
    console.log(`    largest sell    ${worst.took.toFixed(4)} of ${worst.poolBefore.toFixed(4)} = ${(worst.share * 100).toFixed(1)}%`);
    console.log(`    seller          ${worst.signer}`);
  }
  console.log(`\n  before the fix this reported "66.7% of pool liquidity in ONE transaction"`);
  console.log(`  from a 2-lamport dust trade in a different pool.`);
}
