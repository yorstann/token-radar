[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yorstann/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yorstann/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar

An entry for the make.fun bounty [Build the best token launch radar](https://make.fun/bounty/token-radar-01).

The radar sweeps a sealed snapshot of 758 DeFi protocols (DefiLlama data, as of 2026-11-14) and ranks all **342 protocols that record no token yet** by what a launch could be worth — then tells the reader exactly how to farm each one.

## The value model

Every figure comes from the snapshot itself; no protocol is priced by name.

`impliedValue() = TVL × categoryMultiple() × momentum × maturity × breadth × ecosystem`

- **categoryMultiple()** — the median market-cap/TVL of the category's tokenized peers that carry a *positive* market cap (a token priced at zero says nothing), winsorized at the peer set's 90th percentile, then blended toward the global priced median in log space with the peer set's **confidence** as the weight: its depth (peers vs. phantom peers) times the agreement of its middle half (the p25–p75 spread). A category priced by one name at the cap lands near the market instead of topping the board.
- **momentum** — the 7-day TVL change in two tanh-damped parts: the move itself and the move against the protocol's own category median, weighted by **scale reliability** (a swing on a $5M base is noisier than on a $5B base), clamped to 0.62–1.55. A +4,000% print cannot buy the board.
- **maturity** — time survived with no token on a diminishing curve (0.86 + 0.34 × (1 − e^(−age/650d))), so the first year earns most of the credit and year three still counts.
- **breadth** — a square-root bonus for chain count, capped at twelve chains.
- **ecosystem** — 0.98 + 0.05 × chain quality, where a chain's quality is its depth in the snapshot's priced peer set, log-normalised: launching where priced peers already live is worth more.
- **shadow discount** — wrapped, staked or bridged products of an already-tokenized parent, and the exchange/bridge/staking categories the watchlist rule excludes, are priced at 0.35× and flagged: they record no token, but they are not clean launch candidates.

The board covers the house watchlist 40/40 and ranks all 342 pre-token protocols; each row carries a concrete farm plan (5–7 steps with a dollar cost band and a weekly time estimate) generated from its category, chains and TVL tier — including a risk step worded from the protocol's own 7-day print when it falls 15%+, spikes 20%+, or reports no change at all.

## The dashboard

A dark radar-themed page: a Top-10 strip, a sortable and filterable board (search, category, chain, watchlist-only, hide-shadow) with a per-row Signal bar (a 0–100 context score inside the board's own distribution — it never moves a rank), header sweep stats, and a detail view per protocol that shows the model breakdown with factor bars, the peer set's p25–p75 range with the calibrated multiple marked, a seven-day TVL bridge (the two endpoints the snapshot actually carries — no daily path is invented), and its farm plan as a checklist.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18+, standard library only. The program is deterministic: two runs write byte-identical `board.json`, dashboard data, and `dossier.json`.
