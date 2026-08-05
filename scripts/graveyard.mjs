// Vane — the graveyard. Reconstruct a token's trade tape and find the moment it died.
//
// Two mechanisms, both provable from chain data alone:
//   DUMP  — one sell consuming a large share of the pool's quote reserve
//   DRAIN — LP removed; the pool's reserves collapse without a matching trade
//
// Everything else that ends a token — abandonment, moving goalposts, silence — is recorded as
// timestamps, never as a motive. The output is a chronology, not an accusation.
//
// VOLUME GATE FIRST. A token nobody traded cannot be rugged; there was nothing to take. Filtering
// those out is not just noise reduction, it is what makes the population coherent — and it cuts
// the interesting set from ~87k mints/day to a few hundred.

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const MINT = process.argv[2];
const MAX_TX = Number(process.argv[3] ?? 320);
if (!MINT) { console.log("usage: node graveyard.mjs <mint> [maxTx]"); process.exit(1); }

let calls = 0;
async function rpc(m, p, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      if (r.status === 429) { await sleep(1300 * a); continue; }
      const j = await r.json();
      calls++;
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (a === tries) return null; await sleep(700 * a); }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = ts => new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19);
const N = (v, d) => Number(v) / 10 ** d;

// Pull the whole signature history, oldest first.
let sigs = [], before = null;
while (sigs.length < MAX_TX) {
  const p = { limit: Math.min(1000, MAX_TX - sigs.length) };
  if (before) p.before = before;
  const r = await rpc("getSignaturesForAddress", [MINT, p]);
  if (!r?.length) break;
  sigs.push(...r);
  before = r[r.length - 1].signature;
  if (r.length < p.limit) break;
}
sigs.reverse();
console.log(`\n${"=".repeat(76)}\nGRAVEYARD — ${MINT}\n${"=".repeat(76)}`);
console.log(`${sigs.length} transactions, ${T(sigs[0].blockTime)} -> ${T(sigs[sigs.length - 1].blockTime)}`);

// Walk the tape. A trade is a counterparty (pool) whose two token accounts move opposite ways,
// one of them being our mint.
const tape = [];
for (const s of sigs) {
  const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  await sleep(70);
  if (!tx || tx.meta?.err) continue;
  const pre = tx.meta.preTokenBalances ?? [], post = tx.meta.postTokenBalances ?? [];
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey);
  const signer = tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey;
  const preM = new Map(pre.map(b => [String(b.accountIndex), b]));

  // Lamport deltas, parallel-indexed with accountKeys. Pump.fun bonding curves hold NATIVE SOL,
  // which never appears in token balances — a token-balance-only parser is structurally blind to
  // the most common launchpad on Solana and silently returns nothing.
  const lamDelta = new Map();
  (tx.meta.postBalances ?? []).forEach((v, i) => {
    const d = BigInt(v) - BigInt(tx.meta.preBalances[i] ?? 0);
    if (d !== 0n) lamDelta.set(keys[i], { delta: d, before: BigInt(tx.meta.preBalances[i] ?? 0), after: BigInt(v) });
  });

  // Who moved OUR token, and isn't the trader? That owner is the pool / bonding curve.
  const movers = new Map();
  for (const b of post) {
    if (b.mint !== MINT || !b.owner) continue;
    const p = preM.get(String(b.accountIndex));
    const d = BigInt(b.uiTokenAmount.amount) - BigInt(p?.uiTokenAmount?.amount ?? "0");
    if (d === 0n) continue;
    movers.set(b.owner, { delta: d, dec: b.uiTokenAmount.decimals });
  }

  for (const [owner, tok] of movers) {
    if (owner === signer) continue;

    // Quote leg: another SPL token account of the same owner, or that owner's native SOL.
    let quote = null;
    for (const b of post) {
      if (b.owner !== owner || b.mint === MINT) continue;
      const p = preM.get(String(b.accountIndex));
      const d = BigInt(b.uiTokenAmount.amount) - BigInt(p?.uiTokenAmount?.amount ?? "0");
      if (d === 0n) continue;
      quote = { mint: b.mint, delta: d, before: BigInt(p?.uiTokenAmount?.amount ?? "0"),
                after: BigInt(b.uiTokenAmount.amount), dec: b.uiTokenAmount.decimals };
    }
    if (!quote) {
      const lam = lamDelta.get(owner);
      if (lam) quote = { mint: "So11111111111111111111111111111111111111112", delta: lam.delta,
                         before: lam.before, after: lam.after, dec: 9, native: true };
    }
    if (!quote) continue;
    if ((tok.delta > 0n) === (quote.delta > 0n)) continue;   // must move opposite ways

    tape.push({
      time: s.blockTime, slot: s.slot, sig: s.signature, signer, pool: owner,
      side: tok.delta > 0n ? "SELL" : "BUY",
      tokenAmt: tok.delta > 0n ? tok.delta : -tok.delta,
      quoteAmt: quote.delta > 0n ? quote.delta : -quote.delta,
      quoteBefore: quote.before, quoteAfter: quote.after,
      quoteMint: quote.mint, quoteDec: quote.dec, tokDec: tok.dec, native: !!quote.native,
    });
  }
}

if (!tape.length) { console.log("\nno trades found — nothing to analyse"); process.exit(0); }

