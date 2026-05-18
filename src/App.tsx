import { useState, useEffect, type ReactNode } from "react";
import { useLobby, calculateWinProbability } from "./hooks/useLobby";
import type {
  FetchPhase,
  MatchRecord,
  PlayerPresence,
  PlayerMatchStats,
  PregamePlayer,
  Settings,
} from "./types";
import { getMatchStatsAgainstPlayerFromHistory } from "./hooks/useMatchHistory";
import SettingsPanel from "./components/Settings";
import { loadSettings } from "./store/settings";
import { useUpdater } from "./hooks/useUpdater";

const RANK_NAMES: Record<number, string> = {
  0: "Unranked",
  3: "Iron 1", 4: "Iron 2", 5: "Iron 3",
  6: "Bronze 1", 7: "Bronze 2", 8: "Bronze 3",
  9: "Silver 1", 10: "Silver 2", 11: "Silver 3",
  12: "Gold 1", 13: "Gold 2", 14: "Gold 3",
  15: "Plat 1", 16: "Plat 2", 17: "Plat 3",
  18: "Diamond 1", 19: "Diamond 2", 20: "Diamond 3",
  21: "Ascendant 1", 22: "Ascendant 2", 23: "Ascendant 3",
  24: "Immortal 1", 25: "Immortal 2", 26: "Immortal 3",
  27: "Radiant",
};

const RANK_COLORS: Record<number, string> = {
  3: "#6b7280", 4: "#6b7280", 5: "#6b7280",
  6: "#b45309", 7: "#b45309", 8: "#b45309",
  9: "#94a3b8", 10: "#94a3b8", 11: "#94a3b8",
  12: "#eab308", 13: "#eab308", 14: "#eab308",
  15: "#0891b2", 16: "#0891b2", 17: "#0891b2",
  18: "#7c3aed", 19: "#7c3aed", 20: "#7c3aed",
  21: "#059669", 22: "#059669", 23: "#059669",
  24: "#dc2626", 25: "#dc2626", 26: "#dc2626",
  27: "#f59e0b",
};

const RANK_BG: Record<number, string> = {
  3: "rgba(107,114,128,0.15)", 4: "rgba(107,114,128,0.15)", 5: "rgba(107,114,128,0.15)",
  6: "rgba(180,83,9,0.15)", 7: "rgba(180,83,9,0.15)", 8: "rgba(180,83,9,0.15)",
  9: "rgba(148,163,184,0.15)", 10: "rgba(148,163,184,0.15)", 11: "rgba(148,163,184,0.15)",
  12: "rgba(234,179,8,0.15)", 13: "rgba(234,179,8,0.15)", 14: "rgba(234,179,8,0.15)",
  15: "rgba(8,145,178,0.15)", 16: "rgba(8,145,178,0.15)", 17: "rgba(8,145,178,0.15)",
  18: "rgba(124,58,237,0.15)", 19: "rgba(124,58,237,0.15)", 20: "rgba(124,58,237,0.15)",
  21: "rgba(5,150,105,0.15)", 22: "rgba(5,150,105,0.15)", 23: "rgba(5,150,105,0.15)",
  24: "rgba(220,38,38,0.18)", 25: "rgba(220,38,38,0.18)", 26: "rgba(220,38,38,0.18)",
  27: "rgba(245,158,11,0.18)",
};

function getRankGlow(tier: number | null): string {
  if (!tier) return "";
  if (tier === 27) return "0 0 12px 2px rgba(245,197,66,0.6)";
  if (tier >= 24) return "0 0 12px 2px rgba(224,85,85,0.5)";
  if (tier >= 21) return "0 0 10px 2px rgba(192,132,252,0.4)";
  return "";
}

