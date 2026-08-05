// Vane — Phase 0b. Scan a whole block for sandwich patterns across EVERY pool.
//
// One getBlock call, no pool chosen in advance, no instruction decoding. Pools are discovered
// from the shape of the balance changes: any account-owner whose two token accounts move in
// opposite directions inside one transaction is behaving like an AMM vault pair.
//
// Every transaction is accounted for. The previous script silently dropped failures and lost 14
// of 23 candidates without saying so — which is the exact bug class this product exists to catch,
// so the census below is not optional.

import { writeFileSync } from "node:fs";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const SLOT = Number(process.argv[2] ?? 437293821);

async function rpc(method, params, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const res = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 1200 * a)); continue; }
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (a === tries) throw e; await new Promise(r => setTimeout(r, 900 * a)); }
  }
}

const cpmmOut = (d, x, y, bps) => {
  const n = (d * BigInt(10000 - bps)) / 10000n;
  return (y * n) / (x + n);
};

function deriveFeeBps(x, y, dIn, dOut) {
  let best = null;
  for (let bps = 0; bps <= 100; bps++) {
    const pred = cpmmOut(dIn, x, y, bps);
    const err = pred > dOut ? pred - dOut : dOut - pred;
    const rel = Number(err) / Math.max(1, Number(dOut));
    if (!best || rel < best.rel) best = { bps, rel };
  }
  return best;
}

console.log(`Vane phase 0b — full-block sandwich scan, slot ${SLOT}\n`);
console.time("getBlock");
const blk = await rpc("getBlock", [SLOT, {
  encoding: "jsonParsed", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 0,
}]);
console.timeEnd("getBlock");
if (!blk) { console.log("no block"); process.exit(1); }

// ---- census. every transaction lands in exactly one bucket ----
const census = { total: 0, failed: 0, noTokenBalances: 0, noVaultPair: 0, swap: 0 };
const swaps = [];   // one row per (tx, pool) swap

blk.transactions.forEach((tx, index) => {
  census.total++;
  if (tx.meta?.err) { census.failed++; return; }
  const pre = tx.meta?.preTokenBalances ?? [], post = tx.meta?.postTokenBalances ?? [];
  if (!pre.length || !post.length) { census.noTokenBalances++; return; }

  const k = (b) => `${b.accountIndex}`;
  const preM = new Map(pre.map(b => [k(b), b]));
  const byOwner = new Map();
  for (const b of post) {
    const p = preM.get(k(b));
    if (!p || !b.owner) continue;
    const delta = BigInt(b.uiTokenAmount.amount) - BigInt(p.uiTokenAmount.amount);
    if (delta === 0n) continue;
    if (!byOwner.has(b.owner)) byOwner.set(b.owner, []);
    byOwner.get(b.owner).push({
      mint: b.mint, delta,
      before: BigInt(p.uiTokenAmount.amount),
      dec: b.uiTokenAmount.decimals,
    });
  }

  const signer = tx.transaction.message.accountKeys.find(a => a.signer)?.pubkey ?? "?";
  let hit = false;
  for (const [owner, legs] of byOwner) {
    if (legs.length !== 2) continue;                       // vault pair only
    const [a, b] = legs;
    if ((a.delta > 0n) === (b.delta > 0n)) continue;       // must be opposite directions
    const inLeg = a.delta > 0n ? a : b, outLeg = a.delta > 0n ? b : a;
    if (owner === signer) continue;                        // the trader's own wallet, not a pool
    hit = true;
    swaps.push({
      index, sig: tx.transaction.signatures[0], signer, pool: owner,
      inMint: inLeg.mint, outMint: outLeg.mint,
      x: inLeg.before, y: outLeg.before,
      dIn: inLeg.delta, dOut: -outLeg.delta,
      inDec: inLeg.dec, outDec: outLeg.dec,
    });
  }
  if (hit) census.swap++; else census.noVaultPair++;
});

console.log("--- census (every transaction accounted for) ---");
for (const [k2, v] of Object.entries(census)) console.log(`  ${k2.padEnd(18)} ${v}`);
const sum = census.failed + census.noTokenBalances + census.noVaultPair + census.swap;
console.log(`  ${"reconciles".padEnd(18)} ${sum === census.total ? "yes" : `NO (${sum} vs ${census.total})`}`);
console.log(`\n${swaps.length} swap legs across ${new Set(swaps.map(s => s.pool)).size} pools\n`);

// ---- group by pool, look for the pattern ----
const byPool = new Map();
for (const s of swaps) {
  const key = `${s.pool}|${[s.inMint, s.outMint].sort().join("|")}`;
  if (!byPool.has(key)) byPool.set(key, []);
  byPool.get(key).push(s);
}

const busy = [...byPool.entries()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length);
console.log(`${busy.length} pools with >=3 swaps in this block\n`);

const fmt = (v, d) => (Number(v) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: 6 });
const found = [];

for (const [key, list] of busy) {
  list.sort((a, b) => a.index - b.index);
  const pool = key.split("|")[0];

  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      for (let k = j + 1; k < list.length; k++) {
        const [f, v, b] = [list[i], list[j], list[k]];
        if (f.inMint !== v.inMint) continue;          // victim pushes the same way
        if (f.inMint === b.inMint) continue;          // backrun reverses
        if (v.signer === f.signer || v.signer === b.signer) continue;
        if (f.signer !== b.signer) continue;          // strict link for v1

        const fee = deriveFeeBps(f.x, f.y, f.dIn, f.dOut);
        if (fee.rel > 0.001) continue;                // model doesn't fit this pool — refuse to guess
        const cf = cpmmOut(v.dIn, f.x, f.y, fee.bps);
        const loss = cf - v.dOut;
        if (loss <= 0n) continue;

        found.push({ pool, f, v, b, fee, cf, loss });
      }
}

console.log(`--- sandwich candidates: ${found.length} ---`);
for (const [n, c] of found.entries()) {
  const { f, v, b } = c;
  console.log(`\n#${n + 1}  pool ${c.pool.slice(0, 8)}…   fee ${c.fee.bps}bps (residual ${(c.fee.rel * 100).toFixed(4)}%)`);
  console.log(`    attacker ${f.signer.slice(0, 10)}…   victim ${v.signer.slice(0, 10)}…`);
  console.log(`    front  #${f.index}  ${fmt(f.dIn, f.inDec)} ${f.inMint.slice(0, 4)}… -> ${fmt(f.dOut, f.outDec)} ${f.outMint.slice(0, 4)}…`);
  console.log(`    victim #${v.index}  ${fmt(v.dIn, v.inDec)} ${v.inMint.slice(0, 4)}… -> ${fmt(v.dOut, v.outDec)} ${v.outMint.slice(0, 4)}…`);
  console.log(`    back   #${b.index}  ${fmt(b.dIn, b.inDec)} ${b.inMint.slice(0, 4)}… -> ${fmt(b.dOut, b.outDec)} ${b.outMint.slice(0, 4)}…`);
  console.log(`    victim got      ${fmt(v.dOut, v.outDec)}`);
  console.log(`    would have got  ${fmt(c.cf, v.outDec)}`);
  console.log(`    LOSS            ${fmt(c.loss, v.outDec)}  (${(Number(c.loss) / Number(c.cf) * 100).toFixed(3)}%)`);
  console.log(`    victim sig      ${v.sig}`);
}

writeFileSync(`block-${SLOT}.json`, JSON.stringify({ census, poolCount: byPool.size, busy: busy.length, found: found.length }, null, 1));
console.log(`\nwrote block-${SLOT}.json`);
