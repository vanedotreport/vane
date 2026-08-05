// Vane — token dossier. Answering the four questions, from chain data only.
//
//   1. Who deployed it, and did that wallet exist before launch?
//   2. What was the deployer's posture before and after?
//   3. Was the token sniped at launch, and for how much?
//   4. How many other tokens has this wallet created?
//
// No X API, no scraping, no paid provider. Every answer here is an OBSERVABLE, not a verdict —
// which is also the legal posture: "created 11 minutes before launch" is a fact,
// "this is a scam" is a lawsuit.

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const MINT = process.argv[2];
if (!MINT) { console.log("usage: node dossier.mjs <mint>"); process.exit(1); }

let calls = 0;
async function rpc(m, p, tries = 4) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      if (r.status === 429) { await sleep(1200 * a); continue; }
      const j = await r.json();
      calls++;
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (a === tries) return null; await sleep(800 * a); }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ago = ts => {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
};
const when = ts => new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19);

/** Walk getSignaturesForAddress backwards to the very first transaction. */
async function firstTx(addr, cap = 12) {
  let before = null, oldest = null, total = 0, pages = 0;
  while (pages < cap) {
    const p = { limit: 1000 };
    if (before) p.before = before;
    const r = await rpc("getSignaturesForAddress", [addr, p]);
    if (!r || !r.length) break;
    total += r.length;
    oldest = r[r.length - 1];
    before = oldest.signature;
    pages++;
    if (r.length < 1000) break;
    await sleep(150);
  }
  return { oldest, total, truncated: pages >= cap };
}

console.log(`\n${"=".repeat(74)}\nVANE DOSSIER — ${MINT}\n${"=".repeat(74)}`);

// ---------- the mint itself ----------
const mintInfo = await rpc("getAccountInfo", [MINT, { encoding: "jsonParsed" }]);
const parsed = mintInfo?.value?.data?.parsed?.info;
if (!parsed) { console.log("not a parseable mint"); process.exit(1); }
console.log(`\n[TOKEN]`);
console.log(`  program        ${mintInfo.value.owner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "SPL Token"}`);
console.log(`  decimals       ${parsed.decimals}`);
console.log(`  supply         ${(Number(parsed.supply) / 10 ** parsed.decimals).toLocaleString()}`);
console.log(`  mint authority ${parsed.mintAuthority ?? "REVOKED"}`);
console.log(`  freeze auth    ${parsed.freezeAuthority ?? "revoked"}`);

// ---------- Q1: who deployed it, and when ----------
console.log(`\n[Q1] DEPLOYMENT`);
const mintHist = await firstTx(MINT);
if (!mintHist.oldest) { console.log("  no history"); process.exit(1); }
const birth = mintHist.oldest;
console.log(`  first tx       ${when(birth.blockTime)}  (${ago(birth.blockTime)})`);
console.log(`  at slot        ${birth.slot}`);
console.log(`  lifetime txs   ${mintHist.total}${mintHist.truncated ? "+ (capped)" : ""}`);

