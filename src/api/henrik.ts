import type { MmrEntry } from "../types";

/** Shared in-flight match MMR snapshot (match id + per-PUUID entries). */
export const cachedMMR: {
  current: { matchId: string; data: Record<string, MmrEntry> } | null;
} = { current: null };
let mmrByPuuid: Record<string, MmrEntry> = {};
let mmrFetchByPuuid = new Map<string, Promise<MmrEntry>>();

// Shared Henrik rate-limit queue: one request every 2100ms across all endpoints
let henrikQueuePromise: Promise<void> = Promise.resolve();

export function henrikFetch(url: string, apiKey: string): Promise<Response> {
  const result = henrikQueuePromise
    .then(() => new Promise<void>((r) => setTimeout(r, 2100)))
    .then(() => fetch(url, { headers: { Authorization: apiKey } }));
  henrikQueuePromise = result.then(
    () => {},
    () => {},
  );
  return result;
}

export const resolvedAccountLevels: Record<string, number> = {};
/** One in-flight Henrik account request per PUUID so overlapping polls do not duplicate fetches. */
const accountLevelFetchByPuuid = new Map<string, Promise<number | undefined>>();

const resolvedIncognitoNames: Record<string, { game_name: string; tag_line: string }> = {};

export async function mergeIncognitoNamesFromHenrik(
  candidatePuuids: string[],
  nameMap: Record<string, { game_name: string; tag_line: string }>,
  region: string,
  henrikApiKey: string,
) {
  for (const emptyPuuid of candidatePuuids.filter((id) => !nameMap[id]?.game_name)) {
    if (resolvedIncognitoNames[emptyPuuid]) {
      nameMap[emptyPuuid] = resolvedIncognitoNames[emptyPuuid];
      continue;
    }
    try {
      const histRes = await henrikFetch(
        `https://api.henrikdev.xyz/valorant/v1/by-puuid/lifetime/matches/${region}/${emptyPuuid}?size=1`,
        henrikApiKey,
      );
      const histData = await histRes.json();
      const histPlayer = histData?.data?.[0]?.stats;
      if (histPlayer?.puuid === emptyPuuid && histPlayer?.name) {
        const resolved = { game_name: histPlayer.name, tag_line: histPlayer.tag ?? "" };
        resolvedIncognitoNames[emptyPuuid] = resolved;
        nameMap[emptyPuuid] = resolved;
      }
    } catch {}
  }
}

export async function fetchHenrikMmrForPlayer(
  puuid: string,
  region: string,
  henrikApiKey: string,
  rankMap: Record<number, string>,
): Promise<MmrEntry> {
  const hit = mmrByPuuid[puuid];
  if (hit) return hit;

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
        return entry;
      }

      if (!res.ok) {
        console.warn(`Henrik MMR ${res.status} for ${puuid}`);
        return emptyEntry();
      }

      const data = await res.json();
      const current = data?.data?.current?.tier?.id ?? 0;
      const peak = data?.data?.peak?.tier?.id ?? 0;
      const entry: MmrEntry = {
        competitive_tier: current,
        peak_tier: peak,
        rank_icon: rankMap[current] ?? null,
        peak_rank_icon: rankMap[peak] ?? null,
      };
      mmrByPuuid[puuid] = entry;
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

/** Clears Henrik-side caches when returning to menus (matches in-hook party resets). */
export function resetHenrikLobbyCaches(): void {
  mmrByPuuid = {};
  mmrFetchByPuuid.clear();
  for (const k of Object.keys(resolvedIncognitoNames)) delete resolvedIncognitoNames[k];
  for (const k of Object.keys(resolvedAccountLevels)) delete resolvedAccountLevels[k];
  accountLevelFetchByPuuid.clear();
}
