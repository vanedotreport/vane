// Vane — Phase 0c. Scan a range of blocks, with a FILTER FUNNEL.
//
// Zero results is an ambiguous answer: it means either "no sandwiches here" or "one of my filters
// is wrong." A funnel disambiguates. Every triple that dies is counted at the stage that killed
// it, so a broken guard shows up as a stage that eats everything.
//
// Base rate for calibration: ~3,782 sandwiches/day chain-wide over ~172,800 slots/day
// => roughly one per 45 blocks. A 60-block scan should surface ~1.

import { writeFileSync } from "node:fs";
const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const START = Number(process.argv[2]);
const COUNT = Number(process.argv[3] ?? 60);

async function rpc(method, params, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * a)); continue; }
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (a === tries) return null; await new Promise(r => setTimeout(r, 900 * a)); }
  }
}

const cpmmOut = (d, x, y, bps) => { const n = (d * BigInt(10000 - bps)) / 10000n; return (y * n) / (x + n); };
function deriveFee(x, y, dIn, dOut) {
  let best = null;
  for (let bps = 0; bps <= 100; bps++) {
    const p = cpmmOut(dIn, x, y, bps);
    const err = p > dOut ? p - dOut : dOut - p;
    const rel = Number(err) / Math.max(1, Number(dOut));
    if (!best || rel < best.rel) best = { bps, rel };
  }
  return best;
}

const census = { blocks: 0, tx: 0, failed: 0, noTok: 0, noPair: 0, swapTx: 0 };
// Funnel: every candidate triple is counted at the stage that rejected it.
const funnel = { triples: 0, dirVictim: 0, dirBack: 0, victimIsAttacker: 0, noLink: 0, feeUnfit: 0, noLoss: 0, PASS: 0 };
const found = [];

function swapsFromBlock(blk) {
  const out = [];
  blk.transactions.forEach((tx, index) => {
    census.tx++;
    if (tx.meta?.err) { census.failed++; return; }
    const pre = tx.meta?.preTokenBalances ?? [], post = tx.meta?.postTokenBalances ?? [];
    if (!pre.length || !post.length) { census.noTok++; return; }
    const preM = new Map(pre.map(b => [String(b.accountIndex), b]));
    const byOwner = new Map();
    for (const b of post) {
      const p = preM.get(String(b.accountIndex));
      if (!p || !b.owner) continue;
      const delta = BigInt(b.uiTokenAmount.amount) - BigInt(p.uiTokenAmount.amount);
      if (delta === 0n) continue;
      (byOwner.get(b.owner) ?? byOwner.set(b.owner, []).get(b.owner)).push({
        mint: b.mint, delta, before: BigInt(p.uiTokenAmount.amount), dec: b.uiTokenAmount.decimals });
    }
    const signer = tx.transaction.message.accountKeys.find(a => a.signer)?.pubkey ?? "?";
    let hit = false;
    for (const [owner, legs] of byOwner) {
      if (legs.length !== 2 || owner === signer) continue;
      const [a, b] = legs;
      if ((a.delta > 0n) === (b.delta > 0n)) continue;
      const inL = a.delta > 0n ? a : b, outL = a.delta > 0n ? b : a;
      hit = true;
      out.push({ index, sig: tx.transaction.signatures[0], signer, pool: owner,
        inMint: inL.mint, outMint: outL.mint, x: inL.before, y: outL.before,
        dIn: inL.delta, dOut: -outL.delta, inDec: inL.dec, outDec: outL.dec });
    }
    if (hit) census.swapTx++; else census.noPair++;
  });
  return out;
}

process.stdout.write(`scanning ${COUNT} blocks from ${START}\n`);
for (let s = START; s < START + COUNT; s++) {
  const blk = await rpc("getBlock", [s, { encoding: "jsonParsed", transactionDetails: "full",
    rewards: false, maxSupportedTransactionVersion: 0 }]);
  if (!blk) { process.stdout.write("."); continue; }
  census.blocks++;
  const swaps = swapsFromBlock(blk);

  const byPool = new Map();
  for (const sw of swaps) {
    const key = `${sw.pool}|${[sw.inMint, sw.outMint].sort().join("|")}`;
    (byPool.get(key) ?? byPool.set(key, []).get(key)).push(sw);
  }
  for (const [key, list] of byPool) {
    if (list.length < 3) continue;
    list.sort((a, b) => a.index - b.index);
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        for (let k = j + 1; k < list.length; k++) {
          const [f, v, b] = [list[i], list[j], list[k]];
          funnel.triples++;
          if (f.inMint !== v.inMint) { funnel.dirVictim++; continue; }
          if (f.inMint === b.inMint) { funnel.dirBack++; continue; }
          if (v.signer === f.signer || v.signer === b.signer) { funnel.victimIsAttacker++; continue; }
          if (f.signer !== b.signer) { funnel.noLink++; continue; }
          const fee = deriveFee(f.x, f.y, f.dIn, f.dOut);
          if (fee.rel > 0.001) { funnel.feeUnfit++; continue; }
          const cf = cpmmOut(v.dIn, f.x, f.y, fee.bps);
          const loss = cf - v.dOut;
          if (loss <= 0n) { funnel.noLoss++; continue; }
          funnel.PASS++;
          found.push({ slot: s, pool: key.split("|")[0], fee: fee.bps, feeRel: fee.rel,
            attacker: f.signer, victim: v.signer, victimSig: v.sig,
            fIdx: f.index, vIdx: v.index, bIdx: b.index,
            got: v.dOut.toString(), cf: cf.toString(), loss: loss.toString(),
            outDec: v.outDec, outMint: v.outMint,
            pct: Number(loss) / Number(cf) * 100 });
        }
  }
  process.stdout.write(found.length ? "!" : "#");
}
process.stdout.write("\n\n");

console.log("--- census ---");
for (const [k, v] of Object.entries(census)) console.log(`  ${k.padEnd(10)} ${v}`);
console.log(`  reconciles ${census.failed + census.noTok + census.noPair + census.swapTx === census.tx ? "yes" : "NO"}`);

console.log("\n--- filter funnel (where triples die) ---");
for (const [k, v] of Object.entries(funnel)) {
  const pct = funnel.triples ? (v / funnel.triples * 100).toFixed(2) : "0";
  console.log(`  ${k.padEnd(18)} ${String(v).padStart(8)}  ${pct}%`);
}

const fmt = (v, d) => (Number(v) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: 6 });
console.log(`\n--- confirmed: ${found.length} ---`);
for (const [n, c] of found.entries()) {
  console.log(`\n#${n + 1}  slot ${c.slot}  pool ${c.pool.slice(0, 8)}…  fee ${c.fee}bps (residual ${(c.feeRel * 100).toFixed(4)}%)`);
  console.log(`    attacker ${c.attacker.slice(0, 12)}…  victim ${c.victim.slice(0, 12)}…`);
  console.log(`    tx order  front #${c.fIdx}  victim #${c.vIdx}  back #${c.bIdx}`);
  console.log(`    got      ${fmt(c.got, c.outDec)}`);
  console.log(`    should   ${fmt(c.cf, c.outDec)}`);
  console.log(`    LOSS     ${fmt(c.loss, c.outDec)}  (${c.pct.toFixed(3)}%)  mint ${c.outMint.slice(0, 8)}…`);
  console.log(`    victim   ${c.victimSig}`);
}
writeFileSync("found.json", JSON.stringify({ census, funnel, found }, null, 1));
console.log("\nwrote found.json");
