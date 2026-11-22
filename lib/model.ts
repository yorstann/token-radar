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
//   implied = TVL x categoryMultiple x momentum x maturity x breadth x ecosystem
//             (x 0.35 when shadow)
//
//   categoryMultiple  the median mcap/TVL of the category's tokenized peers with a positive
//                     market cap, blended toward the global tokenized median in log space.
//                     The blend weight is the peer set's confidence: how many peers priced it
//                     and how tightly their ratios agree (the interquartile range). A category
//                     priced by one peer at the winsorizing cap therefore borrows most of its
//                     multiple from the market instead of shouting down the board. Peer ratios
//                     are winsorized at the peer set's own 90th percentile first: one outlier
//                     whose token trades at 400x its TVL must not price a whole category.
//   momentum          a damped read of the 7-day TVL change, in two parts: the move itself and
//                     the move against the protocol's own category median, each passed through
//                     tanh so a +4,000% print cannot buy the board. The deviation is weighted
//                     by scale reliability — a swing on a $5M base is noisier than the same
//                     swing on a $5B base — and clamped to 0.62–1.55. Unreported: 1.0.
//   maturity          0.86 + 0.34 x (1 - exp(-age_days / 650)): time survived with no token,
//                     with diminishing returns, so year three still counts but year one is
//                     where most of the credit is earned. Unknown listing: 1.0.
//   breadth           a diminishing bonus for chain count (square-root curve, capped at 12).
//   ecosystem         0.98 + 0.05 x chain quality, where a chain's quality is its depth in the
//                     snapshot's priced peer set (tokenized protocols with a positive market
//                     cap), log-normalised: launching where priced peers already live is
//                     worth more than launching somewhere the snapshot cannot price at all.
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
export const PEER_DEPTH_K = 6;
export const MOMENTUM_MIN = 0.62;
export const MOMENTUM_MAX = 1.55;
export const MOMENTUM_ABS_WEIGHT = 0.38;
export const MOMENTUM_REL_WEIGHT = 0.22;
export const MOMENTUM_SCALE_DAYS = 28;
export const MATURITY_BASE = 0.86;
export const MATURITY_SPAN = 0.34;
export const MATURITY_TAU_DAYS = 650;
export const BREADTH_MAX = 0.13;
export const BREADTH_CHAIN_CAP = 12;
export const ECOSYSTEM_BASE = 0.98;
export const ECOSYSTEM_SPAN = 0.05;
export const SHADOW_DISCOUNT = 0.35;
export const MODEL_VERSION = 'radar-peer-3';

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

/** One category's priced peer set: its median ratio and the spread around it. */
export interface CategoryPeers {
  median: number;
  p25: number;
  p75: number;
  peers: number;
}

/** What the tokenized side of the snapshot says one TVL dollar is worth, per category and overall. */
export interface PeerStats {
  /** Median mcap/TVL across every priced peer (positive market cap, positive TVL). */
  global_median: number;
  /** The 90th percentile of all peer ratios: the winsorizing cap applied before any median. */
  ratio_cap: number;
  /** How many tokenized protocols carried a positive market cap and so could price anything. */
  peer_count: number;
  /** Per category: the peer median (of capped ratios), its interquartile range and its depth. */
  by_category: Map<string, CategoryPeers>;
  /** Per chain: how many priced peers record TVL there — the ecosystem's measurable depth. */
  chain_depth: Map<string, number>;
  /** The deepest chain's peer count, the normaliser for chain quality. */
  chain_depth_max: number;
}

/** The q-th quantile of a list of numbers (nearest-rank on a sorted copy). */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/**
 * Peer statistics from the snapshot's tokenized protocols. A peer must carry a positive market
 * cap: a token whose record prices at zero (or not at all) says nothing about what a launch is
 * worth, and letting its 0.0 ratio into a median prices a category on missing data.
 */
