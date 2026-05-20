import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FetchPhase, MmrEntry, PersonalStats, PlayerMatchStats, PlayerPresence, PregamePlayer, Settings } from "../types";
import {
  backfillMatchHistory,
  flushPendingMatchToHistory,
  loadHistory,
  summarizePlayer,
} from "./useMatchHistory";
import {
  cachedMMR,
  fetchHenrikAccountLevel,
  fetchHenrikMmrForPlayer,
  fetchPersonalStats,
  fetchPlayerRecentStats,
  identityAccountLevelValue,
  initMmrDiskCache,
  mergeIncognitoNamesFromHenrik,
  resetHenrikLobbyCaches,
  resolvedAccountLevels,
} from "../api/henrik";
import { playLobbyLoadedChime } from "../utils/sound";
import {
  getAuthTokens,
  getCoregameMatchExternal,
  getCoregameMatchIdExternal,
  getLocalPlayer,
  getPartyMembers,
  getPlayerNames,
  getPregameMatchExternal,
  getPregameMatchIdExternal,
  getPresences,
} from "../api/riot";

const MAP_NAMES: Record<string, string> = {
  "/Game/Maps/Ascent/Ascent": "Ascent",
  "/Game/Maps/Bonsai/Bonsai": "Split",
  "/Game/Maps/Canyon/Canyon": "Fracture",
  "/Game/Maps/Duality/Duality": "Bind",
  "/Game/Maps/Foxtrot/Foxtrot": "Breeze",
  "/Game/Maps/HURM/HURM_Alley/HURM_Alley": "Pearl",
  "/Game/Maps/HURM/HURM_Bogota/HURM_Bogota": "Pearl",
  "/Game/Maps/HURM/HURM_Bowl/HURM_Bowl": "Lotus",
  "/Game/Maps/HURM/HURM_Helix/HURM_Helix": "Sunset",
  "/Game/Maps/HURM/HURM_Yard/HURM_Yard": "Abyss",
  "/Game/Maps/Jam/Jam": "Sunset",
  "/Game/Maps/Juliett/Juliett": "Abyss",
  "/Game/Maps/Korea/Korea": "Icebox",
  "/Game/Maps/Lotus/Lotus": "Lotus",
  "/Game/Maps/Pitt/Pitt": "Pearl",
  "/Game/Maps/Port/Port": "Icebox",
  "/Game/Maps/Triad/Triad": "Haven",
};

export function getMapName(mapId: string): string {
  return MAP_NAMES[mapId] ?? mapId.split("/").pop() ?? "Unknown";
}

function parseGamePod(gamePodId: string): string {
  if (!gamePodId) return "";
  const parts = gamePodId.split("-");
  if (parts.length < 2) return gamePodId;
  const location = parts.slice(-2).join(" ");
  return location.replace(/(\d+)$/, " $1").trim()
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** First occurrence wins — match payloads can list the same Subject twice. */
function dedupePlayersBySubject(players: any[] | undefined): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const p of players ?? []) {
    const id = p?.Subject as string | undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}

let cachedAgentMap: Record<string, { name: string; icon: string }> | null = null;

async function fetchAgentMap(): Promise<Record<string, { name: string; icon: string }>> {
  if (cachedAgentMap) return cachedAgentMap;
  const res = await fetch("https://valorant-api.com/v1/agents?isPlayableCharacter=true");
  const data = await res.json();
  const map: Record<string, { name: string; icon: string }> = {};
  for (const agent of data.data) {
    map[agent.uuid.toLowerCase()] = {
      name: agent.displayName,
      icon: agent.displayIconSmall,
    };
  }
  cachedAgentMap = map;
  return map;
}

let cachedRankMap: Record<number, string> | null = null;

async function fetchRankMap(): Promise<Record<number, string>> {
  if (cachedRankMap) return cachedRankMap;
  const res = await fetch("https://valorant-api.com/v1/competitivetiers");
  const data = await res.json();
  const map: Record<number, string> = {};
  const latest = data.data[data.data.length - 1];
  for (const tier of latest.tiers) {
    map[tier.tier] = tier.smallIcon ?? tier.largeIcon ?? "";
  }
  cachedRankMap = map;
  return map;
}

export type { PlayerPresence, PregamePlayer } from "../types";

/** Merged from every presences poll — Riot adds more players over time; partyId enables stranger party detection. */
let accumulatedPartyIdsByPuuid: Record<string, string> = {};

/** partyId -> member PUUIDs from get_party_members (full roster per party). */
const knownPartyMembers: Record<string, string[]> = {};

function mergePartyIdsFromPresences(
  presences: ReadonlyArray<{ puuid: string; party_id: string | null }>,
) {
  for (const p of presences) {
    if (p.party_id) accumulatedPartyIdsByPuuid[p.puuid] = p.party_id;
  }
}

