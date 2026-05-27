use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::time::Duration;
use std::{fs, path::PathBuf};
use tokio::time::sleep;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Lockfile {
    port: u16,
    password: String,
    protocol: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlayerPresence {
    pub game_name: String,
    pub game_tag: String,
    pub puuid: String,
    pub account_level: Option<u32>,
    pub session_state: Option<String>,
    pub competitive_tier: Option<u32>,
    pub party_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MatchRecord {
    pub match_id: String,
    pub map: String,
    pub date: i64,
    pub won: bool,
    pub my_puuid: String,
    pub my_team: Vec<String>,
    pub enemy_team: Vec<String>,
    #[serde(default)]
    pub kills: Option<u32>,
    #[serde(default)]
    pub deaths: Option<u32>,
    #[serde(default)]
    pub assists: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MmrCacheEntry {
    pub tier: u32,
    pub tier_name: String,
    pub rr: i32,
    pub peak_tier: u32,
    pub peak_tier_name: String,
    pub fetched_at: i64,
}

fn try_parse_lockfile_once() -> Result<Lockfile, String> {
    let local = std::env::var("LOCALAPPDATA")
        .map_err(|_| "LOCALAPPDATA env var not found".to_string())?;

    let path = PathBuf::from(local)
        .join("Riot Games")
        .join("Riot Client")
        .join("Config")
        .join("lockfile");

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Couldn't read lockfile: {e}. Is Riot Client running?"))?;

    let parts: Vec<&str> = content.trim().split(':').collect();
    if parts.len() < 5 {
        return Err("Lockfile format unexpected".to_string());
    }

    Ok(Lockfile {
        port: parts[2].parse().map_err(|_| "Bad port in lockfile".to_string())?,
        password: parts[3].to_string(),
        protocol: parts[4].to_string(),
    })
}

async fn parse_lockfile_with_retry() -> Result<Lockfile, String> {
    for attempt in 1..=3 {
        match try_parse_lockfile_once() {
            Ok(lf) => return Ok(lf),
            Err(_e) => {
                if attempt < 3 {
                    sleep(Duration::from_millis(1000)).await;
                }
            }
        }
    }
    Err("Lockfile not found after 3 attempts -- is Valorant running?".to_string())
}

fn decode_private(private_b64: &str) -> serde_json::Value {
    general_purpose::STANDARD
        .decode(private_b64)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn get_shard_and_region(region: &str) -> (&'static str, &'static str) {
    match region {
        "na" | "na1" | "br1" | "latam" | "br" => ("na", "na"),
        "eu" | "eu1" | "eu2" | "eu3" => ("eu", "eu"),
        "ap" | "ap1" | "kr" | "kr1" => ("ap", "ap"),
        _ => ("na", "na"),
    }
}

mod commands {
    use super::*;
    use tauri::Manager;

    #[tauri::command]
    pub async fn get_presences() -> Result<Vec<PlayerPresence>, String> {
        let lf = parse_lockfile_with_retry().await?;

        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;

        let url = format!("{}://127.0.0.1:{}/chat/v4/presences", lf.protocol, lf.port);

        let res = client
            .get(&url)
            .basic_auth("riot", Some(&lf.password))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        let presences = body["presences"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        let players = presences
            .iter()
            .filter(|p| p["product"].as_str() == Some("valorant"))
            .map(|p| {
                let private = decode_private(p["private"].as_str().unwrap_or(""));

                PlayerPresence {
                    game_name: p["game_name"].as_str().unwrap_or("").to_string(),
                    game_tag: p["game_tag"].as_str().unwrap_or("").to_string(),
                    puuid: p["puuid"].as_str().unwrap_or("").to_string(),
                    account_level: private["playerPresenceData"]["accountLevel"]
                        .as_u64()
                        .map(|v| v as u32),
                    session_state: private["matchPresenceData"]["sessionLoopState"]
                        .as_str()
                        .map(String::from),
                    competitive_tier: private["playerPresenceData"]["competitiveTier"]
                        .as_u64()
                        .map(|v| v as u32),
                    party_id: private["partyId"].as_str().map(String::from),
                }
            })
            .collect();

        Ok(players)
    }

    #[tauri::command]
    pub async fn get_local_player() -> Result<serde_json::Value, String> {
        let lf = parse_lockfile_with_retry().await?;

        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;

        let url = format!("{}://127.0.0.1:{}/chat/v1/session", lf.protocol, lf.port);

        let res = client
            .get(&url)
            .basic_auth("riot", Some(&lf.password))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        Ok(body)
    }

    #[tauri::command]
    pub async fn get_pregame_match_id_external(
        puuid: String,
        access_token: String,
        entitlements_token: String,
        region: String,
    ) -> Result<String, String> {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;

        let (shard, _) = get_shard_and_region(&region);

        let url = format!(
            "https://glz-{}-1.{}.a.pvp.net/pregame/v1/players/{}",
            shard, shard, puuid
        );

        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("X-Riot-Entitlements-JWT", &entitlements_token)
            .header("X-Riot-ClientPlatform", "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9")
            .header("X-Riot-ClientVersion", "release-09.00-shipping-9-2459107")
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        body["MatchID"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| format!("Not in pregame: {}", body))
    }

    #[tauri::command]
    pub async fn get_pregame_match_external(
        match_id: String,
        access_token: String,
        entitlements_token: String,
        region: String,
    ) -> Result<serde_json::Value, String> {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;

        let (shard, _) = get_shard_and_region(&region);

        let url = format!(
            "https://glz-{}-1.{}.a.pvp.net/pregame/v1/matches/{}",
            shard, shard, match_id
        );

        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("X-Riot-Entitlements-JWT", &entitlements_token)
            .header("X-Riot-ClientPlatform", "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9")
            .header("X-Riot-ClientVersion", "release-09.00-shipping-9-2459107")
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        Ok(body)
    }

    #[tauri::command]
    pub async fn get_auth_tokens() -> Result<serde_json::Value, String> {
        let lf = parse_lockfile_with_retry().await?;

        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;

        let url = format!("{}://127.0.0.1:{}/entitlements/v1/token", lf.protocol, lf.port);

        let res = client
            .get(&url)
            .basic_auth("riot", Some(&lf.password))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        Ok(body)
    }

    #[tauri::command]
    pub async fn get_coregame_match_id_external(
        puuid: String,
        access_token: String,
        entitlements_token: String,
        region: String,
    ) -> Result<String, String> {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;

        let (shard, _) = get_shard_and_region(&region);
        let url = format!(
            "https://glz-{}-1.{}.a.pvp.net/core-game/v1/players/{}",
            shard, shard, puuid
        );

        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("X-Riot-Entitlements-JWT", &entitlements_token)
            .header("X-Riot-ClientPlatform", "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9")
            .header("X-Riot-ClientVersion", "release-09.00-shipping-9-2459107")
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        body["MatchID"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| format!("Not in coregame: {}", body))
    }

    #[tauri::command]
    pub async fn get_coregame_match_external(
        match_id: String,
        access_token: String,
        entitlements_token: String,
        region: String,
    ) -> Result<serde_json::Value, String> {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;

        let (shard, _) = get_shard_and_region(&region);
        let url = format!(
            "https://glz-{}-1.{}.a.pvp.net/core-game/v1/matches/{}",
            shard, shard, match_id
        );

        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("X-Riot-Entitlements-JWT", &entitlements_token)
            .header("X-Riot-ClientPlatform", "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9")
            .header("X-Riot-ClientVersion", "release-09.00-shipping-9-2459107")
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        Ok(body)
    }

    #[tauri::command]
    pub async fn get_party_members(
        party_id: String,
        access_token: String,
        entitlements_token: String,
        region: String,
    ) -> Result<serde_json::Value, String> {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;

        let (_, region_str) = get_shard_and_region(&region);

        let url = format!(
            "https://glz-{}-1.{}.a.pvp.net/parties/v1/parties/{}",
            region_str, region_str, party_id
        );

        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("X-Riot-Entitlements-JWT", &entitlements_token)
            .header("X-Riot-ClientPlatform", "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9")
            .header("X-Riot-ClientVersion", "release-09.00-shipping-9-2459107")
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        Ok(body)
    }

    #[tauri::command]
    pub async fn get_player_names(
        puuids: Vec<String>,
        access_token: String,
        entitlements_token: String,
        region: String,
    ) -> Result<serde_json::Value, String> {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;

        let (_, region_str) = get_shard_and_region(&region);
        let url = format!("https://pd.{}.a.pvp.net/name-service/v2/players", region_str);

        let res = client
            .put(url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("X-Riot-Entitlements-JWT", &entitlements_token)
            .header("X-Riot-ClientPlatform", "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9")
            .header("X-Riot-ClientVersion", "release-09.00-shipping-9-2459107")
            .json(&puuids)
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

        Ok(body)
    }

    async fn get_valorant_client_version() -> String {
        let fallback = "release-09.00-shipping-9-2459107".to_string();

        let log_path = match std::env::var("LOCALAPPDATA") {
            Ok(p) => format!("{}\\VALORANT\\Saved\\Logs\\ShooterGame.log", p),
            Err(_) => return fallback,
        };

        let content = match tokio::fs::read_to_string(&log_path).await {
            Ok(c) => c,
            Err(_) => return fallback,
        };

        for line in content.lines().rev() {
            // Pattern 1: "CI server version: release-XX.XX-shipping-X-XXXXXXX"
            if line.contains("CI server version:") {
                if let Some(rest) = line.split("CI server version:").nth(1) {
                    let v = rest.trim().to_string();
                    if v.starts_with("release-") {
                        println!("[BurgerLens] Client version from log: {}", v);
                        return v;
                    }
                }
            }
            // Pattern 2: "branch=release-XX.XX-shipping"
            if line.contains("branch=release-") {
                if let Some(rest) = line.split("branch=").nth(1) {
                    let v = rest.split_whitespace().next().unwrap_or("").to_string();
                    if v.starts_with("release-") {
                        println!("[BurgerLens] Client version from branch: {}", v);
                        return v;
                    }
                }
            }
        }

        println!("[BurgerLens] Could not find version in log, using fallback");
        fallback
    }

    async fn connect_and_listen(app_handle: &tauri::AppHandle) -> Result<(), String> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message;
        use tokio_tungstenite::Connector;
        use tauri::Emitter;

        let lockfile = parse_lockfile_with_retry().await?;
        let credentials =
            general_purpose::STANDARD.encode(format!("riot:{}", lockfile.password));

        let url = format!("wss://127.0.0.1:{}/", lockfile.port);
        let mut request = url
            .into_client_request()
            .map_err(|e| format!("WS request build error: {e}"))?;
        request.headers_mut().insert(
            "Authorization",
            format!("Basic {}", credentials)
                .parse()
                .map_err(|e: tokio_tungstenite::tungstenite::http::header::InvalidHeaderValue| {
                    format!("Invalid header: {e}")
                })?,
        );

        let tls_connector = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| format!("TLS build error: {e}"))?;
        let connector = Connector::NativeTls(tls_connector);

        let (ws_stream, _) =
            tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector))
                .await
                .map_err(|e| format!("WS connect error: {e}"))?;

        let (mut ws_sender, mut ws_receiver) = ws_stream.split();

        ws_sender
            .send(Message::Text(
                r#"[5, "OnJsonApiEvent_chat_v4_presences"]"#.to_string(),
            ))
            .await
            .map_err(|e| format!("WS send error: {e}"))?;

        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str(&text) {
                        if arr.get(0).and_then(|v| v.as_u64()) == Some(8) {
                            if let Some(payload) = arr.get(2) {
                                app_handle.emit("presence-event", payload.clone()).ok();
                            }
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Err(e) => {
                    return Err(format!("WS frame error: {e}"));
                }
                _ => {}
            }
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn start_presence_websocket(app_handle: tauri::AppHandle) -> Result<(), String> {
        tokio::spawn(async move {
            loop {
                match connect_and_listen(&app_handle).await {
                    Ok(_) => {
                        println!("[BurgerLens WS] Disconnected, reconnecting in 3s...");
                    }
                    Err(e) => {
                        println!("[BurgerLens WS] Error: {}, reconnecting in 3s...", e);
                    }
                }
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
            }
        });
        Ok(())
    }

    #[tauri::command]
    pub async fn get_client_version() -> Result<String, String> {
        Ok(get_valorant_client_version().await)
    }

    #[tauri::command]
    pub async fn get_client_version_local() -> Result<String, String> {
        Ok(get_valorant_client_version().await)
    }

    #[tauri::command]
    pub async fn get_client_version_api() -> Result<String, String> {
        let client = reqwest::Client::new();
        let resp = client
            .get("https://valorant-api.com/v1/version")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let version = json["data"]["riotClientVersion"]
            .as_str()
            .unwrap_or("")
            .to_string();
        Ok(version)
    }

    #[tauri::command]
    pub async fn get_player_mmr(
        puuid: String,
        access_token: String,
        entitlements_token: String,
        region: String,
        client_version: String,
    ) -> Result<serde_json::Value, String> {
        let (shard, _) = get_shard_and_region(&region);
        let url = format!(
            "https://pd.{}.a.pvp.net/mmr/v1/players/{}",
            shard, puuid
        );
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("X-Riot-Entitlements-JWT", &entitlements_token)
            .header("X-Riot-ClientPlatform", "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9")
            .header("X-Riot-ClientVersion", &client_version)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let body = resp.text().await.map_err(|e| format!("Failed to read body: {}", e))?;
        let json: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse JSON: {}", e))?;
        Ok(json)
    }

    #[tauri::command]
    pub async fn get_player_party(
        puuid: String,
        access_token: String,
        entitlements_token: String,
        region: String,
    ) -> Result<serde_json::Value, String> {
        let (shard, _) = get_shard_and_region(&region);
        let url = format!(
            "https://glz-{}-1.{}.a.pvp.net/parties/v1/players/{}",
            shard, shard, puuid
        );
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("X-Riot-Entitlements-JWT", &entitlements_token)
            .header("X-Riot-ClientPlatform", "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9")
            .header("X-Riot-ClientVersion", "release-09.00-shipping-9-2459107")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(json)
    }

    #[tauri::command]
    pub async fn get_coregame_match_loadouts(
        match_id: String,
        access_token: String,
        entitlements_token: String,
        region: String,
    ) -> Result<serde_json::Value, String> {
        let (shard, _) = get_shard_and_region(&region);
        let url = format!(
            "https://glz-{}-1.{}.a.pvp.net/core-game/v1/matches/{}/loadouts",
            shard, shard, match_id
        );
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("X-Riot-Entitlements-JWT", &entitlements_token)
            .header("X-Riot-ClientPlatform", "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9")
            .header("X-Riot-ClientVersion", "release-09.00-shipping-9-2459107")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(json)
    }

    #[tauri::command]
    pub async fn get_pregame_match_loadouts(
        match_id: String,
        access_token: String,
        entitlements_token: String,
        region: String,
    ) -> Result<serde_json::Value, String> {
        let (shard, _) = get_shard_and_region(&region);
        let url = format!(
            "https://glz-{}-1.{}.a.pvp.net/pregame/v1/matches/{}/loadouts",
            shard, shard, match_id
        );
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("X-Riot-Entitlements-JWT", &entitlements_token)
            .header("X-Riot-ClientPlatform", "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9")
            .header("X-Riot-ClientVersion", "release-09.00-shipping-9-2459107")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(json)
    }

    #[tauri::command]
    pub fn load_match_history(app: tauri::AppHandle) -> Result<Vec<MatchRecord>, String> {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("match_history.json");
        if !path.exists() {
            return Ok(vec![]);
        }
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        match serde_json::from_str::<Vec<MatchRecord>>(&content) {
            Ok(v) => Ok(v),
            Err(e) => {
                eprintln!("match_history.json deserialize failed: {e}");
                Ok(vec![])
            }
        }
    }

    #[tauri::command]
    pub fn save_match_history(app: tauri::AppHandle, records: Vec<MatchRecord>) -> Result<(), String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("match_history.json");
        let json = serde_json::to_string(&records).map_err(|e| e.to_string())?;
        let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn load_mmr_cache(app: tauri::AppHandle) -> Result<std::collections::HashMap<String, super::MmrCacheEntry>, String> {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("mmr_cache.json");
        if !path.exists() {
            return Ok(std::collections::HashMap::new());
        }
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        match serde_json::from_str::<std::collections::HashMap<String, super::MmrCacheEntry>>(&content)
        {
            Ok(v) => Ok(v),
            Err(e) => {
                eprintln!("mmr_cache.json deserialize failed: {e}");
                Ok(std::collections::HashMap::new())
            }
        }
    }

    #[tauri::command]
    pub fn save_mmr_cache(
        app: tauri::AppHandle,
        entries: std::collections::HashMap<String, super::MmrCacheEntry>,
    ) -> Result<(), String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("mmr_cache.json");
        let json = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
        let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn set_always_on_top(app: tauri::AppHandle, value: bool) -> Result<(), String> {
        use tauri::Manager;
        app.get_webview_window("main")
            .ok_or("Window not found".to_string())?
            .set_always_on_top(value)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn focus_window(app: tauri::AppHandle) -> Result<(), String> {
        app.get_webview_window("main")
            .ok_or("Window not found".to_string())?
            .set_focus()
            .map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::get_presences,
            commands::get_local_player,
            commands::get_pregame_match_id_external,
            commands::get_pregame_match_external,
            commands::get_auth_tokens,
            commands::get_coregame_match_id_external,
            commands::get_coregame_match_external,
            commands::get_coregame_match_loadouts,
            commands::get_pregame_match_loadouts,
            commands::get_party_members,
            commands::get_player_party,
            commands::get_player_names,
            commands::start_presence_websocket,
            commands::get_client_version,
            commands::get_client_version_local,
            commands::get_client_version_api,
            commands::get_player_mmr,
            commands::load_match_history,
            commands::save_match_history,
            commands::load_mmr_cache,
            commands::save_mmr_cache,
            commands::set_always_on_top,
            commands::focus_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
