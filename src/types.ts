export interface Settings {
  henrikApiKey: string;
  refreshRate: number;
  region: string;
  alwaysOnTop: boolean;
  opacity: number;
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
}

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
};
