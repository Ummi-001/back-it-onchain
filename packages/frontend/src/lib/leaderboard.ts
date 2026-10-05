export type LeaderboardPeriod = '24h' | '7d' | '30d' | 'all';

export interface LeaderboardEntry {
  rank?: number;
  userId: string;
  username?: string;
  winRate: number;
  profit: number;
  activity: number;
  brierScore?: number;
  stakeVolume?: number;
  category?: string;
  chain?: 'base' | 'stellar';
  avatar?: string;
  followed?: boolean;
  score?: number;
}

export function brierScore(entries: Array<{ probability: number; outcome: 'won' | 'lost' }>): number {
  if (entries.length === 0) return 0.5;
  return entries.reduce((total, entry) => total + Math.pow(Math.min(1, Math.max(0, entry.probability)) - (entry.outcome === 'won' ? 1 : 0), 2), 0) / entries.length;
}

export function leaderboardScore(entry: LeaderboardEntry, population: LeaderboardEntry[]): number {
  const maxProfit = Math.max(1, ...population.map((item) => Math.abs(item.profit)));
  const maxVolume = Math.max(1, ...population.map((item) => item.stakeVolume || 0));
  const accuracy = Math.min(100, Math.max(0, entry.winRate));
  const calibration = (1 - (entry.brierScore ?? 0.5)) * 100;
  const profit = (Math.max(0, entry.profit) / maxProfit) * 100;
  const volume = ((entry.stakeVolume || 0) / maxVolume) * 100;
  return accuracy * 0.35 + calibration * 0.3 + profit * 0.25 + volume * 0.1;
}

export function rankLeaderboard(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return entries.map((entry) => ({ ...entry, score: leaderboardScore(entry, entries) })).sort((a, b) => (b.score || 0) - (a.score || 0)).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export type LeaderboardSort = 'rank' | 'profit' | 'winRate' | 'brierScore' | 'activity';

export function sortLeaderboard(entries: LeaderboardEntry[], sort: LeaderboardSort, direction: 'asc' | 'desc' = 'desc'): LeaderboardEntry[] {
  const factor = direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const left = sort === 'brierScore' ? (a.brierScore ?? 0.5) : sort === 'rank' ? (a.rank || 0) : a[sort];
    const right = sort === 'brierScore' ? (b.brierScore ?? 0.5) : sort === 'rank' ? (b.rank || 0) : b[sort];
    return (Number(left) - Number(right)) * factor;
  });
}
