import { invoke } from "@tauri-apps/api/core";
import type { MmrDiskCacheEntry, MmrEntry, PersonalStats, PlayerMatchStats } from "../types";

const MMR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Recent-match aggregates (kept for type compatibility; no longer populated). */
export const playerStatsCache = new Map<string, PlayerMatchStats>();

let diskMmrCache: Record<string, MmrDiskCacheEntry> = {};
let diskMmrCacheLoaded = false;

/** Missing / blank tier name while ranked, or unranked row with no label — drop so Henrik is hit again. */
function diskMmrEntryInvalid(entry: MmrDiskCacheEntry | undefined): boolean {
  if (!entry || typeof entry !== "object") return true;

  // noData entries are valid -- Henrik has no data for this player; let TTL handle expiry
  if (entry.noData === true) return false;

  const tn =
    entry.tierName === undefined || entry.tierName === null ? "" : String(entry.tierName).trim();
  const tier = Number(entry.tier) || 0;

  // Unranked players legitimately have no tier name or peak season
  if (tier === 0) return false;

  // Ranked player must have a tier name
  if (tn === "") return true;

  // Only invalidate ranked players missing peakSeasonShort
  if (tier > 0 && !entry.peakSeasonShort) return true;

  return false;
}

export async function initMmrDiskCache(): Promise<void> {
  try {
    if (diskMmrCacheLoaded) return;
    try {
      const data = await invoke<Record<string, MmrDiskCacheEntry>>("load_mmr_cache");
      diskMmrCache = data && typeof data === "object" ? data : {};
    } catch {
      diskMmrCache = {};
    }
    let removed = false;
    for (const id of Object.keys(diskMmrCache)) {
      if (diskMmrEntryInvalid(diskMmrCache[id])) {
        delete diskMmrCache[id];
        removed = true;
      }
    }
    if (removed) void persistMmrCache();
    diskMmrCacheLoaded = true;
  } catch {
    diskMmrCache = {};
    diskMmrCacheLoaded = true;
  }
}

async function persistMmrCache(): Promise<void> {
  try {
    await invoke("save_mmr_cache", { entries: diskMmrCache });
  } catch (e) {
    console.warn("save_mmr_cache failed", e);
  }
}

function diskEntryToMmr(entry: MmrDiskCacheEntry, rankMap: Record<number, string>): MmrEntry {
  return {
    competitive_tier: entry.tier,
    peak_tier: entry.peakTier,
    rank_icon: rankMap[entry.tier] ?? null,
    peak_rank_icon: rankMap[entry.peakTier] ?? null,
    ...(entry.peakSeasonShort ? { peakSeasonShort: entry.peakSeasonShort } : {}),
    ...(entry.actGames != null ? { actWins: entry.actWins, actLosses: entry.actLosses, actGames: entry.actGames } : {}),
  };
}

function mmrResponseToDiskEntry(data: unknown): MmrDiskCacheEntry {
  const root = data as {
    data?: {
      current?: { tier?: { id?: number; name?: string }; ranking_in_tier?: number; rr?: number };
      peak?: { tier?: { id?: number; name?: string } };
    };
  };
  const currentTier = root?.data?.current?.tier;
  const peakTierObj = root?.data?.peak?.tier;
  const tier = Number(currentTier?.id ?? 0) || 0;
  const peakTier = Number(peakTierObj?.id ?? 0) || 0;
  const rrRaw = root?.data?.current?.ranking_in_tier ?? root?.data?.current?.rr ?? 0;
  const d = ((root?.data ?? data) as Record<string, unknown>) ?? {};
  const peakSeasonShort = extractPeakSeasonShort(d);
  const { actWins, actLosses, actGames } = extractActWinsLossesFromMmrData(d);
  return {
    tier,
    tierName: String(currentTier?.name ?? ""),
    rr: Number(rrRaw) || 0,
    peakTier,
    peakTierName: String(peakTierObj?.name ?? ""),
    ...(peakSeasonShort ? { peakSeasonShort } : {}),
    ...(actGames > 0 ? { actWins, actLosses, actGames } : {}),
    fetchedAt: Date.now(),
  };
}