export function peerStats(snapshot: Snapshot): PeerStats {
  const raw: { category: string | null; ratio: number; chains: string[] }[] = [];
  for (const p of snapshot.protocols) {
    if (recordsNoToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    raw.push({ category: p.category, ratio: p.mcap_usd / p.tvl_usd, chains: p.chains });
  }
  if (raw.length === 0) {
    return { global_median: 1, ratio_cap: 1, peer_count: 0, by_category: new Map(), chain_depth: new Map(), chain_depth_max: 0 };
  }
  const cap = quantile(raw.map((r) => r.ratio), 0.9);
  const ratios: number[] = [];
  const grouped = new Map<string, number[]>();
  const chain_depth = new Map<string, number>();
  for (const r of raw) {
    const capped = Math.min(r.ratio, cap);
    ratios.push(capped);
    if (r.category !== null) {
      const list = grouped.get(r.category);
      if (list === undefined) grouped.set(r.category, [capped]);
      else list.push(capped);
    }
    for (const chain of r.chains) chain_depth.set(chain, (chain_depth.get(chain) ?? 0) + 1);
  }
  const by_category = new Map<string, CategoryPeers>();
  for (const [category, list] of grouped) {
    by_category.set(category, { median: median(list), p25: quantile(list, 0.25), p75: quantile(list, 0.75), peers: list.length });
  }
  let chain_depth_max = 0;
  for (const depth of chain_depth.values()) chain_depth_max = Math.max(chain_depth_max, depth);
  return { global_median: median(ratios), ratio_cap: cap, peer_count: raw.length, by_category, chain_depth, chain_depth_max };
}

/**
 * How far a category's own peer median may speak before the global median takes over: the
 * product of the set's depth (peers against PEER_DEPTH_K phantom peers) and its agreement
 * (one over one plus the log interquartile spread — a set whose middle half spans 30x agrees
 * about almost nothing, however many peers it holds).
 */
export function peerConfidence(entry: CategoryPeers): number {
  const depth = entry.peers / (entry.peers + PEER_DEPTH_K);
  const spread = Math.log(Math.max(entry.p75, 1e-9) / Math.max(entry.p25, 1e-9));
  const agreement = 1 / (1 + Math.max(0, spread));
  return round4(depth * (0.55 + 0.45 * agreement));
}

/**
 * The multiple one category's TVL earns: its peers' median blended toward the global median in
 * log space with the peer set's confidence as the weight, so a category priced by one name at
 * the cap lands near the market, and a deep, tight category keeps most of its own price.
 */
export function categoryMultiple(
  stats: PeerStats,
  category: string | null,
): { multiple: number; peer_median: number | null; peers: number; peer_p25: number | null; peer_p75: number | null; confidence: number } {
  const entry = category === null ? undefined : stats.by_category.get(category);
  if (entry === undefined || entry.median <= 0) {
    return { multiple: round4(stats.global_median), peer_median: null, peers: 0, peer_p25: null, peer_p75: null, confidence: 0 };
  }
  const confidence = peerConfidence(entry);
  const blended = Math.exp((1 - confidence) * Math.log(stats.global_median) + confidence * Math.log(entry.median));
  return {
    multiple: round4(blended),
    peer_median: round4(entry.median),
    peers: entry.peers,
    peer_p25: round4(entry.p25),
    peer_p75: round4(entry.p75),
    confidence,
  };
}

/**
 * How much a 7-day swing may be trusted at this protocol's size: a move on the snapshot's
 * $5M floor is mostly noise; the same move on a base a thousand times larger is a fact.
 * Log-scaled between the floor and $5B, floored at 0.30 so small protocols still move.
 */
export function scaleReliability(tvlUsd: number): number {
  const t = Math.log10(Math.max(tvlUsd, 5_000_000) / 5_000_000) / 3;
  return round4(0.3 + 0.7 * Math.min(1, Math.max(0, t)));
}

/**
 * Seven-day TVL momentum as a multiplier: the protocol's own move plus its move against its
 * category's median, each tanh-damped so no single print — +4,000% included — can buy the
 * board, the sum weighted by scale reliability and clamped. Silence is neutral.
 */
export function momentumFactor(
  change7d: number | null,
  categoryMedianChange: number | null,
  reliability: number,
): { momentum: number; category_median_change: number | null } {
  if (change7d === null) return { momentum: 1, category_median_change: categoryMedianChange };
  const absolute = Math.tanh(change7d / MOMENTUM_SCALE_DAYS);
  const relative = categoryMedianChange === null ? 0 : Math.tanh((change7d - categoryMedianChange) / MOMENTUM_SCALE_DAYS);
  const deviation = MOMENTUM_ABS_WEIGHT * absolute + MOMENTUM_REL_WEIGHT * relative;
  const momentum = Math.min(MOMENTUM_MAX, Math.max(MOMENTUM_MIN, 1 + reliability * deviation));
  return { momentum: round4(momentum), category_median_change: categoryMedianChange };
}

/** Time survived with no token, as a multiplier with diminishing returns; unknown age is neutral. */
export function maturityFactor(age: number | null): number {
  if (age === null) return 1;
  return round4(MATURITY_BASE + MATURITY_SPAN * (1 - Math.exp(-age / MATURITY_TAU_DAYS)));
}

/** Chain breadth as a multiplier: a square-root curve over chain count, capped at twelve. */
export function breadthFactor(chainCount: number): number {
  const n = Math.min(Math.max(chainCount, 1), BREADTH_CHAIN_CAP);
  return round4(1 + BREADTH_MAX * ((Math.sqrt(n) - 1) / (Math.sqrt(BREADTH_CHAIN_CAP) - 1)));
}

/**
 * A chain's quality: its depth in the priced peer set, log-normalised against the deepest
 * chain. A protocol's ecosystem factor reads its three deepest chains (weighted 0.5/0.3/0.2):
 * where priced peers already record TVL is where a launch's market already exists.
 */
export function ecosystemFactor(chains: string[], stats: PeerStats): { ecosystem: number; chain_quality: number } {
  if (stats.chain_depth_max <= 0 || chains.length === 0) return { ecosystem: ECOSYSTEM_BASE, chain_quality: 0 };
  const qualities = chains
    .map((c) => Math.log1p(stats.chain_depth.get(c) ?? 0) / Math.log1p(stats.chain_depth_max))
    .sort((a, b) => b - a);
  const weights = [0.5, 0.3, 0.2];
  let quality = 0;
  let used = 0;
  for (let i = 0; i < Math.min(3, qualities.length); i++) {
    quality += weights[i]! * qualities[i]!;
    used += weights[i]!;
  }
  quality = used > 0 ? quality / used : 0;
  return { ecosystem: round4(ECOSYSTEM_BASE + ECOSYSTEM_SPAN * quality), chain_quality: round4(quality) };
}

/** The full scoring of one protocol: every component, so the dashboard can show the work. */
export interface Scored {
  implied_value_usd: number;
  category_multiple: number;
  peer_median: number | null;
  peer_count: number;
  peer_p25: number | null;
  peer_p75: number | null;
  peer_confidence: number;
  momentum: number;
  momentum_reliability: number;
  category_median_change: number | null;
  maturity: number;
  breadth: number;
  ecosystem: number;
  chain_quality: number;
  shadow: boolean;
  age_days: number | null;
}

/** impliedValue(): what a token would be worth if this protocol's record stayed as it is. */
export function impliedValue(p: SnapshotProtocol, stats: PeerStats, asOf: string, categoryMedianChange: number | null): Scored {
  const age = ageDays(asOf, p.listed_at);
  const multiple = categoryMultiple(stats, p.category);
  const reliability = scaleReliability(p.tvl_usd);
  const mom = momentumFactor(p.change_7d, categoryMedianChange, reliability);
  const maturity = maturityFactor(age);
  const breadth = breadthFactor(p.chains.length);
  const eco = ecosystemFactor(p.chains, stats);
  const shadow = isShadow(p);
  const raw = p.tvl_usd * multiple.multiple * mom.momentum * maturity * breadth * eco.ecosystem * (shadow ? SHADOW_DISCOUNT : 1);
  return {
    implied_value_usd: Math.max(1, Math.round(raw)),
    category_multiple: multiple.multiple,
    peer_median: multiple.peer_median,
    peer_count: multiple.peers,
    peer_p25: multiple.peer_p25,
    peer_p75: multiple.peer_p75,
    peer_confidence: multiple.confidence,
    momentum: mom.momentum,
    momentum_reliability: reliability,
    category_median_change: mom.category_median_change,
    maturity,
    breadth,
    ecosystem: eco.ecosystem,
    chain_quality: eco.chain_quality,
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

/**
 * The risk step, worded from the protocol's own 7-day print: a falling TVL halves the entry, a
 * vertical one phases it, and a missing one buys two checks before any money moves. Calm prints
 * (between -15% and +20%) earn no extra step — the plan stays five steps long.
 */
function riskStep(p: SnapshotProtocol, c: FarmContext): string | null {
  const change = p.change_7d;
  if (change === null) {
    return `Because no 7-day TVL change is reported for ${c.name}, verify its TVL on the protocol's own app on two separate days before funding the position, and start at the low end of the band ($${c.lo}) until the two readings agree. An unreported print is a reason to look twice, not to skip the farm.`;
  }
  if (change <= -15) {
    return `Size down first: ${c.name}'s TVL fell ${Math.abs(change).toFixed(1)}% in seven days, so open with half the band ($${Math.max(25, Math.floor(c.lo / 2))}–$${Math.floor(c.hi / 2)}) and add the rest only after a week in which the TVL stops falling. Farming a shrinking protocol at full size pays full gas for a shrinking share.`;
  }
  if (change >= 20) {
    return `Do not chase the spike: ${c.name}'s TVL rose ${change.toFixed(1)}% in seven days, so phase the position in two tranches a week apart — half now, half only if the TVL holds above today's level. A vertical week is when mercenary capital arrives; arriving in two steps keeps you from being its exit liquidity.`;
  }
  return null;
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
  const steps = [setupStep(ctx), coreStep(family, ctx), secondStep(family, ctx)];
  const risk = riskStep(p, ctx);
  if (risk !== null) steps.push(risk);
  steps.push(holdStep(ctx));
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
    peer_p25: number | null;
    peer_p75: number | null;
    peer_confidence: number;
    momentum: number;
    momentum_reliability: number;
    category_median_change: number | null;
    maturity: number;
    breadth: number;
    ecosystem: number;
    chain_quality: number;
    shadow_discount: number;
  };
  farm_steps: string[];
}

/** The dashboard's copy of a row: everything the page renders, nothing it does not. */
export interface DashRow extends BoardRow {
  ratio: number;
  farm_cost: string;
  farm_time: string;
  /** The TVL seven days before the snapshot, derived from change_7d; null when unreported or degenerate. */
  tvl_7d_ago_usd: number | null;
  /**
   * A 0–100 context score for the detail view: where this row sits in the board's own
   * distribution of value/TVL, 7-day change, age, TVL and peer confidence. It never moves a
   * rank — rank is implied value alone — it only helps a reader see a row's shape at a glance.
   */
  signal_score: number;
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
    /** Tokenized protocols with a positive market cap: the set every multiple is priced from. */
    peer_comps: number;
  };
  categories: string[];
  chains: string[];
  rows: DashRow[];
}

/**
 * The median 7-day change of the pre-token protocols in each category (the crowd a protocol's
 * own move is read against), with the board-wide median standing in for any category holding
 * fewer than three reported changes — a median of two is an anecdote.
 */
export function categoryMedianChanges(snapshot: Snapshot): Map<string, number> {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (!recordsNoToken(p) || p.change_7d === null) continue;
    all.push(p.change_7d);
    if (p.category !== null) {
      const list = byCategory.get(p.category);
      if (list === undefined) byCategory.set(p.category, [p.change_7d]);
      else list.push(p.change_7d);
    }
  }
  const globalMedian = all.length > 0 ? median(all) : 0;
  const result = new Map<string, number>();
  for (const [category, list] of byCategory) {
    result.set(category, list.length >= 3 ? median(list) : globalMedian);
  }
  return result;
}

