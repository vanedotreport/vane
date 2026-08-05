# Vane

**Which way the flow is moving.**

Post-mortems for Solana tokens, and analytics on the launchpads that produce them. Free to read,
no accounts, nothing tracked.

> **Status: early.** This repository is the working tooling and the notes behind it. There is no
> site yet. Two known bugs are unfixed — see [FINDINGS.md](FINDINGS.md) §3 and §4.

---

## Why this exists

Roughly **three in four Solana tokens are silent within 24 hours** of launch. When one dies, the
people holding it get no explanation — the chart just stops. Everything needed to reconstruct what
happened is on-chain and public, and almost nobody assembles it into something a normal person can
read.

Vane reconstructs it: who deployed the token and how old that wallet was, who bought in the launch
block and how much of the supply they took, how the liquidity moved, and the single transaction
that ended it.

## What it will not do

**Report observables, never intent.** "The deployer wallet existed for 84 minutes before launch" is
a fact. "This is a scam" is an accusation, and Vane does not make them. The chronology is the
finding; readers draw their own conclusions.

Concretely, that means:

- No verdict language. The word *rug* is not a detector output.
- Aggregate statistics before individual accusations, because they carry a fraction of the risk.
- Accounts that mentioned a token are listed by **when they posted**, never as participants. No
  faces, no implied coordination.
- Every report states **what Vane cannot see** and carries a versioned detector id.
- Every figure is reproducible from the transaction signatures cited.

## What is in here

```
scripts/     working tools, plain Node, zero dependencies, no API keys
brand/       mark, favicon, colour and type tokens, usage rules
design/      interface mockups (open the .html files directly)
data/        small real samples produced by the scripts
PLAN.md      architecture and order of work
FINDINGS.md  three ways a Solana parser returns a confident wrong answer
```

## Running the tools

Node 20+. No install step, no keys — everything runs against the public RPC.

```bash
# Everything known about one token, from chain data alone
node scripts/dossier.mjs <mint>

# Index token creations across a range of blocks
node scripts/index-mints.mjs <startSlot> <blockCount>

# What happened to tokens indexed earlier
node scripts/outcomes.mjs data/mints-24h.ndjson 6

# Reconstruct a token's trade tape and find the moment it died
node scripts/graveyard.mjs <mint>
```

Public RPC is heavily rate-limited and serves roughly 72 hours of history. Anything older needs
the [Old Faithful](https://github.com/anza-xyz/jetstreamer) archive, which is free and reaches
genesis.

## Notes worth reading even if you never run this

[FINDINGS.md](FINDINGS.md) documents three parser bugs found while building, all of which returned
plausible wrong answers rather than errors:

- **100% of token creations are inner instructions** — a top-level scan finds nothing at all
- **Pump.fun bonding curves hold native SOL**, invisible to token-balance parsing
- **The fee payer is not the creator** — launchpads sponsor transactions, and this inverts signals

Plus the practices that caught them: reconcile a census, instrument a filter funnel, and treat a
suspiciously empty result as an alarm rather than a pass.

## Licence

MIT.
