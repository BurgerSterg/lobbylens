import { useState, useEffect } from "react";
import { useLobby } from "./hooks/useLobby";
import type { MatchRecord, PlayerPresence, Settings } from "./types";
import SettingsPanel from "./components/Settings";
import { loadSettings } from "./store/settings";

const RANK_NAMES: Record<number, string> = {
  0: "Unranked", 3: "Iron 1", 4: "Iron 2", 5: "Iron 3",
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
  27: "#f5c542",
  26: "#e05555", 25: "#e05555", 24: "#e05555",
  23: "#c084fc", 22: "#c084fc", 21: "#c084fc",
  20: "#60a5fa", 19: "#60a5fa", 18: "#60a5fa",
};

function getRankGlow(tier: number | null): string {
  if (!tier) return "";
  if (tier === 27) return "0 0 12px 2px rgba(245,197,66,0.6)";
  if (tier >= 24) return "0 0 12px 2px rgba(224,85,85,0.5)";
  if (tier >= 21) return "0 0 10px 2px rgba(192,132,252,0.4)";
  return "";
}

function RankBadge({ tier }: { tier: number | null }) {
  if (!tier || tier === 0) {
    return <span className="text-xs text-gray-600">—</span>;
  }
  const name = RANK_NAMES[tier] ?? "Unknown";
  const color = RANK_COLORS[tier] ?? "#9ca3af";
  return (
    <span style={{ color }} className="text-xs font-bold tracking-wider uppercase">
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg p-4 w-80 max-h-96 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white font-bold text-sm">{playerName}</span>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-white text-xs">
            ✕
          </button>
        </div>

        {matches.length === 0 ? (
          <p className="text-gray-500 text-xs">No matches found in history.</p>
        ) : (
          <>
            <p className="text-gray-400 text-xs mb-3">
              Met <span className="text-white font-bold">{matches.length}</span> time{matches.length !== 1 ? "s" : ""}
            </p>
            <div className="flex flex-col gap-2">
              {matches.map((m, i) => {
                const wasTeammate = m.my_team.includes(puuid);
                const date = new Date(m.date * 1000);
                const dateStr = date.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                });
                return (
                  <div key={i} className="bg-gray-800 rounded px-3 py-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-gray-300 font-medium">{m.map || "Unknown Map"}</span>
                      <span className={m.won ? "text-green-400" : "text-red-400"}>{m.won ? "W" : "L"}</span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className={wasTeammate ? "text-blue-400" : "text-orange-400"}>
                        {wasTeammate ? "Teammate" : "Enemy"}
                      </span>
                      <span className="text-gray-500">{dateStr}</span>
                    </div>
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

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const {
    players,
    pregamePlayers,
    mapName,
    serverName,
    localPuuid,
    loading,
    error,
    fetchLobby,
    startPolling,
    stopPolling,
    loadHistory,
  } = useLobby(settings);

  const [history, setHistory] = useState<MatchRecord[]>([]);
  const [selectedPuuid, setSelectedPuuid] = useState<string | null>(null);

  useEffect(() => {
    void loadHistory().then(setHistory);
  }, [loadHistory]);

  return (
    <div className="min-h-screen bg-gray-950 text-white" style={{ fontFamily: "'Din Next', 'Rajdhani', sans-serif", opacity: settings.opacity }}>

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onClose={() => setShowSettings(false)}
          onChange={setSettings}
        />
      )}

      <div className="border-b border-gray-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 bg-red-500" />
          <h1 className="text-xl font-black tracking-widest uppercase text-white">LobbyLens</h1>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="px-4 py-1.5 text-sm font-bold uppercase tracking-wider border border-gray-600 text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
          >
            Settings
          </button>
          <button
            type="button"
            onClick={fetchLobby}
            disabled={loading}
            className="px-4 py-1.5 text-sm font-bold uppercase tracking-wider border border-red-500 text-red-400 hover:bg-red-500 hover:text-white disabled:opacity-40 transition-colors"
          >
            {loading ? "..." : "Fetch"}
          </button>
          <button
            type="button"
            onClick={startPolling}
            className="px-4 py-1.5 text-sm font-bold uppercase tracking-wider border border-green-500 text-green-400 hover:bg-green-500 hover:text-white transition-colors"
          >
            Auto
          </button>
          <button
            type="button"
            onClick={stopPolling}
            className="px-4 py-1.5 text-sm font-bold uppercase tracking-wider border border-gray-500 text-gray-400 hover:bg-gray-500 hover:text-white transition-colors"
          >
            Stop
          </button>
        </div>
      </div>

      {!settings.henrikApiKey.trim() && (
        <div
          className="mx-6 mt-3 rounded border border-amber-600/50 bg-amber-950/40 px-4 py-2 text-xs text-amber-200/95"
          role="status"
        >
          <span className="font-semibold text-amber-100">Henrik API key missing.</span>{" "}
          Competitive ranks and match history will not load until you add your key in{" "}
          <button
            type="button"
            className="underline font-semibold text-amber-100 hover:text-white"
            onClick={() => setShowSettings(true)}
          >
            Settings
          </button>
          .
        </div>
      )}

      <div className="px-6 py-4 space-y-6">

        {error && (
          <p className="text-yellow-400 text-xs uppercase tracking-wider">{error}</p>
        )}

        {pregamePlayers.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-widest text-red-400">In Game</span>
              {mapName && <span className="text-xs text-gray-500 uppercase tracking-wider">— {mapName}</span>}
              {serverName && <span className="text-xs text-gray-600 uppercase tracking-wider">{serverName}</span>}
              <div className="flex-1 h-px bg-gray-800" />
              <span className="text-xs text-gray-600">{pregamePlayers.length} players</span>
            </div>

            <div className="border border-gray-800 overflow-hidden">
              {pregamePlayers.length > 0 && (() => {
                const ranked = pregamePlayers.filter(p => p.competitive_tier > 0);
                if (ranked.length === 0) return null;
                const avg = Math.round(ranked.reduce((sum, p) => sum + p.competitive_tier, 0) / ranked.length);
                const highest = Math.max(...ranked.map(p => p.competitive_tier));
                return (
                  <div className="flex gap-4 px-4 py-2 text-xs text-gray-500 border-b border-gray-800">
                    <span>Avg: <span className="text-gray-300">{RANK_NAMES[avg] ?? "Unranked"}</span></span>
                    <span>Highest: <span style={{ color: RANK_COLORS[highest] ?? "#9ca3af" }}>{RANK_NAMES[highest]}</span></span>
                    <span>Ranked: <span className="text-gray-300">{ranked.length}/{pregamePlayers.length}</span></span>
                  </div>
                );
              })()}
              {/* Column headers */}
              <div className="grid gap-x-4 px-4 py-2 text-xs font-bold uppercase tracking-widest text-gray-600 border-b border-gray-700 bg-gray-900"
                style={{ gridTemplateColumns: "36px 1fr 140px 140px" }}>
                <div />
                <div>Player</div>
                <div>Rank</div>
                <div>Peak</div>
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
                const teamColor =
                  team === "ally" || team === "Blue"
                    ? "text-blue-400 bg-blue-950/20"
                    : team === "enemy" || team === "Red"
                      ? "text-red-400 bg-red-950/20"
                      : "text-gray-400 bg-gray-900/20";

                const showSectionHeader =
                  team !== "" &&
                  (team === "ally" ||
                    team === "enemy" ||
                    pregamePlayers.some((p) => p.team_id === "Red"));

                return (
                  <div key={team || "other"}>
                    {showSectionHeader && (
                      <div
                        className={`text-xs font-bold uppercase tracking-widest px-4 py-1.5 border-b border-gray-800 ${teamColor}`}
                      >
                        {teamLabel}
                      </div>
                    )}
                    {teamPlayers.map((p) => (
                      <div
                        key={p.puuid}
                        onClick={() => setSelectedPuuid(p.puuid)}
                        className={`cursor-pointer grid gap-x-4 px-4 py-2.5 items-center border-b border-gray-800 transition-colors ${
                          p.puuid === localPuuid
                            ? "bg-red-950/30 hover:bg-red-950/40"
                            : "hover:bg-gray-800/50"
                        }`}
                        style={{
                          gridTemplateColumns: "36px 1fr 140px 140px",
                          boxShadow: getRankGlow(p.competitive_tier) || getRankGlow(p.peak_tier),
                          borderLeft: p.party_color
                            ? `3px solid ${p.party_color}`
                            : p.puuid === localPuuid
                              ? "3px solid #ef4444"
                              : "3px solid transparent",
                        }}
                      >
                      {/* Agent icon */}
                      {p.agent_icon ? (
                        <img src={p.agent_icon} alt={p.agent_name} className="w-9 h-9 object-cover" />
                      ) : (
                        <div className="w-9 h-9 bg-gray-800" />
                      )}

                      {/* Player name */}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-bold text-white truncate">{p.game_name}</span>
                          {p.tag_line && <span className="text-xs text-gray-500">#{p.tag_line}</span>}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-gray-500 uppercase tracking-wide">{p.agent_name}</span>
                          {p.account_level != null && p.account_level > 0 && (
                            <span className="text-xs text-gray-600">Lvl {p.account_level}</span>
                          )}
                        </div>
                      </div>

                      {/* Current rank */}
                      <div className="flex items-center gap-1.5">
                        {(p.competitive_tier ?? 0) > 0 && p.rank_icon && (
                          <img src={p.rank_icon} alt="" className="w-5 h-5 object-contain" />
                        )}
                        <RankBadge tier={p.competitive_tier} />
                      </div>

                      {/* Peak rank */}
                      <div className="flex items-center gap-1.5">
                        {p.peak_tier > 0 && p.peak_rank_icon && (
                          <img src={p.peak_rank_icon} alt="" className="w-5 h-5 object-contain" />
                        )}
                        {p.peak_tier > 0 && p.peak_tier !== p.competitive_tier && (
                          <span style={{ color: RANK_COLORS[p.peak_tier] ?? "#9ca3af" }} className="text-xs font-bold uppercase tracking-wider">
                            {RANK_NAMES[p.peak_tier]}
                          </span>
                        )}
                        {p.peak_tier === 0 && (
                          <span className="text-xs text-gray-600">—</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
            </div>
          </div>
        )}

        {/* Online Friends */}
        {players.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Online</span>
              <div className="flex-1 h-px bg-gray-800" />
              <span className="text-xs text-gray-600">{players.length} online</span>
            </div>
            <div className="space-y-1">
              {players.map((p) => {
                const glow = getRankGlow(p.competitive_tier);
                const partyColor = getPartyColor(p.party_id, players);
                return (
                  <div
                    key={p.puuid}
                    className="flex items-center gap-4 px-4 py-3 bg-gray-900 hover:bg-gray-800 transition-all"
                    style={{ boxShadow: glow, borderLeft: partyColor ? `2px solid ${partyColor}` : "2px solid transparent" }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white truncate">{p.game_name}</span>
                        {p.game_tag && (
                          <span className="text-xs text-gray-500">#{p.game_tag}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {(p.competitive_tier ?? 0) > 0 && p.rank_icon && (
                          <img src={p.rank_icon} alt="" className="w-4 h-4 object-contain" />
                        )}
                        <RankBadge tier={p.competitive_tier} />
                        {p.account_level && (
                          <span className="text-xs text-gray-600">Lvl {p.account_level}</span>
                        )}
                      </div>
                    </div>
                    {p.session_state && (
                      <span className="text-xs uppercase tracking-wider text-gray-500">
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
