export interface Settings {
  henrikApiKey: string;
  refreshRate: number;
  region: string;
  alwaysOnTop: boolean;
  opacity: number;
  soundEnabled: boolean;
  /** When true, Tailwind `dark` class is applied on `<html>`. */
  darkMode?: boolean;
}

export interface PlayerPresence {
  game_name: string;
  game_tag: string;
  puuid: string;
  account_level: number | null;
  session_state: string | null;
  competitive_tier: number | null;
  party_id: string | null;
  rank_icon: string | null;
}

export interface PlayerMatchStats {
  puuid: string;
  kda: number;
  kills: number;
  deaths: number;
  assists: number;
  winRate: number;
  matchesPlayed: number;
  avgACS: number;
  /** 0–100, averaged per-match HS / (HS + body + leg). */
  headshotPct: number;
}

export interface PregamePlayer {
  puuid: string;
  agent_id: string;
  agent_name: string;
  agent_icon: string;
  character_selection_state: string;
  team_id: string;
  game_name: string;
  tag_line: string;
  account_level: number | null;
  competitive_tier: number;
  rank_icon: string | null;
  peak_tier: number;
  peak_rank_icon: string | null;
  peakSeasonShort?: string;
  actWins?: number;
  actLosses?: number;
  actGames?: number;
  rankedRating?: number;
  party_id?: string;
  party_size?: number;
  party_color: string | null;
}

export interface MatchRecord {
  match_id: string;
  map: string;
  date: number;
  won: boolean;
  my_puuid: string;
  my_team: string[];
  enemy_team: string[];
  kills?: number;
  deaths?: number;
  assists?: number;
}

/** Persisted MMR rows in mmr_cache.json (puuid -> entry). */
export type MmrDiskCacheEntry = {
  tier: number;
  tierName: string;
  rr: number;
  peakTier: number;
  peakTierName: string;
  peakSeasonShort?: string;
  actWins?: number;
  actLosses?: number;
  actGames?: number;
  fetchedAt: number;
  /** True when Henrik returned 404 for this player -- cached absence, not missing data. */
  noData?: boolean;
};

export interface MatchHistorySummary {
  count: number;
  lastDate: number;
  lastMap: string;
  lastWon: boolean;
  lastWasTeammate: boolean;
}

export type PendingMatchFlush = {
  matchId: string;
  map: string;
  myTeam: string[];
  enemyTeam: string[];
};

export type MmrEntry = {
  competitive_tier: number;
  peak_tier: number;
  rank_icon: string | null;
  peak_rank_icon: string | null;
  peakSeasonShort?: string;
  actWins?: number;
  actLosses?: number;
  actGames?: number;
};

export type FetchPhase =
  | "idle"
  | "detecting"
  | "loading_players"
  | "loading_ranks"
  | "done";

export interface PersonalStats {
  puuid: string;
  name: string;
  tag: string;
  accountLevel: number;
  currentTier: number;
  currentTierName: string;
  rankingInTier: number;
  peakTier: number;
  peakTierName: string;
  peakSeasonShort?: string;
  actWins: number;
  actLosses: number;
  actMatches: number;
  kda: number;
  headshotPct: number;
  sessionWins: number;
  sessionLosses: number;
  sessionKda: number;
  sessionMatches: number;
  playerCardUrl: string;
}
