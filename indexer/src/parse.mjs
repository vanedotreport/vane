// Vane — parsers. Everything that decides WHAT something is lives here.
//
// The detection logic was never the hard part. Every real defect so far came from deciding what
// counts as a swap, a pool, or a creator — and each one returned a confident wrong answer rather
// than throwing. So the rules in this file are derived from inspecting real mainnet transactions,
// not from memory or documentation, and each carries the evidence that produced it.

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const WSOL = "So11111111111111111111111111111111111111112";

/** Programs invoked by nearly every transaction — useless for identifying a venue. */
const PLUMBING = new Set([
  SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022,
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
]);

const signers = (tx) => (tx.transaction.message.accountKeys ?? []).filter((k) => k.signer).map((k) => k.pubkey);
const feePayer = (tx) => tx.transaction.message.accountKeys?.[0]?.pubkey ?? null;

/** Walk top-level and inner instructions together. Token creation is ALWAYS inner (see FINDINGS 01). */
export function* allInstructions(tx) {
  for (const ix of tx.transaction.message.instructions ?? []) yield { ix, inner: false };
  for (const grp of tx.meta?.innerInstructions ?? [])
    for (const ix of grp.instructions ?? []) yield { ix, inner: true };
}

// ---------------------------------------------------------------------------
// CREATOR  (FINDINGS 04)
// ---------------------------------------------------------------------------

/**
 * Who created this token.
 *
 * The obvious answer — the fee payer — is wrong often enough to matter, because launchpads sponsor
 * transactions and the payer is then the platform. Using it inverted a real signal: wallets that
 * "minted several tokens in a minute" produced tokens that survived BETTER, because those wallets
 * were infrastructure rather than serial deployers.
 *
 * The rule below came from inspecting a real Pump.fun creation, which has exactly two signers:
 *
 *     GdZnYWVamLqrhLC9kxb4wNkS2aSJnWEmJ1hKHSixx2TT   <- the human
 *     3SV5PY1kkZfpEBG4a8LiAnw45EUrxGsdKFdr3RNUpump   <- the mint, signing its own creation
 *
 * So: the signer that is not the mint. Mint keypairs sign because the account is being created.
 *
 * Note what is deliberately NOT used. `mintAuthority` at initialize was `TSLvdd1p…`, a Pump.fun
 * PDA — a program address, not a person. Attribution from mint authority would name the launchpad
 * for every token it ever produced.
 *
 * WHEN IT CANNOT TELL, IT RETURNS NULL. This claim names a person; "unresolved" is a fine answer
 * and a wrong name is not. Every candidate is returned regardless so the decision can be
 * recomputed later without re-indexing.
 */
export function resolveCreator(tx, mint) {
  const sigs = signers(tx);
  const payer = feePayer(tx);
  const candidates = sigs.filter((s) => s !== mint && !PLUMBING.has(s));

  if (candidates.length === 1) {
    return {
      creator: candidates[0],
      source: candidates[0] === payer ? "sole_signer" : "signer_not_payer",
      candidates, feePayer: payer,
    };
  }
  // Several human signers, or none. Multisig, batch mint, or something we have not seen.
  return { creator: null, source: "unresolved", candidates, feePayer: payer };
}

// ---------------------------------------------------------------------------
// MINT CREATION
// ---------------------------------------------------------------------------

/**
 * Extract token creations from a transaction.
 *
 * `authorityRevokedInTx` exists because of a measurement error worth remembering: reading
 * `initializeMint.mintAuthority` and reporting "0 of 40 tokens had authority revoked at creation"
 * described the wrong moment. Pump.fun revokes via `setAuthority` in the SAME transaction, a few
 * instructions later. The state at `initializeMint` is not the state at the end of the block.
 */
