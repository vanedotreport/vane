# Three ways a Solana parser returns a confident wrong answer

Notes from building token-analysis tooling against Solana mainnet. Every bug below was found by
running real data through working code. None of them threw an exception. Each produced output that
looked entirely reasonable, and two of them would have shipped as headline numbers.

That is the pattern worth internalising: **on Solana the dangerous defects are not in your
detection logic, they are in what you decided counts as a swap, a pool, or a creator.**

---

## 1. Every token creation is an inner instruction

Scanning 99 blocks for `initializeMint` / `initializeMint2` at the top level of transactions:

```
mintsTopLevel   0
mintsInner      40
inner share     100%
```

Not "mostly." All of them. Tokens are created by launchpads via CPI, so a top-level-only scan
returns an empty result on a chain minting tens of thousands of tokens a day. It does not error —
it reports zero, and zero is a plausible number if you are not expecting otherwise.

Scan `meta.innerInstructions` as well as `message.instructions`, always.

---

## 2. Native SOL is invisible to token-balance parsing

The natural way to identify a swap is to look for an account owner whose two SPL token balances
moved in opposite directions inside one transaction — one leg in, one leg out. It works on
Raydium, Orca, and anything holding wrapped SOL.

It finds **nothing** on Pump.fun.

Pump.fun bonding curves hold **native lamports**, which never appear in `preTokenBalances` or
`postTokenBalances`. They live in `preBalances` / `postBalances`, indexed parallel to
`accountKeys`. A token-balance-only parser is structurally blind to the most common launchpad on
Solana, and it says so by returning an empty trade list:

```
260 transactions, 2026-08-04 02:00:20 -> 2026-08-04 02:02:27
no trades found — nothing to analyse
```

The fix is to fall back to the counterparty's lamport delta when no second token leg exists:

```js
const lamDelta = new Map();
meta.postBalances.forEach((v, i) => {
  const d = BigInt(v) - BigInt(meta.preBalances[i]);
  if (d !== 0n) lamDelta.set(accountKeys[i], d);
});
```

---

## 3. A token trades on more than one pool, and mixing them invents events

A launchpad token lives on a bonding curve and then graduates to an AMM. Both are "the pool." If
you build one trade tape without grouping by venue — and take your quote decimals from the first
trade you happen to see — you get this:

```
[DEATH EVENT]
  took      0.0000 SOL of 0.0000 in the pool
  = 66.7% of pool liquidity in ONE transaction
  sold      0 tokens

[LIQUIDITY OVER TIME]
  +  0h       0.002 SOL   518 trades

[VERDICT]
  peak liquidity  568.6393 SOL
```

Peak liquidity of 568 SOL alongside a curve that never exceeds 0.002 SOL. The "66.7% extraction"
is a two-lamport dust trade against three lamports of reserve in an unrelated pool, scoring high
because the metric was a *ratio with no absolute floor*.

Had the dust been slightly larger the inconsistency would have vanished and the number would have
looked credible. Three fixes, all necessary:

- group by `(pool, quoteMint)` and analyse one venue at a time
- take decimals per pool, never from `tape[0]`
- put an **absolute floor** under any percentage metric, so dust cannot win on ratio alone

---

## 4. The fee payer is not the creator

The obvious way to attribute a token to a person is the fee payer of the transaction that minted
it. On Solana this is frequently wrong, because launchpads sponsor transactions — so the payer is
the *platform*, not the deployer.

Measured effect, testing whether "this wallet minted several tokens in the same minute" predicts a
token dying within 24 hours:

```
creator made >1 that minute:  64% of 14  vs  79% of 33   Δ -15pp
```

The signal came out **backwards**. Wallets that minted several tokens produced tokens that survived
*better*, because those wallets were infrastructure rather than serial deployers.

Read the creator from the launchpad's own `create` instruction — Pump.fun names a `user` account
distinct from the payer — and cross-check against Metaplex `updateAuthority`.

This one matters beyond accuracy. "This wallet has created 47 tokens" is a claim about a person.
Getting it wrong is not a bug report, it is a defamation risk.

---

## Two smaller ones

**Transaction count is a terrible proxy for volume.** One token showed 260 transactions and, on
inspection, three actual trades. The rest were failed snipes and non-trade activity. Gate on traded
volume, not activity.

**Discover venues, do not hardcode them.** Recording which programs each mint-creating transaction
invoked, rather than matching against a known list, surfaced Meteora DBC, Raydium CLMM, Orca
Whirlpool and others that a hardcoded list written a month earlier would have silently filed under
"unknown." An unlabelled program id is honest; a wrong label is not.

---

## The habit that catches these

None of the above threw. They returned plausible values, empty lists, or internally inconsistent
output that only looked wrong because the numbers happened to be absurd.

Three practices found all of them:

1. **Reconcile a census.** Every transaction in a block lands in exactly one bucket —
   failed / no-token-balances / no-vault-pair / swap — and the buckets must sum to the total.
   Anything unaccounted for is a silent drop.
2. **Instrument a filter funnel.** Count candidates killed at each stage. Zero results then
   distinguishes "nothing there" from "one filter eats everything."
3. **Treat a suspiciously empty result as an alarm, not a pass.** Bug 2 reported "no trades found"
   and looked perfectly healthy.

Derive the same fact two independent ways and cross-check. Deriving the pool fee from observed
swaps rather than assuming 0.25% is what flagged a non-constant-product pool: the good pools solved
to 25 bps with a 0.0002% residual, while the bad one pinned to the 100 bps boundary at 0.0606%. A
model that does not fit announces itself, but only if you let it.