function RankBadge({ tier, onRetry }: { tier: number | null; onRetry?: () => void }) {
  if (!tier || tier === 0) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-xs text-gray-500 dark:text-gray-600">—</span>
        {onRetry && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            title="Retry rank fetch"
            className="w-5 h-5 flex items-center justify-center rounded border border-gray-300 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-xs"
          >
            ↺
          </button>
        )}
      </div>
    );
  }
  const name = RANK_NAMES[tier] ?? "Unknown";
  const color = RANK_COLORS[tier] ?? "#9ca3af";
  return (
    <span style={{ color }} className="text-xs font-bold tracking-wider uppercase">
      {name}
    </span>
  );
}

function PeakBadge({ tier, icon }: { tier: number; icon?: string | null }) {
  if (!tier || tier === 0) {
    return <span className="text-xs text-gray-500 dark:text-gray-600">—</span>;
  }
  const name = RANK_NAMES[tier] ?? "Unknown";
  const color = RANK_COLORS[tier] ?? "#9ca3af";
  const bg = RANK_BG[tier] ?? "rgba(156,163,175,0.15)";
  return (
    <span
      style={{ color, background: bg }}
      className="inline-flex items-center gap-1 text-xs font-bold tracking-wider uppercase px-1.5 py-0.5 rounded"
    >
      {icon && <img src={icon} alt="" className="w-3.5 h-3.5 object-contain" />}
      {name}
    </span>
  );
}

