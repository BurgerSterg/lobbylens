import { invoke } from "@tauri-apps/api/core";
import { henrikFetch } from "../api/henrik";
import type { MatchHistorySummary, MatchRecord, PendingMatchFlush } from "../types";

export type { MatchHistorySummary, MatchRecord, PendingMatchFlush };

let cachedHistory: MatchRecord[] | null = null;

export async function loadHistory(): Promise<MatchRecord[]> {
  if (cachedHistory) return cachedHistory;
  cachedHistory = await invoke<MatchRecord[]>("load_match_history");
  return cachedHistory;
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
  const pageSize = 20;

  while (true) {
    const res = await henrikFetch(
      `https://api.henrikdev.xyz/valorant/v3/by-puuid/matches/${region}/pc/${puuid}?size=${pageSize}&page=${page}`,
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
    const res = await henrikFetch(
      `https://api.henrikdev.xyz/valorant/v3/by-puuid/matches/${region}/pc/${myPuuid}?size=1`,
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
          history.unshift({
            match_id: pending.matchId,
            map: pending.map,
            date: Math.floor(Date.now() / 1000),
            won,
            my_puuid: myPuuid,
            my_team: pending.myTeam,
            enemy_team: pending.enemyTeam,
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
