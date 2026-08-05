// Vane — Phase 0d. Attack my own results.
//
// Two problems visible in the scan output that would have shipped as confident numbers:
//
//   A. CONTAMINATED COUNTERFACTUAL. The frontrun and backrun are hundreds of transaction slots
//      apart (#674 -> #1136), not adjacent. If any OTHER swap hit the pool between the frontrun
//      and the victim, then replaying the victim against pre-frontrun reserves attributes
//      everyone else's price impact to the attacker. The loss figure would be inflated and
//      nobody downstream could tell.
//      Test: reserves before the victim must equal reserves after the frontrun, exactly.
//
//   B. FEE MODEL DOESN'T FIT. Candidate #3 derived a 100 bps fee — the top of the search range —
//      with a residual 30x worse than the others. That is the signature of a pool that is NOT
//      constant product. A boundary hit is a model failure, not a measurement.
//
// Both become confidence signals rather than silent errors.

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";

async function rpc(m, p, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * a)); continue; }
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (a === tries) return null; await new Promise(s => setTimeout(s, 900 * a)); }
  }
}

const cpmmOut = (d, x, y, bps) => { const n = (d * BigInt(10000 - bps)) / 10000n; return (y * n) / (x + n); };
function deriveFee(x, y, dIn, dOut) {
  let best = null;
  for (let bps = 0; bps <= 100; bps++) {
    const p = cpmmOut(dIn, x, y, bps);
    const e = p > dOut ? p - dOut : dOut - p;
    const rel = Number(e) / Math.max(1, Number(dOut));
    if (!best || rel < best.rel) best = { bps, rel };
  }
  return best;
}
const fmt = (v, d) => (Number(v) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: 6 });

function poolSwaps(blk, poolWanted) {
  const out = [];
  blk.transactions.forEach((tx, index) => {
    if (tx.meta?.err) return;
    const pre = tx.meta?.preTokenBalances ?? [], post = tx.meta?.postTokenBalances ?? [];
    if (!pre.length) return;
    const preM = new Map(pre.map(b => [String(b.accountIndex), b]));
    const byOwner = new Map();
    for (const b of post) {
      const p = preM.get(String(b.accountIndex));
      if (!p || !b.owner || b.owner !== poolWanted) continue;
      const delta = BigInt(b.uiTokenAmount.amount) - BigInt(p.uiTokenAmount.amount);
      if (delta === 0n) continue;
      (byOwner.get(b.owner) ?? byOwner.set(b.owner, []).get(b.owner)).push({
        mint: b.mint, delta, before: BigInt(p.uiTokenAmount.amount),
        after: BigInt(b.uiTokenAmount.amount), dec: b.uiTokenAmount.decimals });
    }
    const legs = byOwner.get(poolWanted);
    if (!legs || legs.length !== 2) return;
    const [a, b2] = legs;
    if ((a.delta > 0n) === (b2.delta > 0n)) return;
    const inL = a.delta > 0n ? a : b2, outL = a.delta > 0n ? b2 : a;
    out.push({ index, signer: tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey,
      sig: tx.transaction.signatures[0], inMint: inL.mint, outMint: outL.mint,
      xBefore: inL.before, yBefore: outL.before, xAfter: inL.after, yAfter: outL.after,
      dIn: inL.delta, dOut: -outL.delta, inDec: inL.dec, outDec: outL.dec });
  });
  return out.sort((a, b) => a.index - b.index);
}

const CASES = [
  { slot: 437293767, pool: "2wjWYTu2", label: "#1/#2 two victims, one bracket" },
  { slot: 437293770, pool: "MFQ1P4Wc", label: "#3 suspicious 100bps fit" },
  { slot: 437293808, pool: "A8gK3z8D", label: "#4/#5 two victims, one bracket" },
];

const { found } = JSON.parse(await import("node:fs").then(f => f.promises.readFile("found.json", "utf8")));

for (const c of CASES) {
  const hits = found.filter(f => f.slot === c.slot && f.pool.startsWith(c.pool));
  const pool = hits[0].pool;
  console.log(`\n${"=".repeat(78)}\nslot ${c.slot}  pool ${pool.slice(0, 12)}…   ${c.label}`);
  const blk = await rpc("getBlock", [c.slot, { encoding: "jsonParsed", transactionDetails: "full",
    rewards: false, maxSupportedTransactionVersion: 0 }]);
  if (!blk) { console.log("  block unavailable"); continue; }

  const all = poolSwaps(blk, pool);
  console.log(`  ${all.length} swaps hit this pool in the block`);

  const fIdx = hits[0].fIdx, bIdx = hits[0].bIdx;
  const between = all.filter(s => s.index > fIdx && s.index < bIdx);
  console.log(`  between front #${fIdx} and back #${bIdx}: ${between.length} swaps`);
  console.log(`  tx indices: ${all.map(s => s.index).join(", ")}`);

  const f = all.find(s => s.index === fIdx);
  const fee = deriveFee(f.xBefore, f.yBefore, f.dIn, f.dOut);
  const modelOk = fee.rel <= 0.0005 && fee.bps < 100;
  console.log(`  fee ${fee.bps}bps residual ${(fee.rel * 100).toFixed(4)}%  -> model ${modelOk ? "FITS" : "DOES NOT FIT"}`);

  for (const h of hits) {
    const v = all.find(s => s.index === h.vIdx);
    if (!v) { console.log(`  victim #${h.vIdx} not found`); continue; }

    // A. contiguity: were the reserves the victim traded against exactly the post-frontrun state?
    const expX = f.xBefore + f.dIn, expY = f.yBefore - f.dOut;
    const clean = v.xBefore === expX && v.yBefore === expY;
    const intervening = all.filter(s => s.index > fIdx && s.index < h.vIdx).length;

    // Naive (what the scan reported) vs contamination-free.
    const naive = cpmmOut(v.dIn, f.xBefore, f.yBefore, fee.bps) - v.dOut;
    // Correct: undo ONLY the frontrun from the state the victim actually faced.
    const undoX = v.xBefore - f.dIn, undoY = v.yBefore + f.dOut;
    const corrected = (undoX > 0n && undoY > 0n) ? cpmmOut(v.dIn, undoX, undoY, fee.bps) - v.dOut : null;

    console.log(`\n  victim #${h.vIdx}  ${v.signer.slice(0, 10)}…`);
    console.log(`    intervening pool swaps between front and victim: ${intervening}`);
    console.log(`    reserves match post-frontrun exactly: ${clean ? "YES" : "NO  <-- counterfactual contaminated"}`);
    console.log(`    loss as scanned  : ${fmt(naive, v.outDec)}`);
    if (corrected !== null) {
      const drift = naive === 0n ? 0 : Number(naive - corrected) / Number(naive) * 100;
      console.log(`    loss corrected   : ${fmt(corrected, v.outDec)}   (scan overstated by ${drift.toFixed(1)}%)`);
    }
  }
}
console.log("\n" + "=".repeat(78));