/** Riot/local invoke failed on the wire — retry next poll; not logical "not in match" outcomes. */
function isSilentTransportError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
  const m = msg.toLowerCase();
  if (msg.includes("Not in coregame") || msg.includes("Not in pregame")) return false;
  if (/\b400\b/.test(msg) || /\b404\b/.test(msg)) return false;
  if (msg.startsWith("Request failed:")) return true;
  return (
    m.includes("connection refused") ||
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("unreachable") ||
    m.includes("econnrefused") ||
    m.includes("failed to connect") ||
    m.includes("connection reset") ||
    m.includes("broken pipe") ||
    m.includes("network error") ||
    m.includes("error sending request") ||
    m.includes("dns error") ||
    m.includes("ws error") ||
    m.includes("io error")
  );
}

export type PlayerRow = PregamePlayer;

function partitionBlueRed(players: PlayerRow[]): { blue: PlayerRow[]; red: PlayerRow[] } {
  const ids = [...new Set(players.map((p) => p.team_id).filter(Boolean))].sort();
  if (ids.length >= 2) {
    const blueId = ids[0]!;
    const redId = ids[1]!;
    return {
      blue: players.filter((p) => p.team_id === blueId),
      red: players.filter((p) => p.team_id === redId),
    };
  }
  return {
    blue: players.filter((p) => p.team_id === "Blue" || p.team_id === "ally"),
    red: players.filter((p) => p.team_id === "Red" || p.team_id === "enemy"),
  };
}

