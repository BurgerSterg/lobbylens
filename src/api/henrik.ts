import { invoke } from "@tauri-apps/api/core";
import type { MmrDiskCacheEntry, MmrEntry, PlayerMatchStats } from "../types";

const MMR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYER_STATS_CACHE_TTL_MS = 10 * 60 * 1000;

/** Recent-match aggregates keyed by PUUID; refreshed every {@link PLAYER_STATS_CACHE_TTL_MS}. */
export const playerStatsCache = new Map<string, PlayerMatchStats>();
const playerStatsCachedAt = new Map<string, number>();

let diskMmrCache: Record<string, MmrDiskCacheEntry> = {};
let diskMmrCacheLoaded = false;

export async function initMmrDiskCache(): Promise<void> {
  if (diskMmrCacheLoaded) return;
  try {
    const data = await invoke<Record<string, MmrDiskCacheEntry>>("load_mmr_cache");
    diskMmrCache = data && typeof data === "object" ? data : {};
  } catch {
    diskMmrCache = {};
  }
  diskMmrCacheLoaded = true;
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
  return {
    tier,
    tierName: String(currentTier?.name ?? ""),
    rr: Number(rrRaw) || 0,
    peakTier,
    peakTierName: String(peakTierObj?.name ?? ""),
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
const HENRIK_REQUEST_GAP_MS = 2100;

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
let mmrQueuePromise: Promise<void> = Promise.resolve();
let accountQueuePromise: Promise<void> = Promise.resolve();
let statsQueuePromise: Promise<void> = Promise.resolve();

function henrikFetchMmr(url: string, apiKey: string): Promise<Response> {
  const result = mmrQueuePromise
    .then(() => new Promise<void>((r) => setTimeout(r, HENRIK_REQUEST_GAP_MS)))
    .then(() => fetch(url, { headers: { Authorization: apiKey } }));
  mmrQueuePromise = result.then(() => {}, () => {});
  return result;
}

function henrikFetchAccount(url: string, apiKey: string): Promise<Response> {
  const result = accountQueuePromise
    .then(() => new Promise<void>((r) => setTimeout(r, HENRIK_REQUEST_GAP_MS)))
    .then(() => fetch(url, { headers: { Authorization: apiKey } }));
  accountQueuePromise = result.then(() => {}, () => {});
  return result;
}

function henrikFetchStats(url: string, apiKey: string): Promise<Response> {
  const result = statsQueuePromise
    .then(() => new Promise<void>((r) => setTimeout(r, HENRIK_REQUEST_GAP_MS)))
    .then(() => fetch(url, { headers: { Authorization: apiKey } }));
  statsQueuePromise = result.then(() => {}, () => {});
  return result;
}

/** Match-history backfill / flush (shares spacing with account lookups only). */
export function henrikFetch(url: string, apiKey: string): Promise<Response> {
  return henrikFetchAccount(url, apiKey);
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
    const entry = diskEntryToMmr(disk, rankMap);
    mmrByPuuid[puuid] = entry;
    maybeNotifyRetrySuccess(entry);
    return entry;
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
      const res = await henrikFetchMmr(
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
      diskMmrCache[puuid] = mmrResponseToDiskEntry(data);
      await persistMmrCache();

      const current = data?.data?.current?.tier?.id ?? 0;
      const peak = data?.data?.peak?.tier?.id ?? 0;
      const entry: MmrEntry = {
        competitive_tier: current,
        peak_tier: peak,
        rank_icon: rankMap[current] ?? null,
        peak_rank_icon: rankMap[peak] ?? null,
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
  const hit = resolvedAccountLevels[puuid];
  if (hit != null) return hit > 0 ? hit : undefined;

  let inflight = accountLevelFetchByPuuid.get(puuid);
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await henrikFetchAccount(
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
    eu: "eu",
    ap: "ap",
    kr: "kr",
  };
  return shardMap[region.toLowerCase()] ?? region.toLowerCase();
}

export async function fetchPlayerRecentStats(
  puuid: string,
  region: string,
  henrikApiKey: string,
): Promise<PlayerMatchStats | null> {
  try {
    const cachedAt = playerStatsCachedAt.get(puuid);
    const cached = playerStatsCache.get(puuid);
    if (cached != null && cachedAt != null && Date.now() - cachedAt < PLAYER_STATS_CACHE_TTL_MS) {
      return cached;
    }

    const shard = henrikMatchHistoryShard(region);

    const res = await henrikFetchStats(
      `https://api.henrikdev.xyz/valorant/v3/by-puuid/matches/${shard}/pc/${puuid}?size=10`,
      henrikApiKey,
    );

    if (res.status === 404 || !res.ok) return null;

    const data = await res.json();
    const matches: unknown[] = Array.isArray(data?.data) ? data.data : [];
    if (matches.length === 0) return null;

    const competitiveMatches = matches.filter((m) => {
      const meta = (m as { metadata?: { mode_id?: unknown; mode?: unknown } }).metadata;
      return meta?.mode_id === "competitive" || meta?.mode === "Competitive";
    });
    if (competitiveMatches.length === 0) return null;

    const dominant = dominantSeasonId(competitiveMatches as { metadata?: { season_id?: string } }[]);
    const filtered =
      dominant != null
        ? competitiveMatches.filter(
            (m) =>
              String((m as { metadata?: { season_id?: unknown } }).metadata?.season_id ?? "") === dominant,
          )
        : competitiveMatches;

    if (filtered.length === 0) return null;

    let kills = 0;
    let deaths = 0;
    let assists = 0;
    let wins = 0;
    let matchesPlayed = 0;
    let scoreSum = 0;
    let roundsSum = 0;

    for (const raw of filtered) {
      const m = raw as {
        players?: { all_players?: Array<{ puuid?: string; team?: string; stats?: Record<string, unknown> }> };
        teams?: {
          red?: { has_won?: boolean; rounds_won?: number };
          blue?: { has_won?: boolean; rounds_won?: number };
        };
      };
      const all = m.players?.all_players ?? [];
      const pl = all.find((p) => p.puuid === puuid);
      if (!pl) continue;

      const st = (pl.stats ?? pl) as Record<string, unknown>;
      const k = Number(st?.kills ?? 0);
      const d = Number(st?.deaths ?? 0);
      const a = Number(st?.assists ?? 0);
      const score = Number(st?.score ?? 0);
      if (![k, d, a, score].every((n) => Number.isFinite(n))) continue;

      const rw = Number(m.teams?.red?.rounds_won ?? 0);
      const bw = Number(m.teams?.blue?.rounds_won ?? 0);
      const rounds = rw + bw;
      if (!Number.isFinite(rounds) || rounds <= 0) continue;

      matchesPlayed++;
      kills += k;
      deaths += d;
      assists += a;
      scoreSum += score;
      roundsSum += rounds;

      const team = String(pl.team ?? "").toLowerCase();
      const won =
        (team === "red" && m.teams?.red?.has_won === true) ||
        (team === "blue" && m.teams?.blue?.has_won === true);
      if (won) wins++;
    }

    if (matchesPlayed === 0) return null;

    const winRate = wins / matchesPlayed;
    const kda = (kills + assists) / Math.max(deaths, 1);
    const avgACS = roundsSum > 0 ? scoreSum / roundsSum : 0;

    const out: PlayerMatchStats = {
      puuid,
      kda,
      kills,
      deaths,
      assists,
      winRate,
      matchesPlayed,
      avgACS,
    };
    playerStatsCache.set(puuid, out);
    playerStatsCachedAt.set(puuid, Date.now());
    return out;
  } catch {
    return null;
  }
}

/** Clears Henrik-side caches when returning to menus (matches in-hook party resets). */
export function resetHenrikLobbyCaches(): void {
  if (mmr429BatchFlushTimeout != null) {
    clearTimeout(mmr429BatchFlushTimeout);
    mmr429BatchFlushTimeout = null;
  }
  mmrRetryQueue.clear();
  mmrRetryMetaByPuuid.clear();
  mmrByPuuid = {};
  mmrFetchByPuuid.clear();
  for (const k of Object.keys(resolvedIncognitoNames)) delete resolvedIncognitoNames[k];
  for (const k of Object.keys(resolvedAccountLevels)) delete resolvedAccountLevels[k];
  accountLevelFetchByPuuid.clear();
}