const birthTx = await rpc("getTransaction", [birth.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
const deployer = birthTx?.transaction?.message?.accountKeys?.find(k => k.signer)?.pubkey;
console.log(`  deployer       ${deployer ?? "?"}`);

// ---------- Q2: did the deployer exist before launch? posture? ----------
if (deployer) {
  console.log(`\n[Q2] DEPLOYER WALLET`);
  const dh = await firstTx(deployer);
  if (dh.oldest) {
    const ageSecs = birth.blockTime - dh.oldest.blockTime;
    console.log(`  first seen     ${when(dh.oldest.blockTime)}`);
    console.log(`  existed for    ${ageSecs < 0 ? "?" : ageSecs < 3600 ? `${Math.round(ageSecs / 60)} MINUTES` : ageSecs < 86400 ? `${(ageSecs / 3600).toFixed(1)} hours` : `${(ageSecs / 86400).toFixed(1)} days`} before launching this token`);
    if (ageSecs >= 0 && ageSecs < 7200) console.log(`                 ^^ freshly created for this launch`);
    console.log(`  total txs      ${dh.total}${dh.truncated ? "+ (capped)" : ""}`);
  }

  // posture after: what has it done since?
  const recent = await rpc("getSignaturesForAddress", [deployer, { limit: 1000 }]);
  if (recent?.length) {
    const after = recent.filter(s => s.blockTime > birth.blockTime);
    const failed = recent.filter(s => s.err).length;
    console.log(`  txs since launch ${after.length}`);
    console.log(`  last active    ${when(recent[0].blockTime)}  (${ago(recent[0].blockTime)})`);
    console.log(`  failed txs     ${failed} of ${recent.length} sampled`);
  }
  const bal = await rpc("getBalance", [deployer]);
  if (bal) console.log(`  SOL balance    ${(bal.value / 1e9).toFixed(4)}`);

  // ---------- Q4: other tokens by the same deployer ----------
  console.log(`\n[Q4] OTHER TOKENS BY THIS DEPLOYER`);
  const sample = (recent ?? []).slice(0, 60);
  const mints = new Map();
  for (const s of sample) {
    const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx) continue;
    const scan = (instrs) => {
      for (const ix of instrs ?? []) {
        const t = ix?.parsed?.type;
        if (t === "initializeMint" || t === "initializeMint2") {
          const m = ix.parsed.info.mint;
          if (!mints.has(m)) mints.set(m, s.blockTime);
        }
      }
    };
    scan(tx.transaction.message.instructions);
    for (const inner of tx.meta?.innerInstructions ?? []) scan(inner.instructions);
    await sleep(90);
  }
  if (mints.size === 0) {
    console.log(`  none found in the last ${sample.length} transactions`);
    console.log(`  (a full answer needs an index of every InitializeMint ever — see note)`);
  } else {
    console.log(`  ${mints.size} mint(s) created in the last ${sample.length} txs:`);
    for (const [m, t] of mints) console.log(`    ${m}  ${when(t)}${m === MINT ? "   <-- this one" : ""}`);
  }
}

// ---------- Q3: was it sniped at launch ----------
console.log(`\n[Q3] LAUNCH SNIPE`);
const launchBlk = await rpc("getBlock", [birth.slot, { encoding: "jsonParsed", transactionDetails: "full",
  rewards: false, maxSupportedTransactionVersion: 0 }]);
if (!launchBlk) {
  console.log(`  launch block ${birth.slot} unavailable (public RPC prunes old blocks)`);
  console.log(`  -> this is exactly what the Old Faithful archive is for`);
} else {
  const buyers = [];
  launchBlk.transactions.forEach((tx, index) => {
    if (tx.meta?.err) return;
    for (const b of tx.meta?.postTokenBalances ?? []) {
      if (b.mint !== MINT) continue;
      const pre = (tx.meta.preTokenBalances ?? []).find(p => p.accountIndex === b.accountIndex);
      const got = BigInt(b.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount?.amount ?? "0");
      if (got > 0n && b.owner) buyers.push({ index, owner: b.owner, got, dec: b.uiTokenAmount.decimals });
    }
  });
  buyers.sort((a, b) => a.index - b.index);
  const supply = BigInt(parsed.supply);
  console.log(`  buyers in the launch block: ${buyers.length}`);
  for (const b of buyers.slice(0, 12)) {
    const pct = supply > 0n ? Number(b.got * 10000n / supply) / 100 : 0;
    console.log(`    #${String(b.index).padStart(4)}  ${b.owner.slice(0, 12)}…  ${(Number(b.got) / 10 ** b.dec).toLocaleString(undefined, { maximumFractionDigits: 2 })}  (${pct.toFixed(2)}% of supply)`);
  }
  const total = buyers.reduce((a, b) => a + b.got, 0n);
  if (supply > 0n) console.log(`  captured in launch block: ${(Number(total * 10000n / supply) / 100).toFixed(2)}% of supply`);
}

console.log(`\n[${calls} rpc calls]`);
console.log(`\nNOTE: every line above is an OBSERVABLE. No line says "scam".`);
