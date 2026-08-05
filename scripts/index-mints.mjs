// Vane — the mint index. The asset everything else sits on.
//
// Every token creation on Solana, mapped to the wallet that paid for it. Answers "how many
// tokens has this deployer made" (Q4), generates the launchpad league table, and — once outcomes
// are attached — becomes the calibration corpus. All three are the same index.
//
// A mint creation is an `initializeMint` / `initializeMint2` instruction. It appears at the top
// level for a direct SPL mint, and as an INNER instruction when a launchpad creates it via CPI —
// which is how most tokens are actually born, so scanning only top-level instructions would miss
// nearly everything.
//
// Launchpads are DISCOVERED, not hardcoded. Recording which programs each creating transaction
// invoked lets the venues surface empirically. Hardcoding a program-ID list means silently
// mislabelling every launchpad that ships after you wrote it — and being confidently wrong about
// provenance is worse than saying "unknown".

import { writeFileSync, appendFileSync } from "node:fs";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const START = Number(process.argv[2]);
const COUNT = Number(process.argv[3] ?? 120);

// Only IDs I can state with confidence. Everything else is reported raw — an unlabelled program
// id is honest; a wrong label is not.
const KNOWN = {
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "SPL Token",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": "Token-2022",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "Associated Token Account",
  "11111111111111111111111111111111": "System",
  "ComputeBudget111111111111111111111111111111": "Compute Budget",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s": "Metaplex Token Metadata",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap",
};
// Infrastructure invoked by nearly every mint creation — useless for identifying a venue.
const PLUMBING = new Set(Object.keys(KNOWN).filter(k =>
  ["SPL Token", "Token-2022", "Associated Token Account", "System", "Compute Budget"].includes(KNOWN[k])));

let calls = 0;
async function rpc(m, p, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1400 * a)); continue; }
      const j = await r.json();
      calls++;
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (a === tries) return null; await new Promise(s => setTimeout(s, 800 * a)); }
  }
}

const census = { blocks: 0, missing: 0, tx: 0, failed: 0, mintsTopLevel: 0, mintsInner: 0 };
const rows = [];

function harvest(blk, slot) {
  blk.transactions.forEach((tx) => {
    census.tx++;
    if (tx.meta?.err) { census.failed++; return; }

    const msg = tx.transaction.message;
    const payer = msg.accountKeys.find(k => k.signer)?.pubkey;
    if (!payer) return;

    // Every program the transaction touched, top level and via CPI.
    const programs = new Set();
    for (const ix of msg.instructions ?? []) if (ix.programId) programs.add(ix.programId);
    for (const grp of tx.meta?.innerInstructions ?? [])
      for (const ix of grp.instructions ?? []) if (ix.programId) programs.add(ix.programId);

    const found = [];
    const scan = (instrs, inner) => {
      for (const ix of instrs ?? []) {
        const t = ix?.parsed?.type;
        if (t !== "initializeMint" && t !== "initializeMint2") continue;
        const info = ix.parsed.info;
        found.push({ mint: info.mint, decimals: info.decimals,
          mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null, inner });
        inner ? census.mintsInner++ : census.mintsTopLevel++;
      }
    };
    scan(msg.instructions, false);
    for (const grp of tx.meta?.innerInstructions ?? []) scan(grp.instructions, true);

    for (const f of found) {
      rows.push({
        ...f, slot, time: blk.blockTime, creator: payer,
        sig: tx.transaction.signatures[0],
        // Venue candidates = everything that isn't universal plumbing.
        venue: [...programs].filter(p => !PLUMBING.has(p)),
      });
    }
  });
}

console.log(`indexing mint creations, ${COUNT} blocks from ${START}\n`);
for (let s = START; s < START + COUNT; s++) {
  const blk = await rpc("getBlock", [s, { encoding: "jsonParsed", transactionDetails: "full",
    rewards: false, maxSupportedTransactionVersion: 0 }]);
  if (!blk) { census.missing++; process.stdout.write("·"); continue; }
  census.blocks++;
  const before = rows.length;
  harvest(blk, s);
  process.stdout.write(rows.length > before ? "M" : "·");
}
process.stdout.write("\n\n");

console.log("--- census ---");
for (const [k, v] of Object.entries(census)) console.log(`  ${k.padEnd(15)} ${v}`);
const mints = census.mintsTopLevel + census.mintsInner;
console.log(`  ${"mints".padEnd(15)} ${mints}   (${(mints / Math.max(1, census.blocks)).toFixed(2)}/block)`);
console.log(`  ${"inner share".padEnd(15)} ${mints ? (census.mintsInner / mints * 100).toFixed(0) : 0}%  <- would be missed by a top-level-only scan`);

// ---- extrapolate to a full index ----
const perDay = (mints / Math.max(1, census.blocks)) * 2.5 * 86400;   // ~2.5 slots/sec
console.log(`\n--- sizing a complete index ---`);
console.log(`  observed rate      ~${Math.round(perDay).toLocaleString()} mints/day`);
console.log(`  ~30 days           ~${Math.round(perDay * 30).toLocaleString()} rows`);
console.log(`  ~1 year            ~${Math.round(perDay * 365).toLocaleString()} rows`);
console.log(`  at ~200 bytes/row  ~${(perDay * 365 * 200 / 1e9).toFixed(1)} GB/year  <- trivially Postgres`);

// ---- Q4: creators with more than one token ----
const byCreator = new Map();
for (const r of rows) (byCreator.get(r.creator) ?? byCreator.set(r.creator, []).get(r.creator)).push(r);
const repeat = [...byCreator.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
console.log(`\n--- Q4: repeat creators in this window ---`);
console.log(`  ${byCreator.size} distinct creators, ${repeat.length} made more than one`);
for (const [c, list] of repeat.slice(0, 10))
  console.log(`    ${c.slice(0, 16)}…  ${list.length} mints`);
if (!repeat.length) console.log(`    none — expected in a ${(census.blocks / 2.5 / 60).toFixed(1)}-minute window; this signal needs the full index`);

// ---- launchpad league table, discovered not assumed ----
const venueCount = new Map();
for (const r of rows) for (const v of r.venue) venueCount.set(v, (venueCount.get(v) ?? 0) + 1);
console.log(`\n--- venues, discovered from the data ---`);
for (const [p, n] of [...venueCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  const label = KNOWN[p] ?? "(unlabelled)";
  console.log(`  ${String(n).padStart(4)}  ${p}  ${label}`);
}

// ---- authority posture at birth ----
const revoked = rows.filter(r => !r.mintAuthority).length;
const freezable = rows.filter(r => r.freezeAuthority).length;
console.log(`\n--- posture at creation ---`);
console.log(`  mint authority already revoked : ${revoked}/${rows.length}`);
console.log(`  freeze authority set           : ${freezable}/${rows.length}   <- can freeze holder balances`);

writeFileSync("mints.ndjson", rows.map(r => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nwrote mints.ndjson (${rows.length} rows)  [${calls} rpc calls]`);