/** Shared in-flight match MMR snapshot (match id + per-PUUID entries). */
export const cachedMMR: {
  current: { matchId: string; data: Record<string, MmrEntry> } | null;
} = { current: null };
let mmrByPuuid: Record<string, MmrEntry> = {};
let mmrFetchByPuuid = new Map<string, Promise<MmrEntry>>();
const MMR_429_RETRY_MS = 65_000;
const HENRIK_REQUEST_GAP_MS = 3500;

/** PUUIDs that hit MMR 429; flushed together after {@link MMR_429_RETRY_MS}. */
const mmrRetryQueue = new Set<string>();
const mmrRetryMetaByPuuid = new Map<
  string,
  {
    region: string;
    henrikApiKey: string;
    rankMap: Record<number, string>;
    onResolved?: (puuid: string, entry: MmrEntry) => void;
  }
>();
let mmr429BatchFlushTimeout: ReturnType<typeof setTimeout> | null = null;

function scheduleMmr429BatchFlush(): void {
  if (mmr429BatchFlushTimeout != null) return;
  mmr429BatchFlushTimeout = setTimeout(() => {
    mmr429BatchFlushTimeout = null;
    const puuids = [...mmrRetryQueue];
    mmrRetryQueue.clear();
    for (const id of puuids) {
      const meta = mmrRetryMetaByPuuid.get(id);
      mmrRetryMetaByPuuid.delete(id);
      if (!meta) continue;
      void fetchHenrikMmrForPlayerImpl(
        id,
        meta.region,
        meta.henrikApiKey,
        meta.rankMap,
        meta.onResolved,
        true,
      );
    }
  }, MMR_429_RETRY_MS);
}

// MMR, account-level, and recent-stats Henrik calls each use independent 2100ms-spaced queues.
// Single unified Henrik request queue -- one request at a time globally
let henrikQueuePromise: Promise<void> = Promise.resolve();

/** All Henrik API calls share one queue so MMR, account, and stats never compete. */
export function henrikFetch(url: string, apiKey: string): Promise<Response> {
  const result = henrikQueuePromise
    .then(() => new Promise<void>((r) => setTimeout(r, HENRIK_REQUEST_GAP_MS)))
    .then(() => fetch(url, { headers: { Authorization: apiKey } }));
  henrikQueuePromise = result.then(() => {}, () => {});
  return result;
}

export const resolvedAccountLevels: Record<string, number> = {};
/** One in-flight Henrik account request per PUUID so overlapping polls do not duplicate fetches. */
const accountLevelFetchByPuuid = new Map<string, Promise<number | undefined>>();

const resolvedIncognitoNames: Record<string, { game_name: string; tag_line: string }> = {};

// Separate queue for incognito name resolution so it never blocks behind MMR fetches
let incognitoQueuePromise: Promise<void> = Promise.resolve();

function henrikFetchIncognito(url: string, apiKey: string): Promise<Response> {
  const result = incognitoQueuePromise
    .then(() => new Promise<void>((r) => setTimeout(r, 1000)))
    .then(() => fetch(url, { headers: { Authorization: apiKey } }));
  incognitoQueuePromise = result.then(() => {}, () => {});
  return result;
}

export async function mergeIncognitoNamesFromHenrik(
  candidatePuuids: string[],
  nameMap: Record<string, { game_name: string; tag_line: string }>,
  _region: string,
  henrikApiKey: string,
) {
  for (const emptyPuuid of candidatePuuids.filter((id) => !nameMap[id]?.game_name)) {
    if (emptyPuuid in resolvedIncognitoNames) {
      if (resolvedIncognitoNames[emptyPuuid].game_name) {
        nameMap[emptyPuuid] = resolvedIncognitoNames[emptyPuuid];
      }
      continue;
    }
    try {
      const acctRes = await henrikFetchIncognito(
        `https://api.henrikdev.xyz/valorant/v1/by-puuid/account/${emptyPuuid}?force=true`,
        henrikApiKey,
      );
      const acctData = await acctRes.json();
      const acctPlayer = acctData?.data;
      if (acctPlayer?.name) {
        const resolved = { game_name: acctPlayer.name, tag_line: acctPlayer.tag ?? "" };
        resolvedIncognitoNames[emptyPuuid] = resolved;
        nameMap[emptyPuuid] = resolved;
      }
    } catch {}
    if (!resolvedIncognitoNames[emptyPuuid]) {
      resolvedIncognitoNames[emptyPuuid] = { game_name: "", tag_line: "" };
    }
  }
}