/** Rank every protocol that records no token, best implied value first, slug breaking ties. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const stats = peerStats(snapshot);
  const medChanges = categoryMedianChanges(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(recordsNoToken)
    .map((p) => ({ p, s: impliedValue(p, stats, snapshot.as_of, p.category === null ? null : (medChanges.get(p.category) ?? null)) }));
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
      peer_p25: s.peer_p25,
      peer_p75: s.peer_p75,
      peer_confidence: s.peer_confidence,
      momentum: s.momentum,
      momentum_reliability: s.momentum_reliability,
      category_median_change: s.category_median_change,
      maturity: s.maturity,
      breadth: s.breadth,
      ecosystem: s.ecosystem,
      chain_quality: s.chain_quality,
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
  // Percentile of a value inside the board's own distribution (ties split), for the signal
  // score: a row is only ever compared with the other rows this snapshot produced.
  const pctOf = (sortedAsc: number[], v: number): number => {
    let lo = 0;
    let hi = 0;
    for (const x of sortedAsc) {
      if (x < v) lo++;
      if (x <= v) hi++;
    }
    return sortedAsc.length === 0 ? 0.5 : (lo + hi) / 2 / sortedAsc.length;
  };
  const by = (f: (r: BoardRow) => number): number[] => board.map(f).sort((a, b) => a - b);
  const reportedChanges = board.map((r) => r.change_7d).filter((c): c is number => c !== null);
  const medianChange = reportedChanges.length > 0 ? median(reportedChanges) : 0;
  const logRatios = by((r) => Math.log(r.implied_value_usd / r.tvl_usd));
  const changes = by((r) => r.change_7d ?? medianChange);
  const ages = by((r) => r.age_days ?? -1);
  const logTvls = by((r) => Math.log(r.tvl_usd));
  const rows: DashRow[] = board.map((row) => {
    const proto = snapshot.protocols.find((p) => p.slug === row.slug)!;
    const summary = farmSummary(proto, row.age_days);
    const signal = Math.round(
      100 *
        (0.34 * pctOf(logRatios, Math.log(row.implied_value_usd / row.tvl_usd)) +
          0.24 * pctOf(changes, row.change_7d ?? medianChange) +
          0.18 * pctOf(ages, row.age_days ?? -1) +
          0.14 * pctOf(logTvls, Math.log(row.tvl_usd)) +
          0.1 * row.model.peer_confidence),
    );
    return {
      ...row,
      ratio: Math.round((row.implied_value_usd / row.tvl_usd) * 1000) / 1000,
      farm_cost: summary.cost,
      farm_time: summary.time,
      tvl_7d_ago_usd:
        row.change_7d === null || row.change_7d <= -100 ? null : Math.round(row.tvl_usd / (1 + row.change_7d / 100)),
      signal_score: signal,
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
      peer_comps: stats.peer_count,
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