/** Competitive tier id → 0..1 (unranked 0; Iron 1 → 1/25 … Radiant → 1). */
function tierToNorm(competitiveTier: number): number {
  if (!competitiveTier || competitiveTier < 3) return 0;
  const slot = Math.min(Math.max(competitiveTier - 2, 1), 25);
  return slot / 25;
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function teamComposite(team: PlayerRow[]): number {
  // Win rate from act record (MMR data -- available for all ranked players)
  const winRates = team
    .map((p) => {
      const total = (p.actWins ?? 0) + (p.actLosses ?? 0);
      if (total < 3) return null; // ignore players with too few games
      return (p.actWins ?? 0) / total;
    })
    .filter((x): x is number => x !== null && Number.isFinite(x));

  // Games played this act -- more games = more reliable data, slight bonus
  const gamesNorms = team
    .map((p) => {
      const g = p.actGames ?? 0;
      return Math.min(g / 60, 1); // normalize: 60+ games = max
    });

  // Current rank normalized
  const ranks = team.map((p) => tierToNorm(p.competitive_tier));

  // Peak rank normalized
  const peaks = team.map((p) => tierToNorm(p.peak_tier));

  // 40% current rank, 30% act win rate, 20% peak rank, 10% games played
  return (
    0.40 * average(ranks) +
    0.30 * average(winRates.length > 0 ? winRates : ranks.map(() => 0.5)) +
    0.20 * average(peaks) +
    0.10 * average(gamesNorms)
  );
}

export function calculateWinProbability(
  players: PlayerRow[],
): { blueWinPct: number; redWinPct: number; confidence: "low" | "medium" | "high" } {
  const { blue, red } = partitionBlueRed(players);
  const blueScore = teamComposite(blue);
  const redScore = teamComposite(red);
  const sum = blueScore + redScore;
  let blueWinPct = sum > 0 ? (blueScore / sum) * 100 : 50;
  let redWinPct = sum > 0 ? (redScore / sum) * 100 : 50;
  const totalPct = blueWinPct + redWinPct;
  if (totalPct > 0) {
    blueWinPct = (blueWinPct / totalPct) * 100;
    redWinPct = (redWinPct / totalPct) * 100;
  }

  const withActData = players.filter(
    (p) => (p.actWins !== undefined || p.actLosses !== undefined) &&
           (p.competitive_tier ?? 0) > 0,
  ).length;
  let confidence: "low" | "medium" | "high";
  if (withActData < 6) confidence = "low";
  else if (withActData <= 8) confidence = "medium";
  else confidence = "high";

  return { blueWinPct, redWinPct, confidence };
}

export function useLobby(settings: Settings) {
  const [players, setPlayers] = useState<PlayerPresence[]>([]);
  const [pregamePlayers, setPregamePlayers] = useState<PregamePlayer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapName, setMapName] = useState<string>("");
  const [serverName, setServerName] = useState<string>("");
  const [localPuuid, setLocalPuuid] = useState<string>("");
  const [fetchPhase, setFetchPhase] = useState<FetchPhase>("idle");
  const [mmrProgress, setMmrProgress] = useState<{ fetched: number; total: number }>({ fetched: 0, total: 0 });
  const [matchState, setMatchState] = useState<"MENUS" | "PREGAME" | "INGAME" | null>(null);
  const [playerStats, setPlayerStats] = useState<Record<string, PlayerMatchStats>>({});
  const [playerStatLoading, setPlayerStatLoading] = useState<Record<string, boolean>>({});
  const [personalStats, setPersonalStats] = useState<PersonalStats | null>(null);
  const [personalStatsLoading, setPersonalStatsLoading] = useState(false);
  const [pregameMatchIdForUi, setPregameMatchIdForUi] = useState<string | null>(null);

  const isFetchingRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingMatchRef = useRef<{
    matchId: string;
    map: string;
    myTeam: string[];
    enemyTeam: string[];
  } | null>(null);
  const statsMatchIdRef = useRef<string | null>(null);
  const statsKickStartedRef = useRef<string | null>(null);
  const consecutiveConnectionFailuresRef = useRef(0);
  const playedLobbyLoadedChimeForMatchRef = useRef<string | null>(null);
  const hasAutoFocusedForMatchRef = useRef<string | null>(null);
  const sessionWinsRef = useRef(0);
  const sessionLossesRef = useRef(0);
  const sessionMatchesRef = useRef(0);
  const sessionKdaAccumulatorRef = useRef<number[]>([]);
  /** Dedupe key for personal Henrik fetch: puuid + region + API key. */
  const personalStatsFetchedForPuuidRef = useRef("");

  function overlayPersonalSession(base: PersonalStats): PersonalStats {
    const acc = sessionKdaAccumulatorRef.current;
    const sessionKda =
      acc.length > 0 ? acc.reduce((sum, v) => sum + v, 0) / acc.length : 0;
    return {
      ...base,
      sessionWins: sessionWinsRef.current,
      sessionLosses: sessionLossesRef.current,
      sessionMatches: sessionMatchesRef.current,
      sessionKda,
    };
  }

  async function refreshPersonalStats() {
    if (!localPuuid.trim() || !settings.henrikApiKey.trim()) return;
    setPersonalStatsLoading(true);
    try {
      const s = await fetchPersonalStats(
        localPuuid,
        "",
        "",
        settings.region,
        settings.henrikApiKey,
        { bypassCache: true },
      );
      setPersonalStats(s ? overlayPersonalSession(s) : null);
    } finally {
      setPersonalStatsLoading(false);
    }
  }

  useEffect(() => {
    sessionWinsRef.current = 0;
    sessionLossesRef.current = 0;
    sessionMatchesRef.current = 0;
    sessionKdaAccumulatorRef.current = [];
    personalStatsFetchedForPuuidRef.current = "";
    setPersonalStats(null);
  }, [localPuuid]);

  useEffect(() => {
    if (!localPuuid.trim()) {
      setPersonalStats(null);
      setPersonalStatsLoading(false);
      return;
    }
    if (!settings.henrikApiKey.trim()) {
      setPersonalStatsLoading(false);
      return;
    }
    const dedupeKey = `${localPuuid}|${settings.region}|${settings.henrikApiKey.trim()}`;
    if (personalStatsFetchedForPuuidRef.current === dedupeKey) return;
    setPersonalStatsLoading(true);
    void fetchPersonalStats(localPuuid, "", "", settings.region, settings.henrikApiKey)
      .then((s) => {
        setPersonalStats(s ? overlayPersonalSession(s) : null);
      })
      .finally(() => {
        personalStatsFetchedForPuuidRef.current = dedupeKey;
        setPersonalStatsLoading(false);
      });
  }, [localPuuid, settings.henrikApiKey, settings.region]);

  useEffect(() => {
    if (matchState === "MENUS") {
      hasAutoFocusedForMatchRef.current = null;
      return;
    }
    if (matchState !== "PREGAME") return;
    const mid = pregameMatchIdForUi;
    if (!mid || hasAutoFocusedForMatchRef.current === mid) return;
    hasAutoFocusedForMatchRef.current = mid;
    void invoke("focus_window").catch(() => {});
  }, [matchState, pregameMatchIdForUi]);

  useEffect(() => {
    startDetecting();
    void initMmrDiskCache();
    return () => {
      stopPolling();
      stopDetecting();
    };
  }, []);

  useEffect(() => {
    if (!settings.henrikApiKey) return;
    void (async () => {
      const existing = await loadHistory();
      if (existing.length > 0) return;
      if (!localPuuid) return;
      await backfillMatchHistory(localPuuid, settings.region, settings.henrikApiKey);
    })();
  }, [localPuuid, settings.henrikApiKey, settings.region]);

  useEffect(() => {
    const mid = statsMatchIdRef.current;
    if (!mid) {
      playedLobbyLoadedChimeForMatchRef.current = null;
      return;
    }
    if (fetchPhase !== "done") return;
    if (!settings.soundEnabled) return;
    if (pregamePlayers.length === 0) return;
    if (playedLobbyLoadedChimeForMatchRef.current === mid) return;
    playedLobbyLoadedChimeForMatchRef.current = mid;
    playLobbyLoadedChime();
  }, [fetchPhase, settings.soundEnabled, pregamePlayers.length]);

  function resetValorantTransportStreak() {
    consecutiveConnectionFailuresRef.current = 0;
  }

  /** Transport failures toward disconnect threshold; returns true when lobby was fully cleared. */
  function onValorantTransportFailure(): boolean {
    consecutiveConnectionFailuresRef.current += 1;
    if (consecutiveConnectionFailuresRef.current < 10) return false;
    consecutiveConnectionFailuresRef.current = 0;
    setMatchState(null);
    setPlayers([]);
    setPregamePlayers([]);
    setMapName("");
    setServerName("");
    accumulatedPartyIdsByPuuid = {};
    for (const k of Object.keys(knownPartyMembers)) delete knownPartyMembers[k];
    statsMatchIdRef.current = null;
    statsKickStartedRef.current = null;
    setPregameMatchIdForUi(null);
    setPlayerStats({});
    setPlayerStatLoading({});
    resetHenrikLobbyCaches();
    setError("Lost connection to Valorant -- is the game still running?");
    isFetchingRef.current = false;
    return true;
  }

  async function flushPendingMatch(myPuuid: string) {
    if (!pendingMatchRef.current || !myPuuid) return;
    if (!settings.henrikApiKey.trim()) {
      pendingMatchRef.current = null;
      return;
    }
    const pending = pendingMatchRef.current;
    pendingMatchRef.current = null;
    const outcome = await flushPendingMatchToHistory(pending, myPuuid, settings.region, settings.henrikApiKey);
    if (outcome.appended && outcome.kda != null && outcome.won != null) {
      sessionMatchesRef.current += 1;
      if (outcome.won) sessionWinsRef.current += 1;
      else sessionLossesRef.current += 1;
      sessionKdaAccumulatorRef.current.push(outcome.kda);
      setPersonalStats((prev) => (prev ? overlayPersonalSession(prev) : null));
    }
  }

  async function detectMatchState() {
    try {
      const session = await getLocalPlayer();
      const tokens = await getAuthTokens();
      const region = String(session.region ?? settings.region);
      try {
        await getPregameMatchIdExternal(session.puuid, tokens, region);
        setMatchState("PREGAME");
        return;
      } catch (e) {
        if (isSilentTransportError(e)) {
          void onValorantTransportFailure();
          return;
        }
      }
      try {
        await getCoregameMatchIdExternal(session.puuid, tokens, region);
        setMatchState("INGAME");
        return;
      } catch (e) {
        if (isSilentTransportError(e)) {
          void onValorantTransportFailure();
          return;
        }
      }
      setMatchState("MENUS");
    } catch (e) {
      if (isSilentTransportError(e)) {
        void onValorantTransportFailure();
        return;
      }
      setMatchState(null);
    }
  }

  function startDetecting() {
    if (detectIntervalRef.current) return;
    detectIntervalRef.current = setInterval(detectMatchState, 1000);
  }

  function stopDetecting() {
    if (detectIntervalRef.current) {
      clearInterval(detectIntervalRef.current);
      detectIntervalRef.current = null;
    }
  }

  function startPolling() {
    if (intervalRef.current) return;
    fetchLobby();
    intervalRef.current = setInterval(fetchLobby, settings.refreshRate);
  }

  function stopPolling() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  async function fetchLobby(opts?: { resetHenrikSession?: boolean }) {
    if (isFetchingRef.current) return;
    if (opts?.resetHenrikSession) resetHenrikLobbyCaches();
    isFetchingRef.current = true;
    setLoading(true);
    setError(null);
    setFetchPhase("detecting");
    let puuid = "";
    let result: Omit<PlayerPresence, "rank_icon">[] = [];
    try {
      const [agentMap, rankMap] = await Promise.all([fetchAgentMap(), fetchRankMap()]);

      const session = await getLocalPlayer();
      puuid = session.puuid;
      setLocalPuuid(session.puuid);
      const region = String(session.region ?? settings.region);

      const tokens = await getAuthTokens();

      const kickoffPlayerStatsIfNeeded = (mid: string, rosterPuuids: string[]) => {
        if (!settings.henrikApiKey.trim()) return;
        if (statsKickStartedRef.current === mid) return;
        statsKickStartedRef.current = mid;
        setPlayerStatLoading(Object.fromEntries(rosterPuuids.map((id) => [id, true])));
        void Promise.allSettled(
          rosterPuuids.map(async (id) => {
            try {
              const result = await fetchPlayerRecentStats(id, region, settings.henrikApiKey);
              if (result) setPlayerStats((prev) => ({ ...prev, [id]: result }));
            } finally {
              setPlayerStatLoading((prev) => ({ ...prev, [id]: false }));
            }
          }),
        );
      };

      result = await getPresences();
      mergePartyIdsFromPresences(result);
      resetValorantTransportStreak();
      setFetchPhase("loading_players");

      const newPartyIds = [
        ...new Set(
          result
            .map((p: any) => p.party_id as string | null)
            .filter((id): id is string => id != null && id !== "" && !knownPartyMembers[id]),
        ),
      ];

      for (const pid of newPartyIds) {
        try {
          const partyData = await getPartyMembers(pid, tokens, region);
          knownPartyMembers[pid] = (partyData.Members ?? []).map((m: any) => m.Subject);
        } catch {}
      }

      let myPartyPuuids: string[] = [];
      try {
        const myPresence = result.find((p: any) => p.puuid === puuid);
        if (myPresence?.party_id) {
          const partyData = await getPartyMembers(myPresence.party_id, tokens, region);
          myPartyPuuids = (partyData.Members ?? []).map((m: any) => m.Subject);
        }
      } catch {}

      const applyPartyColorsToMerged = (merged: PregamePlayer[]): PregamePlayer[] => {
        const partyColors = ["#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#f87171"];
        const seenParties: string[] = [];
        const matchPuuids = new Set(merged.map((r) => r.puuid));

        return merged.map((p) => {
          if (myPartyPuuids.includes(p.puuid) && myPartyPuuids.length > 1) {
            return { ...p, party_color: "#ef4444" };
          }

          for (const [partyId, members] of Object.entries(knownPartyMembers)) {
            if (!members.includes(p.puuid)) continue;
            const inMatch = members.filter((uuid) => matchPuuids.has(uuid));
            if (inMatch.length < 2) continue;
            if (!seenParties.includes(partyId)) seenParties.push(partyId);
            return {
              ...p,
              party_color: partyColors[seenParties.indexOf(partyId) % partyColors.length],
            };
          }

          const pid = accumulatedPartyIdsByPuuid[p.puuid];
          if (!pid) return { ...p, party_color: null };
          const othersWithSameParty = Object.values(accumulatedPartyIdsByPuuid).filter((v) => v === pid);
          if (othersWithSameParty.length < 2) return { ...p, party_color: null };
          if (!seenParties.includes(pid)) seenParties.push(pid);
          return {
            ...p,
            party_color: partyColors[seenParties.indexOf(pid) % partyColors.length],
          };
        });
      };

      try {
        const matchId = await getPregameMatchIdExternal(puuid, tokens, region);
        setPregameMatchIdForUi(matchId);
        if (statsMatchIdRef.current !== matchId) {
          statsMatchIdRef.current = matchId;
          statsKickStartedRef.current = null;
          setPlayerStats({});
          setPlayerStatLoading({});
        }
        const match = await getPregameMatchExternal(matchId, tokens, region);

        setMapName(getMapName(match.MapID ?? ""));
        setServerName(parseGamePod(match.GamePodID ?? ""));

        const allyPlayers = dedupePlayersBySubject(match.AllyTeam?.Players);
        const puuids = allyPlayers.map((p: any) => p.Subject);
        const enemyPuuids = (match.EnemyTeam?.Players ?? []).map((p: any) => p.Subject);
        const allPuuids = [...puuids, ...enemyPuuids];
        const nameData = await getPlayerNames(allPuuids, tokens, region);

        const nameMap: Record<string, { game_name: string; tag_line: string }> = {};
        for (const n of nameData) {
          nameMap[n.Subject] = { game_name: n.GameName, tag_line: n.TagLine };
        }

        await mergeIncognitoNamesFromHenrik(allPuuids, nameMap, settings.region, settings.henrikApiKey);

        // Cross-reference presences for incognito players who are friends
        // Incognito hides names from strangers but presence data exposes friends' names
        for (const puuid of Object.keys(nameMap)) {
          if (!nameMap[puuid]?.game_name) {
            const presenceMatch = result.find(
              (p: any) => p.puuid === puuid && p.game_name
            );
            if (presenceMatch?.game_name) {
              nameMap[puuid] = {
                game_name: presenceMatch.game_name,
                tag_line: presenceMatch.game_tag ?? "",
              };
            }
          }
        }

        const mapped: PregamePlayer[] = allyPlayers.map((p: any) => {
          const name = nameMap[p.Subject] ?? { game_name: "Incognito", tag_line: "" };
          const agentData =
            agentMap[(p.CharacterID ?? "").toLowerCase()] ?? { name: "Unknown", icon: "" };
          return {
            puuid: p.Subject,
            agent_id: p.CharacterID,
            agent_name: agentData.name,
            agent_icon: agentData.icon,
            character_selection_state: p.CharacterSelectionState ?? "PREGAME",
            team_id: "ally",
            game_name: name.game_name || "Incognito",
            tag_line: name.tag_line,
            account_level: p.PlayerIdentity?.AccountLevel ?? null,
            competitive_tier: 0,
            peak_tier: 0,
            rank_icon: null,
            peak_rank_icon: null,
            party_color: null,
          };
        });

        const enemyMapped: PregamePlayer[] = (match.EnemyTeam?.Players ?? []).map((p: any) => {
          const name = nameMap[p.Subject] ?? { game_name: "Incognito", tag_line: "" };
          return {
            puuid: p.Subject,
            agent_id: "",
            agent_name: "???",
            agent_icon: "",
            character_selection_state: "PREGAME",
            team_id: "enemy",
            game_name: name.game_name || "Incognito",
            tag_line: name.tag_line,
            account_level: p.PlayerIdentity?.AccountLevel ?? null,
            competitive_tier: 0,
            peak_tier: 0,
            rank_icon: null,
            peak_rank_icon: null,
            party_color: null,
          };
        });

        const allMapped = [...mapped, ...enemyMapped];

        setPregamePlayers(applyPartyColorsToMerged(allMapped));

        let mmrMap: Record<string, MmrEntry> = {};

        if (!cachedMMR.current || cachedMMR.current.matchId !== matchId) {
          setFetchPhase("loading_ranks");
          setMmrProgress({ fetched: 0, total: allMapped.length });

          /** Updates lobby roster rank fields when a batched MMR 429 retry succeeds (pregame). */
          const onMmrResolvedAfterRetry = (playerPuuid: string, entry: MmrEntry) => {
            if (cachedMMR.current?.matchId === matchId) {
              cachedMMR.current.data[playerPuuid] = entry;
            }
            setPregamePlayers((prev) =>
              prev.map((player) =>
                player.puuid === playerPuuid
                  ? {
                      ...player,
                      competitive_tier: entry.competitive_tier,
                      peak_tier: entry.peak_tier,
                      rank_icon: entry.rank_icon,
                      peak_rank_icon: entry.peak_rank_icon,
                      peakSeasonShort: entry.peakSeasonShort,
                      actWins: entry.actWins,
                      actLosses: entry.actLosses,
                      actGames: entry.actGames,
                    }
                  : player,
              ),
            );
          };

          await Promise.all(
            allMapped.map(async (p) => {
              const entry = await fetchHenrikMmrForPlayer(
                p.puuid,
                settings.region,
                settings.henrikApiKey,
                rankMap,
                onMmrResolvedAfterRetry,
              );
              mmrMap[p.puuid] = entry;
              setMmrProgress((prev) => ({ fetched: prev.fetched + 1, total: prev.total }));

              setPregamePlayers((prev) =>
                prev.map((player) =>
                  player.puuid === p.puuid
                    ? {
                        ...player,
                        competitive_tier: entry.competitive_tier,
                        peak_tier: entry.peak_tier,
                        rank_icon: entry.rank_icon,
                        peak_rank_icon: entry.peak_rank_icon,
                        peakSeasonShort: entry.peakSeasonShort,
                        actWins: entry.actWins,
                        actLosses: entry.actLosses,
                        actGames: entry.actGames,
                      }
                    : player,
                ),
              );
            }),
          );

          cachedMMR.current = { matchId, data: mmrMap };
        } else {
          mmrMap = cachedMMR.current.data;
        }

        const merged: PregamePlayer[] = allMapped.map((row) => ({
          ...row,
          competitive_tier: mmrMap[row.puuid]?.competitive_tier ?? 0,
          rank_icon: mmrMap[row.puuid]?.rank_icon ?? null,
          peak_tier: mmrMap[row.puuid]?.peak_tier ?? 0,
          peak_rank_icon: mmrMap[row.puuid]?.peak_rank_icon ?? null,
          peakSeasonShort: mmrMap[row.puuid]?.peakSeasonShort,
          actWins: mmrMap[row.puuid]?.actWins,
          actLosses: mmrMap[row.puuid]?.actLosses,
          actGames: mmrMap[row.puuid]?.actGames,
        }));

        setPregamePlayers(applyPartyColorsToMerged(merged));

        kickoffPlayerStatsIfNeeded(
          matchId,
          allMapped.map((p) => p.puuid),
        );
      } catch {
        try {
          let matchId: string;
          try {
            matchId = await getCoregameMatchIdExternal(puuid, tokens, region);
          } catch (e) {
            if (isSilentTransportError(e)) {
              void onValorantTransportFailure();
              return;
            }
            throw e;
          }
          if (statsMatchIdRef.current !== matchId) {
            statsMatchIdRef.current = matchId;
            statsKickStartedRef.current = null;
            setPlayerStats({});
            setPlayerStatLoading({});
          }
          setPregameMatchIdForUi(null);
          let match;
          try {
            match = await getCoregameMatchExternal(matchId, tokens, region);
          } catch (e) {
            if (isSilentTransportError(e)) {
              void onValorantTransportFailure();
              return;
            }
            throw e;
          }

          const corePlayers = dedupePlayersBySubject(match.Players);

          setMapName(getMapName(match.MapID ?? ""));
          setServerName(parseGamePod(match.GamePodID ?? ""));

          const puuids = corePlayers.map((p: any) => p.Subject);
          const nameData = await getPlayerNames(puuids, tokens, region);

          const nameMap: Record<string, { game_name: string; tag_line: string }> = {};
          for (const n of nameData) {
            nameMap[n.Subject] = { game_name: n.GameName, tag_line: n.TagLine };
          }

          await mergeIncognitoNamesFromHenrik(puuids, nameMap, settings.region, settings.henrikApiKey);

          // Cross-reference presences for incognito players who are friends
          // Incognito hides names from strangers but presence data exposes friends' names
          for (const puuid of Object.keys(nameMap)) {
            if (!nameMap[puuid]?.game_name) {
              const presenceMatch = result.find(
                (p: any) => p.puuid === puuid && p.game_name
              );
              if (presenceMatch?.game_name) {
                nameMap[puuid] = {
                  game_name: presenceMatch.game_name,
                  tag_line: presenceMatch.game_tag ?? "",
                };
              }
            }
          }

          const mapped: PregamePlayer[] = corePlayers.map((p: any) => {
            const name = nameMap[p.Subject] ?? { game_name: "Incognito", tag_line: "" };
            const agentData =
              agentMap[(p.CharacterID ?? "").toLowerCase()] ?? { name: "Unknown", icon: "" };
            return {
              puuid: p.Subject,
              agent_id: p.CharacterID,
              agent_name: agentData.name,
              agent_icon: agentData.icon,
              character_selection_state: "COREGAME",
              team_id: p.TeamID,
              game_name: name.game_name || "Incognito",
              tag_line: name.tag_line,
              account_level: p.PlayerIdentity?.AccountLevel ?? null,
              competitive_tier: 0,
              rank_icon: null,
              peak_tier: 0,
              peak_rank_icon: null,
              party_color: null,
            };
          });

          setPregamePlayers(applyPartyColorsToMerged(mapped));

          let mmrMap: Record<string, MmrEntry> = {};

          if (!cachedMMR.current || cachedMMR.current.matchId !== matchId) {
            setFetchPhase("loading_ranks");
            setMmrProgress({ fetched: 0, total: mapped.length });

            /** Updates lobby roster rank fields when a batched MMR 429 retry succeeds (coregame / ingame). */
            const onMmrResolvedAfterRetry = (playerPuuid: string, entry: MmrEntry) => {
              if (cachedMMR.current?.matchId === matchId) {
                cachedMMR.current.data[playerPuuid] = entry;
              }
              setPregamePlayers((prev) =>
                prev.map((player) =>
                  player.puuid === playerPuuid
                    ? {
                        ...player,
                        competitive_tier: entry.competitive_tier,
                        peak_tier: entry.peak_tier,
                        rank_icon: entry.rank_icon,
                        peak_rank_icon: entry.peak_rank_icon,
                        peakSeasonShort: entry.peakSeasonShort,
                        actWins: entry.actWins,
                        actLosses: entry.actLosses,
                        actGames: entry.actGames,
                      }
                    : player,
                ),
              );
            };

            await Promise.all(
              mapped.map(async (p) => {
                const entry = await fetchHenrikMmrForPlayer(
                  p.puuid,
                  settings.region,
                  settings.henrikApiKey,
                  rankMap,
                  onMmrResolvedAfterRetry,
                );
                mmrMap[p.puuid] = entry;
                setMmrProgress((prev) => ({ fetched: prev.fetched + 1, total: prev.total }));

                setPregamePlayers((prev) =>
                  prev.map((player) =>
                    player.puuid === p.puuid
                      ? {
                          ...player,
                          competitive_tier: entry.competitive_tier,
                          peak_tier: entry.peak_tier,
                          rank_icon: entry.rank_icon,
                          peak_rank_icon: entry.peak_rank_icon,
                          peakSeasonShort: entry.peakSeasonShort,
                          actWins: entry.actWins,
                          actLosses: entry.actLosses,
                          actGames: entry.actGames,
                        }
                      : player,
                  ),
                );
              }),
            );

            cachedMMR.current = { matchId, data: mmrMap };
          } else {
            mmrMap = cachedMMR.current.data;
          }

          const merged: PregamePlayer[] = mapped.map((row) => ({
            ...row,
            competitive_tier: mmrMap[row.puuid]?.competitive_tier ?? 0,
            rank_icon: mmrMap[row.puuid]?.rank_icon ?? null,
            peak_tier: mmrMap[row.puuid]?.peak_tier ?? 0,
            peak_rank_icon: mmrMap[row.puuid]?.peak_rank_icon ?? null,
            peakSeasonShort: mmrMap[row.puuid]?.peakSeasonShort,
            actWins: mmrMap[row.puuid]?.actWins,
            actLosses: mmrMap[row.puuid]?.actLosses,
            actGames: mmrMap[row.puuid]?.actGames,
          }));

          kickoffPlayerStatsIfNeeded(
            matchId,
            mapped.map((p) => p.puuid),
          );

          await Promise.all(
            merged.map(async (p) => {
              const cached = resolvedAccountLevels[p.puuid];
              if (cached != null && cached > 0) {
                p.account_level = cached;
                return;
              }
              const idLevel = identityAccountLevelValue(p.account_level);
              if (idLevel != null && idLevel > 0) return;

              const level = await fetchHenrikAccountLevel(p.puuid, settings.henrikApiKey);
              if (level != null && level > 0) p.account_level = level;
            }),
          );

          setPregamePlayers(applyPartyColorsToMerged(merged));

          try {
            const players: any[] = match.Players ?? [];
            const me = players.find((p: any) => p.Subject === puuid);
            const myTeamId: string = me?.TeamID ?? "";
            const myTeam = players
              .filter((p: any) => p.TeamID === myTeamId)
              .map((p: any) => p.Subject as string);
            const enemyTeam = players
              .filter((p: any) => p.TeamID !== myTeamId)
              .map((p: any) => p.Subject as string);

            pendingMatchRef.current = {
              matchId,
              map: getMapName(match.MapID ?? ""),
              myTeam,
              enemyTeam,
            };
          } catch {}
        } catch {
          // keep existing data during state transitions
        }
      }

      const myStateSuccess = result.find((p) => p.puuid === puuid)?.session_state?.toUpperCase();
      if (myStateSuccess === "MENUS" || myStateSuccess === "MENU") {
        setPregamePlayers([]);
        setMapName("");
        setServerName("");
        accumulatedPartyIdsByPuuid = {};
        for (const k of Object.keys(knownPartyMembers)) delete knownPartyMembers[k];
        statsMatchIdRef.current = null;
        statsKickStartedRef.current = null;
        setPregameMatchIdForUi(null);
        setPlayerStats({});
        setPlayerStatLoading({});
        resetHenrikLobbyCaches();
        await flushPendingMatch(puuid);
      }

      setPlayers(
        result.map((p) => ({
          ...p,
          rank_icon: rankMap[p.competitive_tier ?? 0] ?? null,
        })),
      );
    } catch (e) {
      if (isSilentTransportError(e)) void onValorantTransportFailure();
      setError(String(e));
      const myState = result.find((p) => p.puuid === puuid)?.session_state?.toUpperCase();
      if (myState === "MENUS" || myState === "MENU") {
        setPregamePlayers([]);
        setMapName("");
        setServerName("");
        accumulatedPartyIdsByPuuid = {};
        for (const k of Object.keys(knownPartyMembers)) delete knownPartyMembers[k];
        statsMatchIdRef.current = null;
        statsKickStartedRef.current = null;
        setPregameMatchIdForUi(null);
        setPlayerStats({});
        setPlayerStatLoading({});
        resetHenrikLobbyCaches();
        await flushPendingMatch(puuid);
      }
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
      setFetchPhase("done");
      setTimeout(() => setFetchPhase("idle"), 3000);
    }
  }

  return {
    players,
    pregamePlayers,
    playerStats,
    playerStatLoading,
    personalStats,
    personalStatsLoading,
    refreshPersonalStats,
    mapName,
    serverName,
    localPuuid,
    loading,
    error,
    fetchPhase,
    mmrProgress,
    matchState,
    fetchLobby,
    startPolling,
    stopPolling,
    loadHistory,
    summarizePlayer,
    backfillMatchHistory,
  };
}