async function fetchHenrikMmrForPlayerImpl(
  puuid: string,
  region: string,
  henrikApiKey: string,
  rankMap: Record<number, string>,
  onResolved: ((puuid: string, entry: MmrEntry) => void) | undefined,
  isScheduled429Retry: boolean,
): Promise<MmrEntry> {
  if (!henrikApiKey.trim()) {
    return {
      competitive_tier: 0,
      peak_tier: 0,
      rank_icon: null,
      peak_rank_icon: null,
    };
  }

  await initMmrDiskCache();

  const maybeNotifyRetrySuccess = (entry: MmrEntry) => {
    if (isScheduled429Retry) onResolved?.(puuid, entry);
  };

  const hit = mmrByPuuid[puuid];
  if (hit) {
    maybeNotifyRetrySuccess(hit);
    return hit;
  }

  const disk = diskMmrCache[puuid];
  if (disk && Date.now() - disk.fetchedAt < MMR_CACHE_TTL_MS) {
    if (diskMmrEntryInvalid(disk)) {
      delete diskMmrCache[puuid];
      void persistMmrCache();
    } else {
      const entry = diskEntryToMmr(disk, rankMap);
      mmrByPuuid[puuid] = entry;
      maybeNotifyRetrySuccess(entry);
      return entry;
    }
  }

  const inflight = mmrFetchByPuuid.get(puuid);
  if (inflight) return inflight;

  const emptyEntry = (): MmrEntry => ({
    competitive_tier: 0,
    peak_tier: 0,
    rank_icon: null,
    peak_rank_icon: null,
  });

  const promise = (async () => {
    try {
      const res = await henrikFetch(
        `https://api.henrikdev.xyz/valorant/v3/by-puuid/mmr/${region}/pc/${puuid}`,
        henrikApiKey,
      );

      if (res.status === 404) {
        const entry = emptyEntry();
        mmrByPuuid[puuid] = entry;
        diskMmrCache[puuid] = {
          tier: 0,
          tierName: "",
          rr: 0,
          peakTier: 0,
          peakTierName: "",
          noData: true,
          fetchedAt: Date.now(),
        };
        await persistMmrCache();
        maybeNotifyRetrySuccess(entry);
        return entry;
      }

      if (res.status === 429) {
        console.warn(`Henrik MMR 429 for ${puuid}, retry in ${MMR_429_RETRY_MS / 1000}s`);
        mmrRetryQueue.add(puuid);
        mmrRetryMetaByPuuid.set(puuid, { region, henrikApiKey, rankMap, onResolved });
        scheduleMmr429BatchFlush();
        return emptyEntry();
      }

      if (!res.ok) {
        console.warn(`Henrik MMR ${res.status} for ${puuid}`);
        return emptyEntry();
      }

      const data = await res.json();
      // Safety net 2: validate response shape before accessing any fields
      const dataObj = data as { data?: unknown } | null;
      if (!dataObj || (dataObj.data !== undefined && (dataObj.data === null || typeof dataObj.data !== "object"))) {
        console.warn(`Henrik MMR unexpected shape for ${puuid.slice(0, 8)}:`, typeof dataObj?.data);
        return emptyEntry();
      }
      diskMmrCache[puuid] = mmrResponseToDiskEntry(data);
      await persistMmrCache();

      const extracted = extractHenrikMmrCurrentPeak(data);
      const entry: MmrEntry = {
        competitive_tier: extracted.currentTier,
        peak_tier: extracted.peakTier,
        rank_icon: rankMap[extracted.currentTier] ?? null,
        peak_rank_icon: rankMap[extracted.peakTier] ?? null,
        ...(extracted.peakSeasonShort ? { peakSeasonShort: extracted.peakSeasonShort } : {}),
        actWins: extracted.actWins,
        actLosses: extracted.actLosses,
        actGames: extracted.actGames,
      };
      mmrByPuuid[puuid] = entry;
      maybeNotifyRetrySuccess(entry);
      return entry;
    } catch {
      return emptyEntry();
    } finally {
      mmrFetchByPuuid.delete(puuid);
    }
  })();

  mmrFetchByPuuid.set(puuid, promise);
  return promise;
}

