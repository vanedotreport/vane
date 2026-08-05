# Vane — brand

**Name** Vane · **Domain** vane.report · **Handle** @vanedotreport
**Tagline** Which way the flow is moving.

Keep the tagline near the wordmark. Spoken aloud, "Vane" collides with *vain* and *vein*; the
tagline is what disambiguates, and it does it in four words.

---

## The mark — Barb

A **wind barb**: the notation meteorologists use to write speed and direction as one glyph. Not a
picture of an instrument — a *reading taken by one*.

- The staff is the sequence. Barbs are slots. Lengths vary because activity varies.
- **One barb is brass, longest, and the only one that crosses the staff.** That is the anomaly.

Remove the brass barb and you have a tidy chart glyph. Leave it and the mark states the thesis
before anyone reads a word: most of what happens is ordinary, one thing isn't, and we point at
that one. **Never ship the mark without it.**

| File | Use |
|---|---|
| `mark.svg` | Default. Two colour, ≥20px. |
| `mark-mono.svg` | One colour; inherits `currentColor`. The anomaly keeps emphasis through stroke weight instead of hue. |
| `favicon.svg` | **≤20px only.** A separate cut, not a scaled mark — six barbs turn to mush, so it drops to three and thickens the strokes. |

The mark leans right, into the wordmark. In a lockup give it slightly more optical space on the
right than the left; mathematically equal padding will look wrong.

### Marks that were rejected, and why
Kept here so nobody re-proposes them.

- **Slot planes** (receding lines, one flagged) — conceptually the best, indistinguishable from a
  hamburger menu at 16px.
- **Three dots bracketing a victim** — reads as an overflow menu; people try to click it. Also welds
  the brand to one detector.
- **Noise resolving into a vector** — the strongest *idea* and the worst mark; at 16px the meaning
  is two pixels wide and all that survives is an arrow. **Use it as the loading animation** while an
  analysis runs, where it can be large and move.

---

## Colour

Full values in `tokens.css`. Style through the variables; never hardcode hex.

- **Neutrals** are chart paper with a cool bias. A pure mid-grey reads as unchosen.
- **`--accent` (prussian)** is *structure*: the staff, links, primary buttons, the confidence gauge.
- **`--brass`** is *the anomaly and the live state, and nothing else.* Its scarcity is the whole
  reason it reads. If everything is flagged, nothing is.
- **Semantic colours are separate from the brand** — severity must never be mistaken for identity,
  and no chart series may borrow a status colour.
- **Dark mode is a re-pick, not an inversion.** Both brand hues fail contrast on a dark ground at
  their light-theme values, so they lift.

---

## Type

Three faces, mapped to three depths of disclosure, so the reader knows the register before reading
a label:

| Face | Carries |
|---|---|
| `--sans` | interface chrome — labels, buttons, navigation |
| `--serif` | **plain-language explanation.** It is prose, so it looks like prose. |
| `--mono` | data — addresses, amounts, slots, raw output. Always `tabular-nums`. |

This is the accessibility mechanism, not decoration: the same event told three ways, and the
typeface tells you which telling you're in.

---

## Voice

- **Plain first, precise second.** "A bot got in front of this trade and took $47" before
  `p = 0.9412`. Both are true; only one of them is an opening line.
- **Say the confidence, every time, in the register of the layer.** "Very likely" → "p ≈ 0.94" →
  "4 of 5 criteria met."
- **Say "unsure" out loud.** A weak signal shipped with its weakness stated is what makes the
  strong ones credible.
- **Report the misses.** The published hit rate is the product, not a footnote — including the
  months it got worse.
- **Never fabricate certainty about something unmeasurable.** If it can't be measured, the answer
  is "we don't know", never a confident number.
