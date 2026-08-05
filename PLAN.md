# Vane — build plan

Token post-mortems and launchpad analytics. Free, no accounts, donation-supported.
Supersedes the MEV-era plan; that product was researched and rejected (see memory).

---

## 1. What ships

**Two surfaces, one pipeline.**

| Surface | What it is | Why it exists |
|---|---|---|
| **Report page** `vane.report/<mint>` | Post-mortem of one token. Static once computed. | SEO — "did $X rug" is searched *after*, and durably |
| **Weekly aggregates** | Launchpad league tables, survival rates | Distribution, and the durable ranking content |

Both come from the same index. The aggregates need **no per-token prediction**, which matters
because per-token prediction is the unproven part.

**Not in v1:** conviction scores, paywalls, accounts, social/X data, NFT minting (v1.1).

---

## 2. Architecture

```
TIER 1 — CHEAP, CONTINUOUS                 ~87k mints/day
  watch every block
  extract initializeMint (INNER instructions — 100% of them)
  record: mint, creator, venue, authorities, slot
                    │
              VOLUME GATE at +24h          kills ~95%+
              < ~5 SOL traded → archive, never analyse
                    │
TIER 2 — EXPENSIVE, QUEUED                 a few hundred/day
  full dossier   deployer age, funding source, snipe share
  trade tape     per-pool liquidity curve, largest extraction
  launch quality MEV share, launch-block capture
                    │
TIER 3 — SCHEDULED RESOLUTION
  revisit at +24h / +7d / +30d
  outcome: alive · silent · liquidity removed
                    │
PUBLISH
  static report page · weekly aggregates · RSS/API
```

The gate is the whole economic argument. Full analysis on 87,000 tokens/day is impossible;
on a few hundred it is free. Reports compute **once** and serve as static pages forever.

**Runtime split.** Tier 1 needs a long-lived process — Vercel functions cannot hold a stream, so
the watcher runs on a small always-on box and writes to Postgres. Tiers 2/3 are queue workers on
the same box. The Next.js site reads Postgres and serves static pages.

---

## 3. Data

- **Live:** Yellowstone gRPC, filtered to token-program `initializeMint` and the DEX programs.
- **History:** Old Faithful via Jetstreamer — free, no key, genesis→tip. Public RPC prunes at ~72h
  (measured), so anything older needs this. It is the only free path and it is Rust.
- **Decoding:** Carbon's 63 typed decoders. The Rust surface is one `Processor` writing to
  Postgres; everything else stays TypeScript.
- **Prices:** DefiLlama historical, free, no auth.
- **Store:** Postgres. ~3.7–6.4 GB/year for the full mint index — measured, not guessed.

---

## 4. Three bugs found by building, all must be fixed before any backfill

Every one produced a **confident wrong answer, never an error**. That is the signature to watch for.

**A. Fee payer ≠ creator.** Launchpads sponsor transactions, so the fee payer is often the
*platform*. This inverted the repeat-creator signal (64% of 14 vs 79% of 33 — repeat creators did
*better*) and it poisons the headline claim "this wallet created 47 tokens." Every report names a
person; this is the error with legal consequences.
**Fix:** read the creator from the launchpad's own `create` instruction (Pump.fun names a `user`
account distinct from the payer); cross-check against Metaplex `updateAuthority`.

**B. Native SOL is invisible to token-balance parsing.** Pump.fun bonding curves hold native
lamports, which never appear in `preTokenBalances`/`postTokenBalances`. The parser returned "no
trades" on the most common launchpad on Solana. **Fixed** — quote legs now fall back to the
owner's lamport delta from `preBalances`/`postBalances`.

**C. Pool mixing.** A token trades on its bonding curve *and* its graduated pool. Merging their
reserves into one series, with decimals taken from the first trade, produced
*"66.7% of pool liquidity removed in one transaction"* out of a 2-lamport dust trade — while peak
liquidity read 568 SOL and every bucket read 0.002 SOL.
**Fix (written, not yet applied):** group by `(pool, quoteMint)`, analyse the highest-volume venue
only, per-pool decimals, and an **absolute floor** on the death event so dust cannot win on
percentage.

---

## 5. What is proven vs assumed

**Proven, with working code in `vane-phase0/`:**
- 100% of token creations are inner instructions. A top-level scan finds nothing.
- ~50–87k mints/day → 3.7–6.4 GB/year. One person can own this index.
- 74% of tokens are silent within 24h (35/47). Aggregate, legally safe, and the best content asset.
- A full dossier costs ~69 free RPC calls and about a minute.
- Public RPC serves ~72h of history.
- Transaction count is a terrible volume proxy — one token had 260 transactions and 3 real trades.

**Assumed, not proven:**
- That launch-time observables predict outcomes. At n=47 one signal was directionally right
  (freeze authority, +20pp on n=10), one was **inverted** (bug A), one was null.
- That SEO for "is $X a rug" converts to sustained traffic.
- That donations cover costs. They probably won't; treat this as a reputation project with a
  low burn, not a business, unless evidence says otherwise.

---

## 6. Editorial rules — non-negotiable

- **Observables only.** "Wallet existed 84 minutes before launch" is a fact. "This is a scam" is a
  lawsuit. Never the word *rug* as a verdict.
- **Aggregate is safer than individual.** Launchpad statistics carry a fraction of the exposure of
  naming a token's team. Lead with them.
- **Mentions are not participation.** If accounts are listed, the label does the work: who posted
  and when, never who is involved. No faces.
- **Publish what cannot be seen.** Every report carries a "what Vane cannot see" section and a
  versioned detector id. It is what makes the rest credible.
- **A suspiciously empty result is an alarm, not a pass.** Bug B returned "no trades" and looked
  fine. Every parser needs a real mainnet fixture and a did-we-find-too-little check.

---

## 7. Order

1. **Fix bugs A and C.** Nothing else is trustworthy first.
2. **Aggregates before per-token.** Weekly launchpad survival tables need no prediction, carry the
   least risk, and are the content engine. Ship these first.
3. **Report pages** for tokens that pass the gate, generated from the same data.
4. **Outcome resolution cron** — this is what builds the corpus and the calibration record.
5. **Historical backfill** via Jetstreamer, once the pipeline is trusted. Not before; a corpus
   built on a wrong creator key is worse than no corpus.
6. Only then, if the data earns it: scoring.
