import { invoke } from "@tauri-apps/api/core";

export interface LocalMmrResult {
  competitiveTier: number;
  rankedRating: number;
  actWins: number;
  actLosses: number;
  actGames: number;
}

const UNRANKED: LocalMmrResult = { competitiveTier: 0, rankedRating: 0, actWins: 0, actLosses: 0, actGames: 0 };

export async function fetchRiotMmrForPlayer(
  puuid: string,
  accessToken: string,
  entitlementsToken: string,
  region: string,
  clientVersion: string = "release-09.00-shipping-9-2459107",
): Promise<LocalMmrResult | null> {
  try {
    const data: any = await invoke("get_player_mmr", {
      puuid,
      accessToken,
      entitlementsToken,
      region,
      clientVersion,
    });

    // Stale client version or server error -- return unranked so it gets cached
    if (data?.httpStatus === 500 || data?.errorCode === "INTERNAL_UNHANDLED_SERVER_ERROR") {
      console.warn("[RiotMMR] 500 -- possible stale client version for", puuid.slice(0, 8));
      return { ...UNRANKED };
    }

    const competitive = data?.QueueSkills?.competitive;
    if (!competitive) {
      // Never played competitive -- valid unranked result
      return { ...UNRANKED };
    }

    const seasonalInfo: Record<string, any> = competitive.SeasonalInfoBySeasonID ?? {};
    const latestUpdate = data.LatestCompetitiveUpdate;

    let competitiveTier = 0;
    let rankedRating = 0;
    let currentSeasonId: string | null = null;

    // Primary: use LatestCompetitiveUpdate if it has a real tier
    if (latestUpdate?.TierAfterUpdate != null && (latestUpdate.TierAfterUpdate as number) > 0) {
      competitiveTier = latestUpdate.TierAfterUpdate as number;
      rankedRating = (latestUpdate.RankedRatingAfterUpdate as number) ?? 0;
      currentSeasonId = (latestUpdate.SeasonID as string) ?? null;
    } else {
      // Fallback: find the season with the most games played where CompetitiveTier > 0
      let mostGames = -1;
      for (const [seasonId, entry] of Object.entries(seasonalInfo)) {
        const tier = ((entry.CompetitiveTier ?? entry.Rank) ?? 0) as number;
        const games = (entry.NumberOfGames ?? 0) as number;
        if (tier > 0 && games > mostGames) {
          mostGames = games;
          competitiveTier = tier;
          rankedRating = (entry.RankedRating ?? 0) as number;
          currentSeasonId = seasonId;
        }
      }
    }

    // Get act stats for the resolved current season
    let actWins = 0;
    let actLosses = 0;
    let actGames = 0;
    if (currentSeasonId && seasonalInfo[currentSeasonId]) {
      const season = seasonalInfo[currentSeasonId];
      actWins = (season.NumberOfWins ?? 0) as number;
      actGames = (season.NumberOfGames ?? 0) as number;
      actLosses = Math.max(0, actGames - actWins);
    }

    return { competitiveTier, rankedRating, actWins, actLosses, actGames };
  } catch (e) {
    console.warn("[RiotMMR Error]", puuid.slice(0, 8), e);
    return null;
  }
}