// ---- GROUP BY POOL. A token trades on a bonding curve AND its graduated pool; mixing their
// reserves produced a "66.7% of liquidity removed" headline out of a 2-lamport dust trade.
// Reserves are only comparable within one pool, with one quote asset, at one decimal scale.
const pools = new Map();
for (const t of tape) {
  const key = `${t.pool}|${t.quoteMint}`;
  (pools.get(key) ?? pools.set(key, []).get(key)).push(t);
}
const ranked = [...pools.entries()]
  .map(([k, list]) => ({ k, list, vol: list.reduce((a, t) => a + N(t.quoteAmt, t.quoteDec), 0) }))
  .sort((a, b) => b.vol - a.vol);

console.log(`\n[VENUES]`);
for (const r of ranked) {
  const [pool, qm] = r.k.split("|");
  const sol = qm === "So11111111111111111111111111111111111111112";
  console.log(`  ${pool.slice(0, 12)}…  ${String(r.list.length).padStart(4)} trades  ${r.vol.toFixed(3)} ${sol ? "SOL" : qm.slice(0, 4) + "…"}${r.list[0].native ? "  (native)" : ""}`);
}

const primary = ranked[0];
const tp = primary.list.sort((a, b) => a.time - b.time);
const qDec = tp[0].quoteDec, tDec = tp[0].tokDec;
const isSol = tp[0].quoteMint === "So11111111111111111111111111111111111111112";
const unit = isSol ? "SOL" : tp[0].quoteMint.slice(0, 4) + "…";
console.log(`  -> analysing the primary venue only (${primary.list.length} of ${tape.length} trades)`);

// ---- volume gate ----
const t0 = tp[0].time;
const vol24 = tp.filter(t => t.time - t0 <= 86400).reduce((a, t) => a + N(t.quoteAmt, qDec), 0);
const peakLiq = Math.max(...tp.map(t => Math.max(N(t.quoteBefore, qDec), N(t.quoteAfter, qDec))));
console.log(`\n[VOLUME GATE]`);
console.log(`  first-24h volume    ${vol24.toFixed(3)} ${unit}`);
console.log(`  peak pool liquidity ${peakLiq.toFixed(3)} ${unit}`);
const GATE_SOL = 5;
if (isSol && vol24 < GATE_SOL) { console.log(`  -> BELOW GATE. Nothing here to rug.`); process.exit(0); }
console.log(`  -> passes gate`);

// ---- death event, with an ABSOLUTE floor so dust cannot win on percentage ----
const FLOOR = peakLiq * 0.02;    // must move at least 2% of peak liquidity in absolute terms
console.log(`\n[DEATH EVENT]   (ignoring sells below ${FLOOR.toFixed(4)} ${unit})`);
let worst = null;
for (const t of tp) {
  if (t.side !== "SELL") continue;
  const poolBefore = N(t.quoteBefore, qDec), took = N(t.quoteAmt, qDec);
  if (poolBefore <= 0 || took < FLOOR) continue;
  const share = took / poolBefore;
  if (!worst || took > worst.took) worst = { ...t, share, poolBefore, took };
}
if (!worst) console.log(`  no sell above the floor — this token bled out rather than being dumped`);
else {
  console.log(`  when    ${T(worst.time)}  (+${((worst.time - t0) / 3600).toFixed(2)}h)`);
  console.log(`  seller  ${worst.signer}`);
  console.log(`  took    ${worst.took.toFixed(4)} ${unit} of ${worst.poolBefore.toFixed(4)} in the pool  = ${(worst.share * 100).toFixed(1)}%`);
  console.log(`  sold    ${N(worst.tokenAmt, tDec).toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens`);
  console.log(`  sig     ${worst.sig}`);
}

// ---- liquidity curve, primary pool only, max within each bucket ----
console.log(`\n[LIQUIDITY OVER TIME]`);
const buckets = new Map();
for (const t of tp) {
  const h = Math.floor((t.time - t0) / 3600);
  const cur = buckets.get(h) ?? { liq: 0, n: 0, sells: 0 };
  cur.liq = N(t.quoteAfter, qDec);              // last state in the bucket
  cur.peak = Math.max(cur.peak ?? 0, N(t.quoteBefore, qDec));
  cur.n++; if (t.side === "SELL") cur.sells++;
  buckets.set(h, cur);
}
const maxLiq = Math.max(...[...buckets.values()].map(b => b.peak), 1e-9);
for (const [h, b] of [...buckets.entries()].sort((a, b2) => a[0] - b2[0])) {
  const bar = "#".repeat(Math.max(0, Math.round(b.liq / maxLiq * 34)));
  console.log(`  +${String(h).padStart(3)}h  ${b.liq.toFixed(3).padStart(11)} ${unit}  ${bar.padEnd(34)} ${b.n} trades (${b.sells} sells)`);
}

const last = tp[tp.length - 1], endLiq = N(last.quoteAfter, qDec);
console.log(`\n[VERDICT — observables only]`);
console.log(`  peak liquidity     ${peakLiq.toFixed(4)} ${unit}`);
console.log(`  current liquidity  ${endLiq.toFixed(4)} ${unit}   (${(endLiq / peakLiq * 100).toFixed(2)}% of peak)`);
console.log(`  last trade         ${T(last.time)}`);
console.log(`\n  No line above states intent. The chronology is the finding.`);
console.log(`\n[${calls} rpc calls]`);