export function extractMints(tx, slot, blockTime) {
  if (tx.meta?.err) return [];
  const out = [];
  const revoked = new Set();      // mints whose mintTokens authority was cleared in this tx
  const frozen = new Map();       // mint -> freeze authority as left by this tx
  const recipients = new Map();   // mint -> owner of the first mintTo destination

  for (const { ix } of allInstructions(tx)) {
    const t = ix?.parsed?.type, info = ix?.parsed?.info;
    if (!t || !info) continue;
    if (t === "setAuthority" && info.authorityType === "mintTokens" && info.newAuthority == null)
      revoked.add(info.mint);
    if (t === "setAuthority" && info.authorityType === "freezeAccount")
      frozen.set(info.mint, info.newAuthority ?? null);
    if (t === "mintTo" && !recipients.has(info.mint)) recipients.set(info.mint, info.account);
  }

  for (const { ix, inner } of allInstructions(tx)) {
    const t = ix?.parsed?.type;
    if (t !== "initializeMint" && t !== "initializeMint2") continue;
    const info = ix.parsed.info;
    const mint = info.mint;

    const programs = new Set();
    for (const { ix: any } of allInstructions(tx)) if (any.programId) programs.add(any.programId);
    const venue = [...programs].filter((p) => !PLUMBING.has(p));

    out.push({
      mint, slot, blockTime, signature: tx.transaction.signatures[0],
      decimals: info.decimals,
      innerInstruction: inner,
      mintAuthorityAtInit: info.mintAuthority ?? null,
      freezeAuthorityAtInit: info.freezeAuthority ?? null,
      // end-of-transaction state, which is the one that matters
      mintAuthorityRevoked: revoked.has(mint),
      freezeAuthority: frozen.has(mint) ? frozen.get(mint) : (info.freezeAuthority ?? null),
      initialRecipient: recipients.get(mint) ?? null,
      venue,
      primaryVenue: venue[0] ?? null,
      ...resolveCreator(tx, mint),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SWAPS  (FINDINGS 02, 03)
// ---------------------------------------------------------------------------

/**
 * Every trade against a pool in this transaction.
 *
 * A swap is identified by BALANCE DELTAS, never by decoding instruction data — the first token we
 * sampled referenced a pool and moved nothing, and instruction-based detection would have counted
 * it. If the pool's two sides did not move in opposite directions, no trade happened here.
 *
 * The quote leg falls back to NATIVE LAMPORTS. Pump.fun bonding curves hold native SOL, which
 * never appears in pre/postTokenBalances, so a token-balance-only parser is structurally blind to
 * the most common launchpad on Solana — and it reports "no trades found" rather than failing.
 */
export function extractSwaps(tx, { mintFilter = null } = {}) {
  if (tx.meta?.err) return [];
  const meta = tx.meta, msg = tx.transaction.message;
  const pre = meta.preTokenBalances ?? [], post = meta.postTokenBalances ?? [];
  if (!post.length) return [];

  const keys = (msg.accountKeys ?? []).map((k) => k.pubkey);
  const payer = keys[0];
  const preM = new Map(pre.map((b) => [String(b.accountIndex), b]));

  // FINDINGS 02 — native SOL is invisible to token balances.
  const lam = new Map();
  (meta.postBalances ?? []).forEach((v, i) => {
    const d = BigInt(v) - BigInt(meta.preBalances?.[i] ?? 0);
    if (d !== 0n) lam.set(keys[i], { delta: d, before: BigInt(meta.preBalances?.[i] ?? 0), after: BigInt(v) });
  });

  // group token deltas by owner
  const byOwner = new Map();
  for (const b of post) {
    const p = preM.get(String(b.accountIndex));
    if (!b.owner) continue;
    const delta = BigInt(b.uiTokenAmount.amount) - BigInt(p?.uiTokenAmount?.amount ?? "0");
    if (delta === 0n) continue;
    if (!byOwner.has(b.owner)) byOwner.set(b.owner, []);
    byOwner.get(b.owner).push({
      mint: b.mint, delta, dec: b.uiTokenAmount.decimals,
      before: BigInt(p?.uiTokenAmount?.amount ?? "0"), after: BigInt(b.uiTokenAmount.amount),
    });
  }

  const out = [];
  for (const [owner, legs] of byOwner) {
    if (owner === payer) continue;                     // the trader's own wallet is not a pool
    const base = mintFilter ? legs.find((l) => l.mint === mintFilter) : null;
    const pairs = base ? [base] : legs;

    for (const tok of pairs) {
      let quote = legs.find((l) => l !== tok && (l.delta > 0n) !== (tok.delta > 0n));
      let native = false;
      if (!quote) {
        const l = lam.get(owner);
        if (l && (l.delta > 0n) !== (tok.delta > 0n))
          { quote = { mint: WSOL, delta: l.delta, before: l.before, after: l.after, dec: 9 }; native = true; }
      }
      if (!quote) continue;

      out.push({
        signature: tx.transaction.signatures[0], signer: payer, pool: owner, native,
        side: tok.delta > 0n ? "SELL" : "BUY",        // pool receives token => trader sold
        tokenMint: tok.mint, tokenAmt: tok.delta > 0n ? tok.delta : -tok.delta, tokenDec: tok.dec,
        quoteMint: quote.mint, quoteAmt: quote.delta > 0n ? quote.delta : -quote.delta, quoteDec: quote.dec,
        quoteBefore: quote.before, quoteAfter: quote.after,
      });
      if (base) break;
    }
  }
  return out;
}

/**
 * Split a trade tape into venues.  (FINDINGS 03)
 *
 * A token trades on its bonding curve AND its graduated pool. Merging them — and taking decimals
 * from whichever trade happened to be first — produced "66.7% of pool liquidity removed in one
 * transaction" out of a two-lamport dust trade, while peak liquidity read 568 SOL and every bucket
 * read 0.002 SOL. Reserves are only comparable within one pool, one quote asset, one decimal scale.
 */
export function byVenue(tape) {
  const m = new Map();
  for (const t of tape) {
    const k = `${t.pool}|${t.quoteMint}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return [...m.entries()]
    .map(([key, trades]) => {
      const [pool, quoteMint] = key.split("|");
      const dec = trades[0].quoteDec;
      return {
        pool, quoteMint, quoteDec: dec, trades: trades.sort((a, b) => a.slot - b.slot || a.index - b.index),
        volume: trades.reduce((a, t) => a + Number(t.quoteAmt) / 10 ** dec, 0),
      };
    })
    .sort((a, b) => b.volume - a.volume);
}

/**
 * The largest single extraction from a venue.
 *
 * `floorFraction` is not optional. Percentage with no absolute floor lets a two-lamport trade
 * against three lamports of reserve score 66.7% and win — which is precisely how the bogus
 * headline was produced.
 */
export function largestExtraction(venue, { floorFraction = 0.02 } = {}) {
  const dec = venue.quoteDec;
  const N = (v) => Number(v) / 10 ** dec;
  const peak = Math.max(...venue.trades.map((t) => Math.max(N(t.quoteBefore), N(t.quoteAfter))), 0);
  const floor = peak * floorFraction;

  let worst = null;
  for (const t of venue.trades) {
    if (t.side !== "SELL") continue;
    const before = N(t.quoteBefore), took = N(t.quoteAmt);
    if (before <= 0 || took < floor) continue;
    if (!worst || took > worst.took) worst = { ...t, took, poolBefore: before, share: took / before };
  }
  return { peak, floor, worst };
}
