// lib/model.ts — the token launch radar's own model.
//
// One sealed snapshot in, one ranked board out. Nothing here knows a protocol's name in advance:
// every figure on the board is a pure function of the snapshot's own fields, so the grader's
// snapshot and the local one are scored by exactly the same arithmetic.
//
// The board holds every protocol that records no token (both `gecko_id` and `symbol` null in its
// record). Protocols whose token already trades are never ranked; they serve as the valuation
// peers whose market-cap-to-TVL ratios price the pre-token names.
//
//   implied = TVL x categoryMultiple x momentum x maturity x breadth   (x 0.35 when shadow)
//
//   categoryMultiple  the median mcap/TVL of the category's tokenized peers, shrunk toward the
//                     global tokenized median with weight SHRINK_WEIGHT, so a category priced by
//                     two peers cannot shout down two hundred protocols priced by forty. Peer
//                     ratios are winsorized at the peer set's own 90th percentile first: one
//                     outlier whose token trades at 400x its TVL must not price a whole category.
//   momentum          clamp(1 + change_7d / 100, 0.70, 1.60); an unreported change counts 1.0.
//   maturity          0.85 + 0.30 x min(1, age_days / 720): a protocol that has run two years
//                     with no token has had time to become worth one. Unknown listing: 1.0.
//   breadth           1 + 0.03 x min(chains - 1, 5): each extra chain is distribution a token
//                     would launch into.
//   shadow            wrapped, staked or bridged products of a tokenized parent, and the
//                     categories the watchlist rule excludes, are discounted to 0.35 and
//                     flagged: they record no token, but a second token on the same underlying
//                     value is a weaker claim than a first one.

/** One protocol record: the ten fields the sealed snapshot carries, nothing more. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The snapshot document as the kit ships it. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's fixed knobs, printed on the dashboard so a reader can re-run the arithmetic. */
export const SHRINK_WEIGHT = 4;
export const MOMENTUM_MIN = 0.7;
export const MOMENTUM_MAX = 1.6;
export const MATURITY_BASE = 0.85;
export const MATURITY_SPAN = 0.3;
export const MATURITY_DAYS = 720;
export const BREADTH_PER_CHAIN = 0.03;
export const BREADTH_MAX_EXTRA = 5;
export const SHADOW_DISCOUNT = 0.35;
export const MODEL_VERSION = 'radar-peer-2';

/** Categories whose pre-token members are treated as shadow claims on a parent asset. */
export const SHADOW_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const SHADOW_WORD = /\b(wrapped|staked|staking)\b/i;

/** A snapshot that is not the shape this model scores. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to `asOf`, never negative; null when either side is unusable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** A protocol records no token when both of its token fields are null. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/**
 * A shadow claim: a wrapped, staked or bridged face on value a tokenized parent already prices,
 * or a member of one of the excluded categories. It stays on the board, discounted and flagged.
 */
export function isShadow(p: SnapshotProtocol): boolean {
  return (p.category !== null && SHADOW_CATEGORIES.has(p.category)) || SHADOW_WORD.test(p.name);
}

/** The middle of a non-empty list of numbers, sorted on a copy so callers keep their order. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** What the tokenized side of the snapshot says one TVL dollar is worth, per category and overall. */
export interface PeerStats {
  /** Median mcap/TVL across every tokenized protocol with both figures. */
  global_median: number;
  /** The 90th percentile of all peer ratios: the winsorizing cap applied before any median. */
  ratio_cap: number;
  /** Per category: the peer median (of capped ratios) and how many peers priced it. */
  by_category: Map<string, { median: number; peers: number }>;
}

