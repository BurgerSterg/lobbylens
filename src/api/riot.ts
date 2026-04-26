import { invoke } from "@tauri-apps/api/core";

export type AuthTokens = { accessToken: string; token: string };

export async function getLocalPlayer() {
  return invoke<{ puuid: string; region?: string }>("get_local_player");
}

export async function getAuthTokens() {
  return invoke<AuthTokens>("get_auth_tokens");
}

export async function getPresences() {
  return invoke<any[]>("get_presences");
}

export async function getPartyMembers(partyId: string, tokens: AuthTokens, region: string) {
  return invoke<any>("get_party_members", {
    partyId,
    accessToken: tokens.accessToken,
    entitlementsToken: tokens.token,
    region,
  });
}

export async function getPlayerNames(puuids: string[], tokens: AuthTokens, region: string) {
  return invoke<any[]>("get_player_names", {
    puuids,
    accessToken: tokens.accessToken,
    entitlementsToken: tokens.token,
    region,
  });
}

export async function getPregameMatchIdExternal(puuid: string, tokens: AuthTokens, region: string) {
  return invoke<string>("get_pregame_match_id_external", {
    puuid,
    accessToken: tokens.accessToken,
    entitlementsToken: tokens.token,
    region,
  });
}

export async function getPregameMatchExternal(matchId: string, tokens: AuthTokens, region: string) {
  return invoke<any>("get_pregame_match_external", {
    matchId,
    accessToken: tokens.accessToken,
    entitlementsToken: tokens.token,
    region,
  });
}

export async function getCoregameMatchIdExternal(puuid: string, tokens: AuthTokens, region: string) {
  return invoke<string>("get_coregame_match_id_external", {
    puuid,
    accessToken: tokens.accessToken,
    entitlementsToken: tokens.token,
    region,
  });
}

export async function getCoregameMatchExternal(matchId: string, tokens: AuthTokens, region: string) {
  return invoke<any>("get_coregame_match_external", {
    matchId,
    accessToken: tokens.accessToken,
    entitlementsToken: tokens.token,
    region,
  });
}