export async function fetchHenrikMmrForPlayer(
  puuid: string,
  region: string,
  henrikApiKey: string,
  rankMap: Record<number, string>,
  onResolved?: (puuid: string, entry: MmrEntry) => void,
): Promise<MmrEntry> {
  return fetchHenrikMmrForPlayerImpl(puuid, region, henrikApiKey, rankMap, onResolved, false);
}

export function identityAccountLevelValue(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

export async function fetchHenrikAccountLevel(puuid: string, henrikApiKey: string): Promise<number | undefined> {
  if (!henrikApiKey.trim()) return undefined;

  const hit = resolvedAccountLevels[puuid];
  if (hit != null) return hit > 0 ? hit : undefined;

  let inflight = accountLevelFetchByPuuid.get(puuid);
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await henrikFetch(
          `https://api.henrikdev.xyz/valorant/v1/by-puuid/account/${puuid}`,
          henrikApiKey,
        );
        if (!res.ok) {
          resolvedAccountLevels[puuid] = -1;
          return undefined;
        }
        const data = await res.json();
        const level = data?.data?.account_level ?? 0;
        if (level > 0) {
          resolvedAccountLevels[puuid] = level;
          return level;
        }
        resolvedAccountLevels[puuid] = -1;
      } catch {
        resolvedAccountLevels[puuid] = -1;
      }
      return undefined;
    })();
    accountLevelFetchByPuuid.set(puuid, inflight);
    void inflight.finally(() => {
      accountLevelFetchByPuuid.delete(puuid);
    });
  }
  return inflight;
}

