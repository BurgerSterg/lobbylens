import { invoke } from "@tauri-apps/api/core";
import { henrikFetch, henrikMatchHistoryShard } from "../api/henrik";
import type { MatchHistorySummary, MatchRecord, PendingMatchFlush } from "../types";

export type { MatchHistorySummary, MatchRecord, PendingMatchFlush };

let cachedHistory: MatchRecord[] | null = null;

export async function loadHistory(): Promise<MatchRecord[]> {
  if (cachedHistory) return cachedHistory;
  try {
    const raw = await invoke<MatchRecord[]>("load_match_history");
    if (!Array.isArray(raw)) {
      cachedHistory = [];
      return [];
    }
    cachedHistory = raw;
    return raw;
  } catch {
    cachedHistory = [];
    return [];
  }
}

/** Stats vs another player (all stored history rows where they appear on either side). */
export async function getMatchStatsAgainstPlayer(
  puuid: string,
): Promise<{ timesMatched: number; timesEnemy: number; timesTeammate: number }> {
  const history = await loadHistory();
  let timesEnemy = 0;
  let timesTeammate = 0;
  for (const m of history) {
    if (!m.my_team.includes(puuid) && !m.enemy_team.includes(puuid)) continue;
    if (m.my_team.includes(puuid)) timesTeammate++;
    else timesEnemy++;
  }
  return {
    timesMatched: timesTeammate + timesEnemy,
    timesEnemy,
    timesTeammate,
  };
}

/** Scoped to a single account (your `myPuuid`) for UI when you know the local player. */
export function getMatchStatsAgainstPlayerFromHistory(
  history: ReadonlyArray<MatchRecord>,
  myPuuid: string,
  opponentPuuid: string,
): { timesMatched: number; timesEnemy: number; timesTeammate: number } {
  let timesEnemy = 0;
  let timesTeammate = 0;
  for (const m of history) {
    if (m.my_puuid !== myPuuid) continue;
    if (!m.my_team.includes(opponentPuuid) && !m.enemy_team.includes(opponentPuuid)) continue;
    if (m.my_team.includes(opponentPuuid)) timesTeammate++;
    else timesEnemy++;
  }
  return {
    timesMatched: timesTeammate + timesEnemy,
    timesEnemy,
    timesTeammate,
  };
}

export async function saveHistory(records: MatchRecord[]): Promise<void> {
  cachedHistory = records;
  await invoke("save_match_history", { records });
}

export async function backfillMatchHistory(
  puuid: string,
  region: string,
  henrikApiKey: string,
): Promise<MatchRecord[]> {
  const records: MatchRecord[] = [];
  let page = 1;
  const pageSize = 10;

  const shard = henrikMatchHistoryShard(region);
  while (true) {
    const res = await henrikFetch(
      `https://api.henrikdev.xyz/valorant/v3/by-puuid/matches/${shard}/pc/${puuid}?size=${pageSize}&page=${page}`,
      henrikApiKey,
    );
    if (!res.ok) break;
    const data = await res.json();
    const matches = data?.data;
    if (!matches || matches.length === 0) break;

    for (const m of matches) {
      const matchId: string = m.metadata?.matchid ?? "";
      const map: string = m.metadata?.map ?? "";
      const date: number = m.metadata?.game_start ?? 0;
      const players: any[] = m.players?.all_players ?? [];
      const me = players.find((p: any) => p.puuid === puuid);
      if (!me) continue;
      const myTeamId: string = me.team?.toLowerCase() ?? "";
      const won: boolean =
        (m.teams?.red?.has_won === true && myTeamId === "red") ||
        (m.teams?.blue?.has_won === true && myTeamId === "blue");
      const myTeam = players
        .filter((p: any) => p.team?.toLowerCase() === myTeamId)
        .map((p: any) => p.puuid as string);
      const enemyTeam = players
        .filter((p: any) => p.team?.toLowerCase() !== myTeamId)
        .map((p: any) => p.puuid as string);

      records.push({
        match_id: matchId,
        map,
        date,
        won,
        my_puuid: puuid,
        my_team: myTeam,
        enemy_team: enemyTeam,
      });
    }

    if (matches.length < pageSize) break;
    page++;
  }

  await saveHistory(records);
  return records;
}

/** Append the current match to local history once Henrik has the match payload (post-game). */
export async function flushPendingMatchToHistory(
  pending: PendingMatchFlush | null,
  myPuuid: string,
  region: string,
  henrikApiKey: string,
): Promise<void> {
  if (!pending || !myPuuid) return;
  try {
    const shard = henrikMatchHistoryShard(region);
    const res = await henrikFetch(
      `https://api.henrikdev.xyz/valorant/v3/by-puuid/matches/${shard}/pc/${myPuuid}?size=1`,
      henrikApiKey,
    );
    if (res.ok) {
      const data = await res.json();
      const m = data?.data?.[0];
      const fetchedMatchId: string = m?.metadata?.matchid ?? "";
      if (fetchedMatchId === pending.matchId) {
        const allPlayers: any[] = m?.players?.all_players ?? [];
        const mePl = allPlayers.find((p: any) => p.puuid === myPuuid);
        const myTeamId: string = mePl?.team?.toLowerCase() ?? "";
        const won: boolean =
          (m?.teams?.red?.has_won === true && myTeamId === "red") ||
          (m?.teams?.blue?.has_won === true && myTeamId === "blue");
        const history = await loadHistory();
        if (!history.find((r) => r.match_id === pending.matchId)) {
          const stats = mePl?.stats ?? mePl;
          const k = stats?.kills;
          const d = stats?.deaths;
          const a = stats?.assists;
          const kda: { kills?: number; deaths?: number; assists?: number } = {};
          if (k != null && Number.isFinite(Number(k))) kda.kills = Number(k);
          if (d != null && Number.isFinite(Number(d))) kda.deaths = Number(d);
          if (a != null && Number.isFinite(Number(a))) kda.assists = Number(a);

          history.unshift({
            match_id: pending.matchId,
            map: pending.map,
            date: Math.floor(Date.now() / 1000),
            won,
            my_puuid: myPuuid,
            my_team: pending.myTeam,
            enemy_team: pending.enemyTeam,
            ...kda,
          });
          await saveHistory(history);
        }
      }
    }
  } catch {}
}

export function summarizePlayer(
  puuid: string,
  myPuuid: string,
  history: MatchRecord[],
): MatchHistorySummary | null {
  const matches = history
    .filter((m) => m.my_puuid === myPuuid)
    .filter((m) => m.my_team.includes(puuid) || m.enemy_team.includes(puuid))
    .sort((a, b) => b.date - a.date);

  if (matches.length === 0) return null;

  const last = matches[0];
  return {
    count: matches.length,
    lastDate: last.date,
    lastMap: last.map,
    lastWon: last.won,
    lastWasTeammate: last.my_team.includes(puuid),
  };
}