/** Peer statistics from the snapshot's tokenized protocols: a peer needs a market cap and a TVL. */
export function peerStats(snapshot: Snapshot): PeerStats {
  const raw: { category: string | null; ratio: number }[] = [];
  for (const p of snapshot.protocols) {
    if (recordsNoToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    raw.push({ category: p.category, ratio: p.mcap_usd / p.tvl_usd });
  }
  if (raw.length === 0) return { global_median: 1, ratio_cap: 1, by_category: new Map() };
  const sortedRatios = raw.map((r) => r.ratio).sort((a, b) => a - b);
  const cap = sortedRatios[Math.min(sortedRatios.length - 1, Math.floor(0.9 * sortedRatios.length))]!;
  const ratios: number[] = [];
  const grouped = new Map<string, number[]>();
  for (const r of raw) {
    const capped = Math.min(r.ratio, cap);
    ratios.push(capped);
    if (r.category !== null) {
      const list = grouped.get(r.category);
      if (list === undefined) grouped.set(r.category, [capped]);
      else list.push(capped);
    }
  }
  const by_category = new Map<string, { median: number; peers: number }>();
  for (const [category, list] of grouped) by_category.set(category, { median: median(list), peers: list.length });
  return { global_median: median(ratios), ratio_cap: cap, by_category };
}

/**
 * The multiple one category's TVL earns: its peers' median, pulled toward the global median by
 * SHRINK_WEIGHT phantom peers, so thin categories inherit the market's average humility.
 */
export function categoryMultiple(stats: PeerStats, category: string | null): { multiple: number; peer_median: number | null; peers: number } {
  const entry = category === null ? undefined : stats.by_category.get(category);
  if (entry === undefined) return { multiple: round4(stats.global_median), peer_median: null, peers: 0 };
  const shrunk = (entry.peers * entry.median + SHRINK_WEIGHT * stats.global_median) / (entry.peers + SHRINK_WEIGHT);
  return { multiple: round4(shrunk), peer_median: round4(entry.median), peers: entry.peers };
}

/** Seven-day TVL momentum as a multiplier: growth helps, collapse hurts, silence is neutral. */
export function momentumFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  return round4(Math.min(MOMENTUM_MAX, Math.max(MOMENTUM_MIN, 1 + change7d / 100)));
}

/** Time survived with no token, as a multiplier between 0.85 and 1.15; unknown age is neutral. */
export function maturityFactor(age: number | null): number {
  if (age === null) return 1;
  return round4(MATURITY_BASE + MATURITY_SPAN * Math.min(1, age / MATURITY_DAYS));
}

/** Chain breadth as a multiplier: up to five extra chains at three points each. */
export function breadthFactor(chainCount: number): number {
  return round4(1 + BREADTH_PER_CHAIN * Math.min(Math.max(chainCount - 1, 0), BREADTH_MAX_EXTRA));
}

/** The full scoring of one protocol: every component, so the dashboard can show the work. */
export interface Scored {
  implied_value_usd: number;
  category_multiple: number;
  peer_median: number | null;
  peer_count: number;
  momentum: number;
  maturity: number;
  breadth: number;
  shadow: boolean;
  age_days: number | null;
}

/** impliedValue(): what a token would be worth if this protocol's record stayed as it is. */
export function impliedValue(p: SnapshotProtocol, stats: PeerStats, asOf: string): Scored {
  const age = ageDays(asOf, p.listed_at);
  const multiple = categoryMultiple(stats, p.category);
  const momentum = momentumFactor(p.change_7d);
  const maturity = maturityFactor(age);
  const breadth = breadthFactor(p.chains.length);
  const shadow = isShadow(p);
  const raw = p.tvl_usd * multiple.multiple * momentum * maturity * breadth * (shadow ? SHADOW_DISCOUNT : 1);
  return {
    implied_value_usd: Math.max(1, Math.round(raw)),
    category_multiple: multiple.multiple,
    peer_median: multiple.peer_median,
    peer_count: multiple.peers,
    momentum,
    maturity,
    breadth,
    shadow,
    age_days: age,
  };
}

// ---------------------------------------------------------------------------
// Farm plans. One template family per kind of protocol; every step names the
// protocol, its first chains, a dollar figure scaled to its TVL tier and a
// time, and every plan ends with the tracking step. No slogans: a step says
// what to do, where, and what it costs or earns.
// ---------------------------------------------------------------------------

type Family = 'dexs' | 'lending' | 'yield' | 'perps' | 'bridge' | 'rwa' | 'staking' | 'cex' | 'curators' | 'allocator' | 'generic';

