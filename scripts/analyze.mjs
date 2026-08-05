// Vane — Phase 0. Can we compute a loss number we'd defend in an argument?
//
// No infrastructure. No Rust. No database. Node's built-in fetch against a public RPC.
// The whole point is to test the MATH before anything else exists.
//
// Deliberate methodology choices, both of which are the "hybrid parsing" rule in practice:
//
//   1. A swap is identified by VAULT DELTAS, never by decoding instruction data. If the pool's
//      two token accounts didn't move in opposite directions, no swap happened here — regardless
//      of what instructions the transaction contains. Our very first sampled transaction
//      referenced this pool and moved nothing, which is exactly the trap.
//
//   2. The pool fee is DERIVED from observed swaps rather than hardcoded at 0.25%. If the derived
//      fee doesn't land on a sane constant, our model of the pool is wrong and every number
//      downstream is garbage. Better to find that out here than in production.

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";

// Raydium AMM v4, SOL/USDC. Constant product — chosen because the counterfactual needs no
// archival account state; reserves come straight out of transaction meta.
const POOL_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SOL_DEC = 9n, USDC_DEC = 6n;

// ---------------------------------------------------------------- rpc

let rpcCalls = 0;
async function rpc(method, params, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429) { await sleep(900 * attempt); continue; }
      const j = await res.json();
      rpcCalls++;
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } catch (e) {
      if (attempt === tries) throw e;
      await sleep(700 * attempt);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- extract

/**
 * Vault deltas for this pool, from transaction meta alone.
 * Returns null when the pool's vaults did not move — i.e. the transaction touched the pool
 * without trading against it. That case is common and silently wrong to include.
 */
function vaultDeltas(meta) {
  const key = (b) => `${b.accountIndex}:${b.mint}`;
  const pre = new Map(), post = new Map();
  for (const b of meta.preTokenBalances ?? [])
    if (b.owner === POOL_AUTHORITY) pre.set(key(b), BigInt(b.uiTokenAmount.amount));
  for (const b of meta.postTokenBalances ?? [])
    if (b.owner === POOL_AUTHORITY) post.set(key(b), BigInt(b.uiTokenAmount.amount));

  let sol = null, usdc = null;
  for (const [k, before] of pre) {
    const after = post.get(k);
    if (after === undefined) continue;
    const mint = k.split(":")[1];
    const d = after - before;
    if (mint === WSOL) sol = { before, after, delta: d };
    if (mint === USDC) usdc = { before, after, delta: d };
  }
  if (!sol || !usdc) return null;
  if (sol.delta === 0n || usdc.delta === 0n) return null;      // no trade against this pool
  if (sol.delta > 0n === usdc.delta > 0n) return null;         // both same sign: not a swap
  return { sol, usdc };
}

// ---------------------------------------------------------------- cpmm

/** Constant product with fee on input: out = y·d(1−f) / (x + d(1−f)) */
function cpmmOut(d, x, y, feeBps) {
  const dNet = (d * BigInt(10000 - feeBps)) / 10000n;
  return (y * dNet) / (x + dNet);
}

/**
 * Recover the pool's effective fee from an observed swap, by searching bps values for the one
 * that reproduces the actual output. Self-validating: if nothing fits, the model is wrong.
 */
function deriveFeeBps(swap) {
  const { x, y, dIn, dOut } = swap;
  let best = null;
  for (let bps = 0; bps <= 100; bps++) {
    const pred = cpmmOut(dIn, x, y, bps);
    const err = pred > dOut ? pred - dOut : dOut - pred;
    const rel = Number(err) / Number(dOut);
    if (best === null || rel < best.rel) best = { bps, rel };
  }
  return best;
}

const fmt = (v, dec) => (Number(v) / 10 ** Number(dec)).toLocaleString(undefined, { maximumFractionDigits: 6 });

// ---------------------------------------------------------------- main

const CENTRE = Number(process.argv[2] ?? 437293821);
const WINDOW = Number(process.argv[3] ?? 2);   // ±slots. 4-slot window = one leader's allocation.

console.log(`Vane phase 0 — Raydium AMM v4 SOL/USDC`);
console.log(`slots ${CENTRE - WINDOW}..${CENTRE + WINDOW}\n`);

// Block signature lists give ORDER. Transaction index within a block is a sound total order for
// transactions touching the same pool: two swaps both write the pool's vaults, so they cannot
// share a PoH entry and must land in different, strictly ordered entries.
const ordered = [];
for (let slot = CENTRE - WINDOW; slot <= CENTRE + WINDOW; slot++) {
  let blk;
  try {
    blk = await rpc("getBlock", [slot, {
      transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 0,
    }]);
  } catch (e) { console.log(`  slot ${slot}: ${e.message}`); continue; }
  if (!blk) { console.log(`  slot ${slot}: skipped (no block)`); continue; }
  blk.signatures.forEach((sig, index) => ordered.push({ slot, index, sig }));
  console.log(`  slot ${slot}: ${blk.signatures.length} txs`);
}
console.log(`\ntotal ${ordered.length} transactions in window`);

// Only fetch transactions already known to touch the pool.
const touching = new Set(JSON.parse(await import("node:fs").then(fs => fs.promises.readFile("sigs.json", "utf8")))
  .result.map((s) => s.signature));
const candidates = ordered.filter((o) => touching.has(o.sig));
console.log(`${candidates.length} of them reference the pool\n`);

const swaps = [];
let referencedButNoTrade = 0;

for (const c of candidates) {
  const tx = await rpc("getTransaction", [c.sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  if (!tx || tx.meta?.err) continue;
  const d = vaultDeltas(tx.meta);
  if (!d) { referencedButNoTrade++; continue; }

  const solIn = d.sol.delta > 0n;
  swaps.push({
    ...c,
    signer: tx.transaction.message.accountKeys[0].pubkey,
    dir: solIn ? "SOL->USDC" : "USDC->SOL",
    x: solIn ? d.sol.before : d.usdc.before,       // reserve of the input token, pre-trade
    y: solIn ? d.usdc.before : d.sol.before,       // reserve of the output token, pre-trade
    dIn: solIn ? d.sol.delta : d.usdc.delta,
    dOut: solIn ? -d.usdc.delta : -d.sol.delta,
    sol: d.sol, usdc: d.usdc,
  });
  await sleep(120);
}

console.log(`REAL swaps against the pool: ${swaps.length}`);
console.log(`referenced the pool but never traded: ${referencedButNoTrade}  <-- would be false positives\n`);

// ------- fee derivation, as a model check -------
console.log("--- derived pool fee (model check) ---");
const fees = swaps.slice(0, 8).map((s) => ({ sig: s.sig.slice(0, 8), ...deriveFeeBps(s) }));
for (const f of fees) console.log(`  ${f.sig}…  fee ≈ ${f.bps} bps   (residual ${(f.rel * 100).toFixed(4)}%)`);
const modal = fees.sort((a, b) => a.rel - b.rel)[0];
const FEE_BPS = modal ? modal.bps : 25;
console.log(`  → using ${FEE_BPS} bps\n`);

// ------- ordered swap tape -------
console.log("--- swap tape, ordered by (slot, index) ---");
swaps.sort((a, b) => a.slot - b.slot || a.index - b.index);
for (const s of swaps) {
  const amt = s.dir === "SOL->USDC" ? `${fmt(s.dIn, SOL_DEC)} SOL -> ${fmt(s.dOut, USDC_DEC)} USDC`
                                    : `${fmt(s.dIn, USDC_DEC)} USDC -> ${fmt(s.dOut, SOL_DEC)} SOL`;
  console.log(`  ${s.slot}#${String(s.index).padStart(4)}  ${s.signer.slice(0, 6)}…  ${s.dir.padEnd(10)}  ${amt}`);
}

// ------- sandwich search -------
console.log("\n--- sandwich candidates ---");
let found = 0;
for (let i = 0; i < swaps.length; i++) {
  for (let j = i + 1; j < swaps.length; j++) {
    for (let k = j + 1; k < swaps.length; k++) {
      const [f, v, b] = [swaps[i], swaps[j], swaps[k]];
      if (f.dir !== v.dir) continue;              // victim must push price the same way
      if (f.dir === b.dir) continue;              // backrun must reverse
      if (v.signer === f.signer || v.signer === b.signer) continue;
      if (f.signer !== b.signer) continue;        // v1: strict link. Real detector relaxes this.

      // Counterfactual: replay the victim against the pre-frontrun reserves.
      const actualOut = v.dOut;
      const cfOut = cpmmOut(v.dIn, f.x, f.y, FEE_BPS);
      const loss = cfOut - actualOut;
      if (loss <= 0n) continue;                   // no harm, not a sandwich

      found++;
      const outDec = v.dir === "SOL->USDC" ? USDC_DEC : SOL_DEC;
      console.log(`\n  #${found}  attacker ${f.signer.slice(0, 8)}…  victim ${v.signer.slice(0, 8)}…`);
      console.log(`      front  ${f.slot}#${f.index}`);
      console.log(`      victim ${v.slot}#${v.index}`);
      console.log(`      back   ${b.slot}#${b.index}`);
      console.log(`      victim received : ${fmt(actualOut, outDec)}`);
      console.log(`      would have got  : ${fmt(cfOut, outDec)}   (no frontrun)`);
      console.log(`      LOSS            : ${fmt(loss, outDec)}  (${(Number(loss) / Number(cfOut) * 100).toFixed(4)}%)`);
    }
  }
}
if (!found) console.log("  none in this window.");
console.log(`\n[${rpcCalls} rpc calls]`);
