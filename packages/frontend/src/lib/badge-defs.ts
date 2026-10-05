/**
 * badge-defs.ts
 *
 * Frontend mirror of the backend `badge-definitions.ts`. Defines the catalogue
 * of achievement badges plus pure helpers for computing locked/unlocked state
 * and progress, so the gallery UI stays declarative and testable.
 */

export type BadgeRarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  /** Emoji glyph rendered on the badge face. */
  icon: string;
  rarity: BadgeRarity;
  /** Target value of the tracked metric required to unlock. */
  threshold: number;
  /** Human label for the tracked metric (e.g. "calls resolved"). */
  metric: string;
}

export interface BadgeState {
  definition: BadgeDefinition;
  current: number;
  unlocked: boolean;
  /** 0–100 completion percentage toward the threshold. */
  percent: number;
  remaining: number;
}

/** Display order / weight for rarities (higher = rarer). */
export const RARITY_ORDER: Record<BadgeRarity, number> = {
  common: 0,
  rare: 1,
  epic: 2,
  legendary: 3,
};

/** Tailwind accent classes per rarity, used for borders/badges. */
export const RARITY_STYLES: Record<BadgeRarity, { ring: string; label: string }> = {
  common: { ring: 'ring-zinc-400', label: 'bg-zinc-500/15 text-zinc-300' },
  rare: { ring: 'ring-sky-400', label: 'bg-sky-500/15 text-sky-300' },
  epic: { ring: 'ring-violet-400', label: 'bg-violet-500/15 text-violet-300' },
  legendary: {
    ring: 'ring-amber-400',
    label: 'bg-amber-500/15 text-amber-300',
  },
};

export const BADGE_DEFINITIONS: BadgeDefinition[] = [
  {
    id: 'first-call',
    name: 'First Call',
    description: 'Create your very first on-chain call.',
    icon: '🎯',
    rarity: 'common',
    threshold: 1,
    metric: 'calls created',
  },
  {
    id: 'sharp-shooter',
    name: 'Sharp Shooter',
    description: 'Resolve 10 calls with a winning outcome.',
    icon: '🏹',
    rarity: 'rare',
    threshold: 10,
    metric: 'winning calls',
  },
  {
    id: 'whale-staker',
    name: 'Whale Staker',
    description: 'Stake a cumulative 10,000 USDC across calls.',
    icon: '🐋',
    rarity: 'epic',
    threshold: 10_000,
    metric: 'USDC staked',
  },
  {
    id: 'oracle',
    name: 'The Oracle',
    description: 'Reach a 90+ reputation accuracy score.',
    icon: '🔮',
    rarity: 'legendary',
    threshold: 90,
    metric: 'accuracy score',
  },
  {
    id: 'streak-master',
    name: 'Streak Master',
    description: 'Hit a 5-call winning streak.',
    icon: '🔥',
    rarity: 'rare',
    threshold: 5,
    metric: 'win streak',
  },
  {
    id: 'community-pillar',
    name: 'Community Pillar',
    description: 'Earn 100 followers on your profile.',
    icon: '🏛️',
    rarity: 'epic',
    threshold: 100,
    metric: 'followers',
  },
  {
    id: 'early-adopter',
    name: 'Early Adopter',
    description: 'Join the first 100 active participants.',
    icon: '🌱',
    rarity: 'common',
    threshold: 1,
    metric: 'early calls',
  },
  {
    id: 'diversifier',
    name: 'Diversifier',
    description: 'Back calls across five market categories.',
    icon: '🧭',
    rarity: 'rare',
    threshold: 5,
    metric: 'categories',
  },
  {
    id: 'volume-scout',
    name: 'Volume Scout',
    description: 'Generate 1,000 USDC in market volume.',
    icon: '📈',
    rarity: 'rare',
    threshold: 1_000,
    metric: 'USDC volume',
  },
  {
    id: 'high-conviction',
    name: 'High Conviction',
    description: 'Average 100 USDC per resolved position.',
    icon: '🛡️',
    rarity: 'epic',
    threshold: 100,
    metric: 'average stake',
  },
  {
    id: 'comeback-kid',
    name: 'Comeback Kid',
    description: 'Recover from five losing calls in a row.',
    icon: '🔄',
    rarity: 'rare',
    threshold: 5,
    metric: 'loss recovery streak',
  },
  {
    id: 'perfect-week',
    name: 'Perfect Week',
    description: 'Finish seven resolved calls with a perfect record.',
    icon: '📅',
    rarity: 'epic',
    threshold: 7,
    metric: 'perfect week',
  },
  {
    id: 'market-maker',
    name: 'Market Maker',
    description: 'Provide liquidity on 25 active markets.',
    icon: '🏗️',
    rarity: 'legendary',
    threshold: 25,
    metric: 'markets provided',
  },
  {
    id: 'social-proof',
    name: 'Social Proof',
    description: 'Earn 50 endorsements from other predictors.',
    icon: '🤝',
    rarity: 'rare',
    threshold: 50,
    metric: 'endorsements',
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    description: 'Resolve five calls after midnight UTC.',
    icon: '🦉',
    rarity: 'common',
    threshold: 5,
    metric: 'late resolutions',
  },
  {
    id: 'global-perspective',
    name: 'Global Perspective',
    description: 'Back calls from five different market regions.',
    icon: '🌍',
    rarity: 'epic',
    threshold: 5,
    metric: 'regions',
  },
  {
    id: 'risk-manager',
    name: 'Risk Manager',
    description: 'Keep your largest position below 25% of volume.',
    icon: '📉',
    rarity: 'rare',
    threshold: 25,
    metric: 'max position percent',
  },
  {
    id: 'oracle-ear',
    name: 'Oracle Ear',
    description: 'Correctly call five market resolutions before settlement.',
    icon: '👂',
    rarity: 'legendary',
    threshold: 5,
    metric: 'early resolutions',
  },
  {
    id: 'community-builder',
    name: 'Community Builder',
    description: 'Welcome 10 new followers who become active stakers.',
    icon: '🌟',
    rarity: 'epic',
    threshold: 10,
    metric: 'active followers',
  },
];

/** Clamp helper kept local to avoid a cross-tree import. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Compute a badge's locked/unlocked state and progress from the user's current
 * metric value. Pure and side-effect free for straightforward unit testing.
 */
export function computeBadgeState(
  definition: BadgeDefinition,
  current: number,
): BadgeState {
  const safeCurrent = Number.isFinite(current) ? Math.max(current, 0) : 0;
  const percent =
    definition.threshold <= 0
      ? 100
      : clamp(Math.round((safeCurrent / definition.threshold) * 100), 0, 100);
  const unlocked = safeCurrent >= definition.threshold;
  return {
    definition,
    current: safeCurrent,
    unlocked,
    percent,
    remaining: Math.max(definition.threshold - safeCurrent, 0),
  };
}

/**
 * Build badge states for every definition, optionally filtered by rarity and
 * sorted with rarest-first, unlocked-first.
 */
export function buildBadgeStates(
  progress: Record<string, number>,
  rarityFilter?: BadgeRarity | 'all',
): BadgeState[] {
  return BADGE_DEFINITIONS.filter(
    (def) => !rarityFilter || rarityFilter === 'all' || def.rarity === rarityFilter,
  )
    .map((def) => computeBadgeState(def, progress[def.id] ?? 0))
    .sort((a, b) => {
      if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
      return (
        RARITY_ORDER[b.definition.rarity] - RARITY_ORDER[a.definition.rarity]
      );
    });
}