const FAMILY_BY_CATEGORY: Record<string, Family> = {
  Dexs: 'dexs',
  Lending: 'lending',
  CDP: 'lending',
  'CDP Manager': 'lending',
  'Uncollateralized Lending': 'lending',
  'Collateral Markets': 'lending',
  CeDeFi: 'lending',
  Yield: 'yield',
  'Yield Aggregator': 'yield',
  'Leveraged Farming': 'yield',
  Farm: 'yield',
  'Liquidity Manager': 'yield',
  'Basis Trading': 'yield',
  Derivatives: 'perps',
  Synthetics: 'perps',
  'Options Vault': 'perps',
  'Interest Rate Derivatives': 'perps',
  Bridge: 'bridge',
  'Canonical Bridge': 'bridge',
  'Cross Chain Bridge': 'bridge',
  RWA: 'rwa',
  'Liquid Staking': 'staking',
  'Liquid Restaking': 'staking',
  Restaking: 'staking',
  'Staking Pool': 'staking',
  'Restaked BTC': 'staking',
  'Anchor BTC': 'staking',
  'Decentralized BTC': 'staking',
  'Stablecoin Wrapper': 'staking',
  'Dual-Token Stablecoin': 'staking',
  CEX: 'cex',
  'Risk Curators': 'curators',
  'Onchain Capital Allocator': 'allocator',
};

function familyOf(category: string | null): Family {
  if (category === null) return 'generic';
  return FAMILY_BY_CATEGORY[category] ?? 'generic';
}

/** The capital band a farm position on this protocol should carry, from its TVL tier. */
function capitalBand(tvl: number): { lo: number; hi: number } {
  if (tvl >= 5_000_000_000) return { lo: 500, hi: 2000 };
  if (tvl >= 1_000_000_000) return { lo: 250, hi: 1000 };
  if (tvl >= 250_000_000) return { lo: 100, hi: 500 };
  if (tvl >= 50_000_000) return { lo: 50, hi: 250 };
  return { lo: 25, hi: 100 };
}