function dominantSeasonId(matches: ReadonlyArray<{ metadata?: { season_id?: string } }>): string | null {
  const counts = new Map<string, number>();
  for (const m of matches) {
    const sid = m.metadata?.season_id;
    if (sid == null || sid === "") continue;
    const key = String(sid);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

/** Henrik v3 `/matches/{shard}` expects shard (e.g. br/br1 → na), not Riot routing codes. */
export function henrikMatchHistoryShard(region: string): string {
  const shardMap: Record<string, string> = {
    na: "na",
    br: "na",
    br1: "na",
    latam: "na",
    la: "na",
    la1: "na",
    la2: "na",
    sa: "na",
    sa2: "na",
    eu: "eu",
    ap: "ap",
    kr: "kr",
  };
  const lower = region.toLowerCase();
  const mapped = shardMap[lower];
  if (mapped != null) return mapped;
  const stripped = lower.replace(/\d+$/, "");
  if (stripped !== lower) {
    const retry = shardMap[stripped];
    if (retry != null) return retry;
  }
  return lower;
}

function extractActWinsLossesFromMmrData(d: Record<string, unknown>): {
  actWins: number;
  actLosses: number;
  actGames: number;
} {
  // v3: data.seasonal is an array ordered chronologically — use the last entry
  const seasonal = d.seasonal;
  if (Array.isArray(seasonal) && seasonal.length > 0) {
    const last = seasonal[seasonal.length - 1] as Record<string, unknown>;
    const wins = Number(last.wins ?? 0) || 0;
    const games = Number(last.games ?? 0) || 0;
    if (games > 0) {
      return { actWins: wins, actLosses: Math.max(0, games - wins), actGames: games };
    }
  }

  // v2: data.by_season keyed by season short — pick the alphabetically last key with games
  const bySeason = d.by_season;
  if (bySeason && typeof bySeason === "object" && !Array.isArray(bySeason)) {
    const keys = Object.keys(bySeason as object).sort();
    for (let i = keys.length - 1; i >= 0; i--) {
      const entry = (bySeason as Record<string, unknown>)[keys[i]] as Record<string, unknown> | undefined;
      if (!entry) continue;
      const wins = Number(entry.wins ?? 0) || 0;
      const games = Number(entry.number_of_games ?? 0) || 0;
      if (games > 0) {
        return { actWins: wins, actLosses: Math.max(0, games - wins), actGames: games };
      }
    }
  }

  // Safety net 3: data.wins_by_season fallback (some Henrik API versions)
  const winsBySeason = d.wins_by_season;
  if (winsBySeason && typeof winsBySeason === "object" && !Array.isArray(winsBySeason)) {
    const keys = Object.keys(winsBySeason as object).sort();
    for (let i = keys.length - 1; i >= 0; i--) {
      const entry = (winsBySeason as Record<string, unknown>)[keys[i]] as Record<string, unknown> | undefined;
      if (!entry) continue;
      const wins = Number(entry.wins ?? 0) || 0;
      const games = Number(entry.games ?? entry.number_of_games ?? 0) || 0;
      if (games > 0) {
        return { actWins: wins, actLosses: Math.max(0, games - wins), actGames: games };
      }
    }
  }

  return { actWins: 0, actLosses: 0, actGames: 0 };
}

function extractPeakSeasonShort(d: Record<string, unknown>): string {
  // data.peak.season (v3: string or { short })
  const peakObj = (d.peak ?? {}) as Record<string, unknown>;
  const peakSeason = peakObj.season as Record<string, unknown> | string | undefined;
  if (typeof peakSeason === "string" && peakSeason.trim()) {
    return peakSeason.trim().toLowerCase();
  }
  if (peakSeason && typeof peakSeason === "object" && peakSeason.short) {
    return String(peakSeason.short).trim().toLowerCase();
  }

  // data.highest_season.season
  const hs = (d.highest_season ?? {}) as Record<string, unknown>;
  if (typeof hs.season === "string" && hs.season.trim()) {
    return String(hs.season).trim().toLowerCase();
  }
  const hsSeason = hs.season as Record<string, unknown> | undefined;
  if (hsSeason?.short) return String(hsSeason.short).trim().toLowerCase();

  // data.highest_rank.season (v2 format: "e7a3")
  const hr = d.highest_rank as Record<string, unknown> | undefined;
  if (hr) {
    if (typeof hr.season === "string" && hr.season.trim()) {
      return String(hr.season).trim().toLowerCase();
    }
    const hrSeason = hr.season as Record<string, unknown> | undefined;
    if (hrSeason?.short) return String(hrSeason.short).trim().toLowerCase();
  }

  // data.by_season — key with highest tier value
  const bySeason = d.by_season as Record<string, unknown> | undefined;
  if (bySeason && typeof bySeason === "object") {
    let bestSeasonKey = "";
    let bestTier = 0;
    for (const [key, val] of Object.entries(bySeason)) {
      if (!val || typeof val !== "object") continue;
      const entry = val as Record<string, unknown>;
      const tier = Number(entry.tier ?? entry.peak_rank ?? 0) || 0;
      if (tier > bestTier) {
        bestTier = tier;
        bestSeasonKey = key;
      }
    }
    if (bestSeasonKey) return bestSeasonKey.toLowerCase();
  }

  return "";
}

function firstRankingInTierGreaterThanZero(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (c == null || c === "") continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function extractRankingInTierFromMmrData(d: Record<string, unknown>): number {
  const current = (d.current ?? {}) as Record<string, unknown>;
  const currentData = (d.current_data ?? {}) as Record<string, unknown>;
  return firstRankingInTierGreaterThanZero(
    current.rr,
    currentData.ranking_in_tier,
    current.ranking_in_tier,
    d.ranking_in_tier,
  );
}

function extractCurrentTierFromMmrData(d: Record<string, unknown>): {
  currentTier: number;
  currentTierName: string;
} {
  const current = (d.current ?? {}) as Record<string, unknown>;
  const currentData = (d.current_data ?? {}) as Record<string, unknown>;
  const currentTierObj = current.tier as Record<string, unknown> | undefined;

  let currentTier = 0;
  if (currentTierObj?.id != null) {
    currentTier = Number(currentTierObj.id) || 0;
  }
  if (!currentTier && currentData.currenttier != null) {
    currentTier = Number(currentData.currenttier) || 0;
  }
  if (!currentTier && d.currenttier != null) {
    currentTier = Number(d.currenttier) || 0;
  }
  if (!currentTier) {
    const tierObj = currentData.tier as Record<string, unknown> | undefined;
    currentTier = Number(tierObj?.id ?? currentData.tier ?? 0) || 0;
  }
  // Safety net 4: elo back-calculation when all direct paths fail
  if (!currentTier && d.mmr_change_to_last_game != null && d.elo != null) {
    const eloTier = Math.floor(Number(d.elo) / 100);
    if (Number.isFinite(eloTier)) {
      currentTier = Math.min(27, Math.max(0, eloTier));
    }
  }

  let currentTierName = "";
  if (currentTierObj?.name) {
    currentTierName = String(currentTierObj.name).trim();
  }
  if (!currentTierName && currentData.currenttierpatched) {
    currentTierName = String(currentData.currenttierpatched).trim();
  }
  if (!currentTierName && currentData.currenttier_patched) {
    currentTierName = String(currentData.currenttier_patched).trim();
  }
  if (!currentTierName && d.currenttierpatched) {
    currentTierName = String(d.currenttierpatched).trim();
  }
  if (!currentTierName && d.currenttier_patched) {
    currentTierName = String(d.currenttier_patched).trim();
  }

  return { currentTier, currentTierName };
}

function extractHenrikMmrCurrentPeak(mmrJson: unknown): {
  currentTier: number;
  currentTierName: string;
  rankingInTier: number;
  peakTier: number;
  peakTierName: string;
  peakSeasonShort: string;
  actWins: number;
  actLosses: number;
  actGames: number;
} {
  const root = mmrJson as {
    data?: Record<string, unknown>;
  };
  const d = (root?.data ?? mmrJson) as Record<string, unknown>;
  const { currentTier, currentTierName } = extractCurrentTierFromMmrData(d);
  const rankingInTier = extractRankingInTierFromMmrData(d);

  const hs = (d.highest_season ?? d.peak ?? {}) as Record<string, unknown>;
  const hsTier = hs.tier as Record<string, unknown> | undefined;
  const peakObj = (d.peak ?? {}) as Record<string, unknown>;
  const peakTierObj = peakObj.tier as Record<string, unknown> | undefined;

  const peakTier =
    Number(hsTier?.id ?? hs.tier_id ?? hs.tier ?? peakTierObj?.id ?? peakObj.tier ?? 0) ||
    0;
  const peakTierName = String(
    hs.tierpatched ?? hs.tier_patched ?? hsTier?.name ?? peakTierObj?.name ?? "",
  ).trim();

  const peakSeasonShort = extractPeakSeasonShort(d);
  const { actWins, actLosses, actGames } = extractActWinsLossesFromMmrData(d);

  return {
    currentTier,
    currentTierName,
    rankingInTier,
    peakTier,
    peakTierName,
    peakSeasonShort,
    actWins,
    actLosses,
    actGames,
  };
}

function aggregatePersonalCompetitiveMatches(
  matches: unknown[],
  selfPuuid: string,
): {
  actWins: number;
  actLosses: number;
  actMatches: number;
  kda: number;
  headshotPct: number;
} {
  const competitiveMatches = matches.filter((m) => {
    const meta = (m as { metadata?: { mode_id?: unknown; mode?: unknown } }).metadata;
    return meta?.mode_id === "competitive" || meta?.mode === "Competitive";
  });
  if (competitiveMatches.length === 0) {
    return { actWins: 0, actLosses: 0, actMatches: 0, kda: 0, headshotPct: 0 };
  }

  const dominant = dominantSeasonId(
    competitiveMatches as { metadata?: { season_id?: string } }[],
  );
  const filtered =
    dominant != null
      ? competitiveMatches.filter(
          (m) =>
            String((m as { metadata?: { season_id?: unknown } }).metadata?.season_id ?? "") ===
            dominant,
        )
      : competitiveMatches;

  if (filtered.length === 0) {
    return { actWins: 0, actLosses: 0, actMatches: 0, kda: 0, headshotPct: 0 };
  }

  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let wins = 0;
  let matchesPlayed = 0;
  let hsPctSum = 0;
  let hsPctMatches = 0;

  for (const raw of filtered) {
    const m = raw as {
      players?: { all_players?: Array<{ puuid?: string; team?: string; stats?: Record<string, unknown> }> };
      teams?: {
        red?: { has_won?: boolean };
        blue?: { has_won?: boolean };
      };
    };
    const all = m.players?.all_players ?? [];
    const pl = all.find((p) => p.puuid === selfPuuid);
    if (!pl) continue;

    const st = (pl.stats ?? pl) as Record<string, unknown>;
    const k = Number(st?.kills ?? 0);
    const d = Number(st?.deaths ?? 0);
    const a = Number(st?.assists ?? 0);
    if (![k, d, a].every((n) => Number.isFinite(n))) continue;

    matchesPlayed++;
    kills += k;
    deaths += d;
    assists += a;

    const team = String(pl.team ?? "").toLowerCase();
    const won =
      (team === "red" && m.teams?.red?.has_won === true) ||
      (team === "blue" && m.teams?.blue?.has_won === true);
    if (won) wins++;

    const head = Number(st.headshots ?? 0);
    const body = Number(st.bodyshots ?? 0);
    const leg = Number(st.legshots ?? 0);
    const shotDenom = head + body + leg;
    if (shotDenom > 0 && [head, body, leg].every((n) => Number.isFinite(n))) {
      hsPctSum += (head / shotDenom) * 100;
      hsPctMatches += 1;
    }
  }

  if (matchesPlayed === 0) {
    return { actWins: 0, actLosses: 0, actMatches: 0, kda: 0, headshotPct: 0 };
  }

  const kda = (kills + assists) / Math.max(deaths, 1);
  const headshotPct = hsPctMatches > 0 ? Math.round((hsPctSum / hsPctMatches) * 10) / 10 : 0;

  return {
    actWins: wins,
    actLosses: matchesPlayed - wins,
    actMatches: matchesPlayed,
    kda,
    headshotPct,
  };
}

const PERSONAL_STATS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Cached baseline {@link PersonalStats} (session fields are always zero in cache). */
let personalStatsCache: {
  key: string;
  stats: PersonalStats;
  fetchedAt: number;
} | null = null;

function personalStatsCacheKey(puuid: string, region: string): string {
  return `${puuid}:${region}`;
}

let valorantRankSmallIconsByTier: Record<number, string> | null = null;

/** Small rank icons from api.valorant-api.com (shared UI helper). */
export async function fetchValorantRankSmallIconsByTier(): Promise<Record<number, string>> {
  if (valorantRankSmallIconsByTier) return valorantRankSmallIconsByTier;
  const res = await fetch("https://valorant-api.com/v1/competitivetiers");
  if (!res.ok) return {};
  const data = await res.json();
  const latest = data.data[data.data.length - 1];
  const map: Record<number, string> = {};
  for (const tier of latest.tiers) {
    map[tier.tier] = tier.smallIcon ?? tier.largeIcon ?? "";
  }
  valorantRankSmallIconsByTier = map;
  return map;
}

export async function fetchPersonalStats(
  puuid: string,
  name: string,
  tag: string,
  region: string,
  henrikApiKey: string,
  options?: { bypassCache?: boolean },
): Promise<PersonalStats | null> {
  if (!henrikApiKey.trim() || !puuid.trim()) return null;

  const cacheKey = personalStatsCacheKey(puuid, region);
  const now = Date.now();
  if (
    !options?.bypassCache &&
    personalStatsCache &&
    personalStatsCache.key === cacheKey &&
    now - personalStatsCache.fetchedAt < PERSONAL_STATS_CACHE_TTL_MS
  ) {
    return { ...personalStatsCache.stats };
  }

  const shard = henrikMatchHistoryShard(region);

  try {
    const mmrUrl = `https://api.henrikdev.xyz/valorant/v3/by-puuid/mmr/${shard}/pc/${puuid}`;
    const acctUrl = `https://api.henrikdev.xyz/valorant/v1/by-puuid/account/${puuid}`;
    const histUrl = `https://api.henrikdev.xyz/valorant/v3/by-puuid/matches/${shard}/pc/${puuid}?size=10`;

    const [mmrSettled, acctSettled, histSettled] = await Promise.allSettled([
      henrikFetch(mmrUrl, henrikApiKey),
      henrikFetch(acctUrl, henrikApiKey),
      henrikFetch(histUrl, henrikApiKey),
    ]);

    if (mmrSettled.status === "rejected") return null;
    const mmrRes = mmrSettled.value;
    if (!mmrRes.ok) return null;

    const mmrJson = await mmrRes.json();
    const mmrExtract = extractHenrikMmrCurrentPeak(mmrJson);

    let resolvedName = String(name ?? "").trim();
    let resolvedTag = String(tag ?? "").trim();
    let accountLevel = 0;
    let playerCardUrl = "";

    if (acctSettled.status === "fulfilled" && acctSettled.value.ok) {
      try {
        const acctJson = await acctSettled.value.json();
        const acctRoot = acctJson as { data?: Record<string, unknown> };
        const acct = acctRoot?.data ?? {};
        resolvedName = String(acct.name ?? name ?? "").trim();
        resolvedTag = String(acct.tag ?? tag ?? "").trim();
        accountLevel = Number(acct.account_level ?? 0) || 0;
        const wideRaw =
          acct.card && typeof acct.card === "object" ? (acct.card as { wide?: string }).wide : "";
        const wide = typeof wideRaw === "string" ? wideRaw : "";
        if (wide.startsWith("http")) playerCardUrl = wide;
        else if (wide.startsWith("/")) playerCardUrl = `https://media.valorant-api.com${wide}`;
        else if (wide) playerCardUrl = wide;
      } catch {
        // account parse failed — keep empty level/card defaults
      }
    }

    let agg = {
      actWins: 0,
      actLosses: 0,
      actMatches: 0,
      kda: 0,
      headshotPct: 0,
    };

    if (histSettled.status === "fulfilled" && histSettled.value.ok) {
      try {
        const histJson = await histSettled.value.json();
        const histRoot = histJson as { data?: unknown[] };
        const matchesRaw: unknown[] = Array.isArray(histRoot?.data) ? histRoot.data : [];
        agg = aggregatePersonalCompetitiveMatches(matchesRaw, puuid);
      } catch {
        // match history parse failed — keep zero act stats
      }
    }

    const stats: PersonalStats = {
      puuid,
      name: resolvedName || name || "Summoner",
      tag: resolvedTag || tag || "",
      accountLevel,
      currentTier: mmrExtract.currentTier,
      currentTierName:
        mmrExtract.currentTierName ||
        (mmrExtract.currentTier <= 0 ? "Unranked" : `Tier ${mmrExtract.currentTier}`),
      rankingInTier: mmrExtract.rankingInTier,
      peakTier: mmrExtract.peakTier,
      peakTierName:
        mmrExtract.peakTierName ||
        (mmrExtract.peakTier <= 0 ? "" : `Tier ${mmrExtract.peakTier}`),
      ...(mmrExtract.peakSeasonShort
        ? { peakSeasonShort: mmrExtract.peakSeasonShort }
        : {}),
      actWins: agg.actWins,
      actLosses: agg.actLosses,
      actMatches: agg.actMatches,
      kda: agg.kda,
      headshotPct: agg.headshotPct,
      sessionWins: 0,
      sessionLosses: 0,
      sessionKda: 0,
      sessionMatches: 0,
      playerCardUrl,
    };

    personalStatsCache = { key: cacheKey, stats: { ...stats }, fetchedAt: Date.now() };

    return stats;
  } catch {
    return null;
  }
}

export async function fetchPlayerRecentStats(
  _puuid: string,
  _region: string,
  _henrikApiKey: string,
): Promise<PlayerMatchStats | null> {
  // Disabled: match history 404s for almost all players and wastes Henrik rate
  // limit budget that MMR needs. W/L data now comes from MMR seasonal data.
  return null;
}

/** Clears Henrik-side caches when returning to menus (matches in-hook party resets). */
export function resetHenrikLobbyCaches(): void {
  if (mmr429BatchFlushTimeout != null) {
    clearTimeout(mmr429BatchFlushTimeout);
    mmr429BatchFlushTimeout = null;
  }
  henrikQueuePromise = Promise.resolve();
  mmrRetryQueue.clear();
  mmrRetryMetaByPuuid.clear();
  mmrByPuuid = {};
  mmrFetchByPuuid.clear();
  cachedMMR.current = null;
  for (const k of Object.keys(resolvedIncognitoNames)) delete resolvedIncognitoNames[k];
  for (const k of Object.keys(resolvedAccountLevels)) delete resolvedAccountLevels[k];
  accountLevelFetchByPuuid.clear();
}
