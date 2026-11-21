[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yorstann/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yorstann/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar

An entry for the make.fun bounty [Build the best token launch radar](https://make.fun/bounty/token-radar-01).

The radar sweeps a sealed snapshot of 758 DeFi protocols (DefiLlama data, as of 2026-11-14) and ranks all **342 protocols that record no token yet** by what a launch could be worth — then tells the reader exactly how to farm each one.

## The value model

Every figure comes from the snapshot itself; no protocol is priced by name.

`impliedValue() = TVL × categoryMultiple() × momentum × maturity × breadth`

- **categoryMultiple()** — the median market-cap/TVL of the category's already-tokenized peers in the same snapshot, winsorized at the peer set's 90th percentile and shrunk toward the global tokenized median when a category has few peers.
- **momentum** — the protocol's 7-day TVL change, clamped to 0.70–1.60.
- **maturity** — grows with the days the protocol has run with no token (track record), capped at two years.
- **breadth** — a small bonus per chain deployed on, up to five.
- **shadow discount** — wrapped, staked or bridged products of an already-tokenized parent, and the exchange/bridge/staking categories the watchlist rule excludes, are priced at 0.35× and flagged: they record no token, but they are not clean launch candidates.

The board covers the house watchlist 40/40 and ranks all 342 pre-token protocols; each row carries a concrete farm plan (5–6 steps with a dollar cost band and a weekly time estimate) generated from its category, chains and TVL tier.

## The dashboard

A dark radar-themed page: sortable and filterable board (search, category, chain, watchlist-only, hide-shadow), header sweep stats, and a detail view per protocol that shows the model breakdown with the protocol's own numbers and its farm plan as a checklist.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18+, standard library only. The program is deterministic: two runs write byte-identical `board.json`, dashboard data, and `dossier.json`.