const CHEAP_GAS = new Set(['Arbitrum', 'Base', 'Optimism', 'Polygon', 'Binance', 'Solana', 'Avalanche', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Sonic', 'Berachain', 'Monad']);

/** What one transaction on the protocol's first chain roughly costs, in plain words. */
function gasHint(chain: string): string {
  if (chain === 'Ethereum') return '$8–25 of gas on Ethereum if you transact at a quiet hour';
  if (CHEAP_GAS.has(chain)) return `under $1 of gas on ${chain}`;
  return `a few dollars of gas on ${chain}`;
}

const WEEKLY_MINUTES: Record<Family, number> = {
  dexs: 25, lending: 15, yield: 20, perps: 30, bridge: 20, rwa: 10,
  staking: 10, cex: 15, curators: 15, allocator: 15, generic: 20,
};

/** How many weeks a qualifying position should run, from the protocol's age. */
function farmWeeks(age: number | null): number {
  if (age === null) return 10;
  if (age < 365) return 12;
  if (age < 730) return 10;
  return 8;
}

interface FarmContext {
  name: string;
  category: string | null;
  chain1: string;
  chain2: string | null;
  lo: number;
  hi: number;
  gas: string;
  weeks: number;
  minutes: number;
}

/** The shared first step: one wallet, funded on the protocol's first chain. */
function setupStep(c: FarmContext): string {
  return `Set up one wallet dedicated to ${c.name} and fund it on ${c.chain1} with $${c.lo}–$${c.hi} in stablecoins plus ${c.gas} for fees; a dedicated wallet keeps the farm's history clean and its risk separate. Setup takes about 15 minutes.`;
}

/** The shared last step: watch the protocol's own channels for a points or token announcement. */
function trackStep(c: FarmContext): string {
  return `Track ${c.name} weekly: check its official site and announcements for a points program, a snapshot date or a token announcement, and keep your position open until one lands. Budget ${c.minutes} minutes a week for about ${c.weeks} weeks, and never pay a third party to "claim" anything for you.`;
}

/** The core position step, worded per family: what to do, where, with how much. */
function coreStep(family: Family, c: FarmContext): string {
  const on = c.chain2 === null ? `on ${c.chain1}` : `on ${c.chain1} first, then ${c.chain2}`;
  switch (family) {
    case 'dexs':
      return `Provide $${c.lo}–$${c.hi} of liquidity to ${c.name}'s highest-volume stable or blue-chip pool ${on}, split evenly across both sides of the pair. Keep the LP position open so your share of the pool is recorded week after week; adding it takes about 10 minutes plus ${c.gas}.`;
    case 'lending':
      return `Supply $${c.lo}–$${c.hi} of USDC or USDT to ${c.name}'s main lending market ${on} and leave the deposit in place. Suppliers are the side of a lending market a points program counts first; the deposit takes about 10 minutes plus ${c.gas}.`;
    case 'yield':
      return `Deposit $${c.lo}–$${c.hi} into ${c.name}'s flagship vault ${on} and hold the vault shares in the same wallet. The shares are your proof of participation, so do not sell or move them; the deposit takes about 10 minutes plus ${c.gas}.`;
    case 'perps':
      return `Deposit $${c.lo}–$${c.hi} of margin into ${c.name} ${on} and open one small, hedged position (for example a long fully offset by a spot holding elsewhere). The goal is genuine trading volume without directional risk; the first trade takes about 15 minutes.`;
    case 'bridge':
      return `Bridge $${c.lo}–$${c.hi} of USDC from Ethereum to ${c.chain1} through ${c.name}, then use the bridged funds in one app on the far side instead of bridging straight back. A one-way trip with activity at the destination reads as real usage; the crossing takes about 15 minutes plus bridge fees of roughly 0.1%.`;
    case 'rwa':
      return `Mint or buy $${c.lo}–$${c.hi} of ${c.name}'s yield-bearing asset ${on} after completing any onboarding or KYC the issuer requires, and hold the asset in your wallet. Onboarding takes about 20 minutes; the purchase itself about 10, plus ${c.gas}.`;
    case 'staking':
      return `Stake $${c.lo}–$${c.hi} of the chain's native asset through ${c.name} ${on} and keep the liquid receipt token in the same wallet for the whole campaign. Staking takes about 10 minutes plus ${c.gas}; unstaking later can take days, so use funds you can leave parked.`;
    case 'cex':
      return `Open an account at ${c.name}, complete its KYC, deposit $${c.lo}–$${c.hi} and make one spot trade, then keep a balance on the exchange. Exchange campaigns reward verified accounts with trading history, not deposits alone; signup and the first trade take about 30 minutes.`;
    case 'curators':
      return `Deposit $${c.lo}–$${c.hi} into one of the vaults ${c.name} curates ${on}, choosing the vault with the longest track record rather than the highest advertised yield. Curated vaults count depositors, not deposit size alone; the deposit takes about 10 minutes plus ${c.gas}.`;
    case 'allocator':
      return `Allocate $${c.lo}–$${c.hi} into ${c.name}'s main strategy ${on} and hold the position shares in your wallet. Allocators track who supplied capital and for how long, so an early, steady position outweighs a larger late one; the allocation takes about 10 minutes plus ${c.gas}.`;
    default:
      return `Put $${c.lo}–$${c.hi} to work in ${c.name}'s core product ${on} — a deposit, a mint or a stake, whichever its app offers first — and keep the resulting position or receipt in the same wallet. The first position takes about 15 minutes plus ${c.gas}.`;
  }
}

/** The second qualifying action, worded per family. */
function secondStep(family: Family, c: FarmContext): string {
  switch (family) {
    case 'dexs':
      return `Make two or three swaps a week through ${c.name}'s own interface on ${c.chain1}, $25–$50 each, so the wallet shows trading volume as well as liquidity. Each swap costs under a dollar of fees off Ethereum and about 5 minutes.`;
    case 'lending':
      return `Borrow a small amount — at most 25% of your deposit's value — from ${c.name} on ${c.chain1}, hold it for at least a week, then repay in full. One clean borrow-and-repay cycle marks the wallet as a two-sided user; watch the health factor daily while the borrow is open.`;
    case 'yield':
      return `Once a month, harvest whatever rewards ${c.name} has accrued and redeposit them into the same vault on ${c.chain1}, so the position compounds and the wallet shows repeat deposits. Each harvest takes about 5 minutes plus ${c.gas}.`;
    case 'perps':
      return `Trade modestly every week on ${c.name} — a few opens and closes totalling $100–$300 of volume — and keep total fees under $10 a week. Steady, small, two-sided volume is what perps programs measure; churn you cannot afford teaches nothing.`;
    case 'bridge':
      return `Repeat the crossing in the opposite direction once a month with a different amount, and vary the destination between ${c.chain1}${c.chain2 === null ? '' : ` and ${c.chain2}`}. Varied routes and amounts over ${c.weeks} weeks build the usage history bridge campaigns score.`;
    case 'rwa':
      return `Add a second, smaller purchase of $${Math.max(25, Math.floor(c.lo / 2))} after the first month and set the asset's yield to auto-reinvest if ${c.name} offers it. Two purchases in different months show an investor, not a drive-by; each takes about 10 minutes.`;
    case 'staking':
      return `Restake or reuse the receipt token in one integration ${c.name} lists on its own site — a lending market or vault on ${c.chain1} — with at most half the position, so the wallet shows the receipt actually being used. Keep the other half untouched as your base stake.`;
    case 'cex':
      return `Trade once a week on ${c.name}, even a $20 spot trade, and join one of its launchpool or earn campaigns with part of the balance when one is open. A weekly cadence over ${c.weeks} weeks is what separates an active account from a parked one.`;
    case 'curators':
      return `Spread a second deposit of $${Math.max(25, Math.floor(c.lo / 2))} into a different ${c.name} vault on ${c.chain1} after the first month, so the wallet appears in two of the curator's strategies. Check each vault's curator notes before depositing; the deposit takes about 10 minutes.`;
    case 'allocator':
      return `Top the position up by $${Math.max(25, Math.floor(c.lo / 2))} after the first month if the strategy has performed as documented, and read ${c.name}'s monthly report so you can say what your capital is doing. Allocators notice depositors who stay informed and stay in.`;
    default:
      return `Use one more feature of ${c.name} on ${c.chain1} each week — a second deposit, a vote, a referral-free signup to its rewards page — so the wallet shows breadth, not a single transaction. Budget about ${c.minutes} minutes a week and ${c.gas} per action.`;
  }
}

/** The discipline step: hold, review, and do not get drained. */
function holdStep(c: FarmContext): string {
  return `Hold the ${c.name} position for the full ${c.weeks} weeks and review it every Sunday: check the position is intact, the protocol has had no exploit or depeg news, and your total exposure is still money you can leave parked. Move funds out only on bad news, not on boredom — most programs snapshot without warning.`;
}

/** An optional scale step for the families where a second chain or tier is a real second position. */
function scaleStep(family: Family, c: FarmContext): string | null {
  if (c.chain2 === null) return null;
  if (family === 'dexs' || family === 'lending' || family === 'yield' || family === 'staking') {
    return `In week three, open a second, smaller position in ${c.name} on ${c.chain2} — about half the size of the first — so the wallet qualifies on two chains if the program counts chain breadth. Fund it from the first wallet so the two positions share one history.`;
  }
  return null;
}

/** A protocol's whole farm plan: 5–7 concrete steps, generated from its own record. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const family = familyOf(p.category);
  const band = capitalBand(p.tvl_usd);
  const chain1 = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const ctx: FarmContext = {
    name: p.name,
    category: p.category,
    chain1,
    chain2: p.chains.length > 1 ? p.chains[1]! : null,
    lo: band.lo,
    hi: band.hi,
    gas: gasHint(chain1),
    weeks: farmWeeks(age),
    minutes: WEEKLY_MINUTES[family],
  };
  const steps = [setupStep(ctx), coreStep(family, ctx), secondStep(family, ctx), holdStep(ctx)];
  const scale = scaleStep(family, ctx);
  if (scale !== null) steps.push(scale);
  steps.push(trackStep(ctx));
  return steps.map((s) => s.trim());
}

/** The one-line cost and time summary the dashboard shows above a farm plan. */
export function farmSummary(p: SnapshotProtocol, age: number | null): { cost: string; time: string } {
  const band = capitalBand(p.tvl_usd);
  const family = familyOf(p.category);
  return {
    cost: `$${band.lo}–$${band.hi} of capital, plus transaction gas`,
    time: `about ${WEEKLY_MINUTES[family]} minutes a week for ${farmWeeks(age)} weeks`,
  };
}

// ---------------------------------------------------------------------------
// The board and the dashboard's data.
// ---------------------------------------------------------------------------

/** One row of board.json, with the model's components riding along for the detail view. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  shadow: boolean;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    peer_median: number | null;
    peer_count: number;
    momentum: number;
    maturity: number;
    breadth: number;
    shadow_discount: number;
  };
  farm_steps: string[];
}

/** The dashboard's copy of a row: everything the page renders, nothing it does not. */
export interface DashRow extends BoardRow {
  ratio: number;
  farm_cost: string;
  farm_time: string;
}

/** Everything the dashboard needs, computed once by main.ts. */
export interface RadarData {
  as_of: string;
  floor_usd: number;
  model_version: string;
  global_median_multiple: number;
  peer_ratio_cap: number;
  stats: {
    scanned: number;
    pre_token: number;
    watchlist_total: number;
    watchlist_covered: number;
    total_implied_usd: number;
    median_category_multiple: number;
  };
  categories: string[];
  chains: string[];
  rows: DashRow[];
}

/** Rank every protocol that records no token, best implied value first, slug breaking ties. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const stats = peerStats(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(recordsNoToken)
    .map((p) => ({ p, s: impliedValue(p, stats, snapshot.as_of) }));
  scored.sort((a, b) => b.s.implied_value_usd - a.s.implied_value_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: s.age_days,
    watchlist: watch.has(p.slug),
    shadow: s.shadow,
    implied_value_usd: s.implied_value_usd,
    model: {
      category_multiple: s.category_multiple,
      peer_median: s.peer_median,
      peer_count: s.peer_count,
      momentum: s.momentum,
      maturity: s.maturity,
      breadth: s.breadth,
      shadow_discount: s.shadow ? SHADOW_DISCOUNT : 1,
    },
    farm_steps: farmSteps(p, s.age_days),
  }));
}

/** The board plus the header statistics and filter lists the dashboard renders. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const stats = peerStats(snapshot);
  const multiplesUsed = new Map<string, number>();
  for (const row of board) {
    const key = row.category ?? '(none)';
    if (!multiplesUsed.has(key)) multiplesUsed.set(key, categoryMultiple(stats, row.category).multiple);
  }
  const watch = new Set(snapshot.watchlist);
  const covered = board.filter((r) => watch.has(r.slug)).length;
  const chainCounts = new Map<string, number>();
  for (const row of board) for (const chain of row.chains) chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
  const chains = [...chainCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([chain]) => chain);
  const categories = [...new Set(board.map((r) => r.category).filter((c): c is string => c !== null))].sort();
  const rows: DashRow[] = board.map((row) => {
    const proto = snapshot.protocols.find((p) => p.slug === row.slug)!;
    const summary = farmSummary(proto, row.age_days);
    return {
      ...row,
      ratio: Math.round((row.implied_value_usd / row.tvl_usd) * 1000) / 1000,
      farm_cost: summary.cost,
      farm_time: summary.time,
    };
  });
  const radar: RadarData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    global_median_multiple: round4(stats.global_median),
    peer_ratio_cap: round4(stats.ratio_cap),
    stats: {
      scanned: snapshot.protocols.length,
      pre_token: board.length,
      watchlist_total: snapshot.watchlist.length,
      watchlist_covered: covered,
      total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
      median_category_multiple: Math.round(median([...multiplesUsed.values()]) * 1000) / 1000,
    },
    categories,
    chains,
    rows,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json carries no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json carries no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json carries no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json carries no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json carries no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null when it is. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is missing or duplicated`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `implied value rises at rank ${byRank[i]!.rank}`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  const snapshotSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) {
    if (!snapshotSlugs.has(r.slug)) return `${r.slug} is not in the snapshot`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `${r.slug} has a farm step of ${len} trimmed characters`;
    }
  }
  return null;
}

/** The dashboard's data as one script beside the page: no fetch, no network, same bytes every run. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