function getPartyColor(partyId: string | null, allPlayers: PlayerPresence[]): string {
  if (!partyId) return "";
  const partyMembers = allPlayers.filter(p => p.party_id === partyId);
  if (partyMembers.length < 2) return "";
  const partyIds = [...new Set(allPlayers.filter(p => p.party_id).map(p => p.party_id))] as string[];
  const index = partyIds.indexOf(partyId);
  const colors = ["#f87171", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa"];
  return colors[index % colors.length];
}

function MatchHistoryPopup({
  puuid,
  myPuuid,
  history,
  playerName,
  onClose,
}: {
  puuid: string;
  myPuuid: string;
  history: MatchRecord[];
  playerName: string;
  onClose: () => void;
}) {
  const matches = history
    .filter((m) => m.my_puuid === myPuuid)
    .filter((m) => m.my_team.includes(puuid) || m.enemy_team.includes(puuid))
    .sort((a, b) => b.date - a.date);

  const timesTeammate = matches.filter((m) => m.my_team.includes(puuid)).length;
  const timesEnemy = matches.filter((m) => m.enemy_team.includes(puuid)).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 w-80 max-h-96 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-gray-900 dark:text-white font-bold text-sm">{playerName}</span>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-white text-xs">
            ✕
          </button>
        </div>
        {matches.length === 0 ? (
          <p className="text-gray-500 text-xs">No matches found in history.</p>
        ) : (
          <>
            <p className="text-gray-500 dark:text-gray-400 text-xs mb-3">
              Matched{" "}
              <span className="text-gray-900 dark:text-white font-bold">{timesTeammate + timesEnemy}</span>{" "}
              time{timesTeammate + timesEnemy !== 1 ? "s" : ""}
              {" — "}
              <span className="text-orange-400">{timesEnemy}</span> enemy
              <span className="text-gray-400"> · </span>
              <span className="text-blue-400">{timesTeammate}</span> teammate
            </p>
            <div className="flex flex-col gap-2">
              {matches.map((m, i) => {
                const wasTeammate = m.my_team.includes(puuid);
                const date = new Date(m.date * 1000);
                const dateStr = date.toLocaleDateString(undefined, {
                  month: "short", day: "numeric", year: "numeric",
                });
                return (
                  <div key={i} className="bg-gray-100 dark:bg-gray-800 rounded px-3 py-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-gray-700 dark:text-gray-300 font-medium">{m.map || "Unknown Map"}</span>
                      <span className={m.won ? "text-green-500" : "text-red-400"}>{m.won ? "W" : "L"}</span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className={wasTeammate ? "text-blue-400" : "text-orange-400"}>
                        {wasTeammate ? "Teammate" : "Enemy"}
                      </span>
                      <span className="text-gray-400">{dateStr}</span>
                    </div>
                    {(m.kills != null || m.deaths != null || m.assists != null) && (
                      <div className="text-gray-400 mt-1 tabular-nums">
                        K/D/A {m.kills ?? "—"}/{m.deaths ?? "—"}/{m.assists ?? "—"}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatusStrip({
  fetchPhase,
  mmrProgress,
  matchState,
}: {
  fetchPhase: FetchPhase;
  mmrProgress: { fetched: number; total: number };
  matchState: "MENUS" | "PREGAME" | "INGAME" | null;
}) {
  const base = "flex items-center gap-2 px-4 py-1.5 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-xs";

  if (fetchPhase === "idle" && matchState === "MENUS") {
    return (
      <div className={`${base} text-gray-400 dark:text-gray-500`}>
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-600 inline-block" />
        In menus
      </div>
    );
  }
  if (fetchPhase === "idle" && matchState === null) {
    return (
      <div className={`${base} text-gray-400 dark:text-gray-500`}>
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-600 inline-block" />
        Waiting for Valorant...
      </div>
    );
  }
  if (fetchPhase === "detecting") {
    return (
      <div className={`${base} text-yellow-600 dark:text-yellow-500`}>
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 inline-block animate-pulse" />
        Detecting match...
      </div>
    );
  }
  if (fetchPhase === "loading_players") {
    return (
      <div className={`${base} text-blue-500 dark:text-blue-400`}>
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 dark:bg-blue-400 inline-block animate-pulse" />
        Loading players...
      </div>
    );
  }
  if (fetchPhase === "loading_ranks") {
    const pct = mmrProgress.total > 0
      ? Math.round((mmrProgress.fetched / mmrProgress.total) * 100)
      : 0;
    return (
      <div className="flex flex-col gap-1 px-4 py-1.5 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-between text-xs">
          <span className="text-blue-500 dark:text-blue-400 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 dark:bg-blue-400 inline-block animate-pulse" />
            Loading ranks...
          </span>
          <span className="text-gray-400 dark:text-gray-500">{mmrProgress.fetched}/{mmrProgress.total}</span>
        </div>
        <div className="w-full h-0.5 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }
  if (fetchPhase === "done") {
    return (
      <div className={`${base} text-green-600 dark:text-green-500`}>
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
        {matchState === "PREGAME" ? "Agent select detected" : matchState === "INGAME" ? "Match detected" : "Done"}
      </div>
    );
  }
  if (fetchPhase === "idle" && (matchState === "PREGAME" || matchState === "INGAME")) {
    return (
      <div className={`${base} text-green-600 dark:text-green-600`}>
        <span className="w-1.5 h-1.5 rounded-full bg-green-600 inline-block" />
        {matchState === "PREGAME" ? "Agent select" : "In game"}
      </div>
    );
  }
  return null;
}

// KDA and WIN% removed -- WinProbabilityFooter still uses playerStats internally
const MATCH_TABLE_GRID = "36px minmax(160px,1fr) 110px 100px 54px 54px";

function MatchStatColumns({ stats, loading }: { stats: PlayerMatchStats | undefined; loading: boolean }) {
  return (
    <>
      <div className="text-xs tabular-nums text-right text-gray-700 dark:text-gray-300">
        {loading ? (
          <span className="animate-pulse text-gray-400 dark:text-gray-500">...</span>
        ) : stats ? (
          <span>{Math.round(stats.avgACS)}</span>
        ) : (
          <span className="text-gray-400 dark:text-gray-600">—</span>
        )}
      </div>
      <div className="text-[10px] tabular-nums text-right text-gray-400 dark:text-gray-500 leading-tight">
        {!loading && stats ? <span>{stats.matchesPlayed}</span> : null}
      </div>
    </>
  );
}

function WinProbabilityFooter({
  roster,
  playerStats,
  playerStatLoading,
  henrikConfigured,
}: {
  roster: PregamePlayer[];
  playerStats: Record<string, PlayerMatchStats>;
  playerStatLoading: Record<string, boolean>;
  henrikConfigured: boolean;
}) {
  if (!henrikConfigured || roster.length === 0) return null;

  const loadedCount = roster.filter((p) => playerStats[p.puuid] != null).length;
  const anyLoading = roster.some((p) => playerStatLoading[p.puuid]);
  const showCalculating = loadedCount === 0 && anyLoading;

  let barEl: ReactNode = null;
  if (loadedCount >= 4) {
    const { blueWinPct, redWinPct, confidence } = calculateWinProbability(roster, playerStats);
    const confLabel =
      confidence === "low" ? "Low confidence"
        : confidence === "medium" ? "Medium confidence"
        : "High confidence";
    barEl = (
      <div className="mt-1">
        <div className="flex h-3 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
          <div className="bg-blue-600 transition-[width] duration-700 ease-out" style={{ width: `${blueWinPct}%` }} />
          <div className="bg-red-600 transition-[width] duration-700 ease-out" style={{ width: `${redWinPct}%` }} />
        </div>
        <div className="flex justify-between items-start gap-2 mt-1.5 text-xs">
          <span className="text-blue-500 dark:text-blue-400 tabular-nums font-semibold">{blueWinPct.toFixed(1)}%</span>
          <span className="text-[10px] text-gray-400 dark:text-gray-500 text-center flex-1">{confLabel}</span>
          <span className="text-red-500 dark:text-red-400 tabular-nums font-semibold">{redWinPct.toFixed(1)}%</span>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-800 bg-gray-50/90 dark:bg-gray-950/90 px-4 py-3">
      {showCalculating && (
        <div className="text-xs text-gray-400 dark:text-gray-500 animate-pulse mb-2">Calculating...</div>
      )}
      {barEl}
    </div>
  );
}

export default function App() {
  useUpdater();
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("burgerlens-theme") as "dark" | "light") ?? "dark";
  });

  const {
    players,
    pregamePlayers,
    playerStats,
    playerStatLoading,
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
  } = useLobby(settings);

  const [history, setHistory] = useState<MatchRecord[]>([]);
  const [selectedPuuid, setSelectedPuuid] = useState<string | null>(null);
  const [retryingPuuids, setRetryingPuuids] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadHistory().then(setHistory);
  }, [loadHistory]);

  useEffect(() => {
    localStorage.setItem("burgerlens-theme", theme);
  }, [theme]);

  function handleRetryRank(puuid: string) {
    setRetryingPuuids((prev) => new Set(prev).add(puuid));
    fetchLobby();
    // clear after 8s regardless -- useLobby will update the tier when done
    setTimeout(() => {
      setRetryingPuuids((prev) => {
        const next = new Set(prev);
        next.delete(puuid);
        return next;
      });
    }, 8000);
  }

  const isDark = theme === "dark";

  return (
    <div
      className="min-h-screen bg-[#0f1117] text-gray-900 dark:text-white"
      style={{ fontFamily: "'Din Next', 'Rajdhani', sans-serif", opacity: settings.opacity }}
    >
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onClose={() => setShowSettings(false)}
          onChange={setSettings}
        />
      )}

      {/* Header */}
      <div className="border-b border-gray-200 dark:border-gray-800 px-6 py-3 flex items-center justify-between bg-white dark:bg-gray-950">
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 bg-red-500" />
          <h1 className="text-xl font-black tracking-widest uppercase text-gray-900 dark:text-white">BurgerLens</h1>
        </div>
        <div className="flex gap-2 items-center">
          <button
            type="button"
            onClick={() => setTheme(isDark ? "light" : "dark")}
            title={isDark ? "Light mode" : "Dark mode"}
            className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-white transition-colors"
          >
            {isDark ? "☀" : "☽"}
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="px-4 py-1.5 text-sm font-bold uppercase tracking-wider border border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-white transition-colors"
          >
            Settings
          </button>
          <button
            type="button"
            onClick={fetchLobby}
            disabled={loading}
            className="px-4 py-1.5 text-sm font-bold uppercase tracking-wider border border-red-400 dark:border-red-500 text-red-500 dark:text-red-400 hover:bg-red-500 hover:text-white disabled:opacity-40 transition-colors"
          >
            FETCH
          </button>
          <button
            type="button"
            onClick={startPolling}
            className="px-4 py-1.5 text-sm font-bold uppercase tracking-wider border border-green-500 text-green-600 dark:text-green-400 hover:bg-green-500 hover:text-white transition-colors"
          >
            Auto
          </button>
          <button
            type="button"
            onClick={stopPolling}
            className="px-4 py-1.5 text-sm font-bold uppercase tracking-wider border border-gray-300 dark:border-gray-500 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-500 hover:text-gray-700 dark:hover:text-white transition-colors"
          >
            Stop
          </button>
        </div>
      </div>

      {!settings.henrikApiKey.trim() && (
        <div
          className="mx-6 mt-3 rounded border border-amber-600/50 bg-amber-50 dark:bg-amber-950/40 px-4 py-2 text-xs text-amber-700 dark:text-amber-200/95"
          role="status"
        >
          <span className="font-semibold text-amber-800 dark:text-amber-100">Henrik API key missing.</span>{" "}
          Competitive ranks and match history will not load until you add your key in{" "}
          <button
            type="button"
            className="underline font-semibold text-amber-800 dark:text-amber-100 hover:text-amber-900 dark:hover:text-white"
            onClick={() => setShowSettings(true)}
          >
            Settings
          </button>
          .
        </div>
      )}

      <StatusStrip fetchPhase={fetchPhase} mmrProgress={mmrProgress} matchState={matchState} />

      <div className="px-6 py-4 space-y-6">
        {error && (
          <p className="text-yellow-500 dark:text-yellow-400 text-xs uppercase tracking-wider">{error}</p>
        )}

        {pregamePlayers.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-widest text-red-500 dark:text-red-400">In Game</span>
              {mapName && <span className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider">— {mapName}</span>}
              {serverName && <span className="text-xs text-gray-400 dark:text-gray-600 uppercase tracking-wider">{serverName}</span>}
              <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800" />
              <span className="text-xs text-gray-400 dark:text-gray-600">{pregamePlayers.length} players</span>
            </div>

            <div className="border border-gray-200 dark:border-gray-800 overflow-hidden rounded">
              {/* Rank summary strip */}
              {(() => {
                const ranked = pregamePlayers.filter(p => p.competitive_tier > 0);
                if (ranked.length === 0) return null;
                const avg = Math.round(ranked.reduce((sum, p) => sum + p.competitive_tier, 0) / ranked.length);
                const highest = Math.max(...ranked.map(p => p.competitive_tier));
                return (
                  <div className="flex gap-4 px-4 py-2 text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60">
                    <span>Avg: <span className="text-gray-700 dark:text-gray-300">{RANK_NAMES[avg] ?? "Unranked"}</span></span>
                    <span>Highest: <span style={{ color: RANK_COLORS[highest] ?? "#9ca3af" }}>{RANK_NAMES[highest]}</span></span>
                    <span>Ranked: <span className="text-gray-700 dark:text-gray-300">{ranked.length}/{pregamePlayers.length}</span></span>
                  </div>
                );
              })()}

              {/* Column headers */}
              <div
                className="grid gap-x-3 px-4 py-2 text-xs font-bold uppercase tracking-widest text-gray-400 dark:text-gray-600 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900"
                style={{ gridTemplateColumns: MATCH_TABLE_GRID }}
              >
                <div />
                <div>Player</div>
                <div>Rank</div>
                <div>Peak</div>
                <div className="text-right">ACS</div>
                <div className="text-right">Games</div>
              </div>

              {["Blue", "Red", "ally", "enemy", ""].map((team) => {
                const teamPlayers = team
                  ? pregamePlayers.filter((p) => p.team_id === team)
                  : pregamePlayers.filter(
                      (p) => !["Blue", "Red", "ally", "enemy"].includes(p.team_id),
                    );
                if (teamPlayers.length === 0) return null;

                const teamLabel =
                  team === "ally" ? "Your Team" : team === "enemy" ? "Enemy Team" : team;

                const isBlue = team === "ally" || team === "Blue";
                const isRed = team === "enemy" || team === "Red";

                const showSectionHeader =
                  team !== "" &&
                  (team === "ally" || team === "enemy" || pregamePlayers.some((p) => p.team_id === "Red"));

                return (
                  <div key={team || "other"}>
                    {showSectionHeader && (
                      <div
                        className={`text-xs font-bold uppercase tracking-widest px-4 py-1.5 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2 ${
                          isBlue
                            ? "bg-blue-50/50 dark:bg-blue-950/10 border-l-2 border-l-blue-500"
                            : isRed
                              ? "bg-red-50/50 dark:bg-red-950/10 border-l-2 border-l-red-500"
                              : "bg-gray-50 dark:bg-gray-900/20"
                        }`}
                      >
                        <span className={
                          isBlue ? "text-blue-500 dark:text-blue-400"
                            : isRed ? "text-red-500 dark:text-red-400"
                            : "text-gray-400"
                        }>
                          {teamLabel}
                        </span>
                      </div>
                    )}

                    {teamPlayers.map((p) => {
                      const matchStats =
                        localPuuid && history.length > 0
                          ? getMatchStatsAgainstPlayerFromHistory(history, localPuuid, p.puuid)
                          : { timesMatched: 0, timesEnemy: 0, timesTeammate: 0 };
                      const hasPriorMatches = Boolean(
                        localPuuid && p.puuid !== localPuuid && matchStats.timesMatched > 0,
                      );
                      const rankGlow = getRankGlow(p.competitive_tier) || getRankGlow(p.peak_tier) || "";
                      const historyInset =
                        hasPriorMatches && (p.party_color || p.puuid === localPuuid)
                          ? "inset 2px 0 0 0 rgba(20, 184, 166, 0.4)"
                          : "";
                      const rowBoxShadow = [rankGlow, historyInset].filter(Boolean).join(", ") || undefined;
                      const rowBorderLeft = p.party_color
                        ? `3px solid ${p.party_color}`
                        : p.puuid === localPuuid
                          ? "3px solid #ef4444"
                          : hasPriorMatches
                            ? "2px solid rgba(45, 212, 191, 0.45)"
                            : "3px solid transparent";

                      const isRetrying = retryingPuuids.has(p.puuid);
                      const showRetry = (!p.competitive_tier || p.competitive_tier === 0) && !isRetrying;

                      const agentBorderColor = isBlue
                        ? "rgba(59,130,246,0.35)"
                        : isRed
                          ? "rgba(239,68,68,0.35)"
                          : "rgba(156,163,175,0.2)";

                      return (
                        <div
                          key={p.puuid}
                          onClick={() => setSelectedPuuid(p.puuid)}
                          className={`cursor-pointer grid gap-x-4 px-4 py-2.5 items-center border-b border-gray-100 dark:border-gray-800 transition-colors ${
                            p.puuid === localPuuid
                              ? "bg-red-50/60 dark:bg-red-950/30 hover:bg-red-50 dark:hover:bg-red-950/40"
                              : "hover:bg-gray-50 dark:hover:bg-gray-800/50"
                          }`}
                          style={{
                            gridTemplateColumns: MATCH_TABLE_GRID,
                            boxShadow: rowBoxShadow,
                            borderLeft: rowBorderLeft,
                          }}
                        >
                          {/* Agent icon - circular with team tint border */}
                          {p.agent_icon ? (
                            <div
                              className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0"
                              style={{ border: `1.5px solid ${agentBorderColor}` }}
                            >
                              <img src={p.agent_icon} alt={p.agent_name} className="w-full h-full object-cover" />
                            </div>
                          ) : (
                            <div
                              className="w-9 h-9 rounded-full bg-gray-200 dark:bg-gray-800 flex-shrink-0"
                              style={{ border: `1.5px solid ${agentBorderColor}` }}
                            />
                          )}

                          {/* Player name */}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-sm font-bold text-gray-900 dark:text-white truncate min-w-0 flex-1">
                                {p.game_name}
                              </span>
                              {hasPriorMatches && (
                                <span
                                  className="text-[10px] font-semibold tabular-nums text-teal-500/55 uppercase tracking-wide shrink-0"
                                  title={`Matched ${matchStats.timesMatched} times before`}
                                >
                                  {matchStats.timesMatched}x
                                </span>
                              )}
                              {p.tag_line && (
                                <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">#{p.tag_line}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wide">{p.agent_name}</span>
                              {p.account_level != null && p.account_level > 0 && (
                                <span className="text-xs text-gray-400 dark:text-gray-600">Lvl {p.account_level}</span>
                              )}
                            </div>
                          </div>

                          {/* Current rank */}
                          <div className="flex items-center gap-1.5">
                            {(p.competitive_tier ?? 0) > 0 && p.rank_icon && (
                              <img src={p.rank_icon} alt="" className="w-5 h-5 object-contain" />
                            )}
                            {isRetrying ? (
                              <span className="text-xs text-gray-400 dark:text-gray-500 animate-pulse">...</span>
                            ) : (
                              <RankBadge
                                tier={p.competitive_tier}
                                onRetry={showRetry ? () => handleRetryRank(p.puuid) : undefined}
                              />
                            )}
                          </div>

                          {/* Peak rank */}
                          <div className="flex items-center">
                            <PeakBadge tier={p.peak_tier} icon={p.peak_rank_icon} />
                          </div>

                          <MatchStatColumns
                            stats={playerStats[p.puuid]}
                            loading={Boolean(playerStatLoading[p.puuid])}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              <WinProbabilityFooter
                roster={pregamePlayers}
                playerStats={playerStats}
                playerStatLoading={playerStatLoading}
                henrikConfigured={Boolean(settings.henrikApiKey.trim())}
              />
            </div>
          </div>
        )}

        {/* Online Friends */}
        {players.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Online</span>
              <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800" />
              <span className="text-xs text-gray-400 dark:text-gray-600">{players.length} online</span>
            </div>
            <div className="space-y-1">
              {players.map((p) => {
                const glow = getRankGlow(p.competitive_tier);
                const partyColor = getPartyColor(p.party_id, players);
                return (
                  <div
                    key={p.puuid}
                    className="flex items-center gap-4 px-4 py-3 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition-all rounded border border-gray-100 dark:border-gray-800"
                    style={{
                      boxShadow: glow,
                      borderLeft: partyColor ? `2px solid ${partyColor}` : "2px solid transparent",
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-gray-900 dark:text-white truncate">{p.game_name}</span>
                        {p.game_tag && (
                          <span className="text-xs text-gray-400 dark:text-gray-500">#{p.game_tag}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {(p.competitive_tier ?? 0) > 0 && p.rank_icon && (
                          <img src={p.rank_icon} alt="" className="w-4 h-4 object-contain" />
                        )}
                        <RankBadge tier={p.competitive_tier} />
                        {p.account_level && (
                          <span className="text-xs text-gray-400 dark:text-gray-600">Lvl {p.account_level}</span>
                        )}
                      </div>
                    </div>
                    {p.session_state && (
                      <span className="text-xs uppercase tracking-wider text-gray-400 dark:text-gray-500">
                        {p.session_state.replace(/_/g, " ")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {selectedPuuid &&
        (() => {
          const p = pregamePlayers.find((pl) => pl.puuid === selectedPuuid);
          if (!p) return null;
          return (
            <MatchHistoryPopup
              puuid={selectedPuuid}
              myPuuid={localPuuid}
              history={history}
              playerName={`${p.game_name}#${p.tag_line}`}
              onClose={() => setSelectedPuuid(null)}
            />
          );
        })()}
    </div>
  );
}
