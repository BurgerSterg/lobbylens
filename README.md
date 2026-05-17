# BurgerLens

A lightweight overlay for Valorant that shows you lobby information before and during a match — agent picks, account levels, ranks, and party groupings — so you know what kind of game you're walking into.

Built with Tauri + React + Rust.

---

## What It Shows

- Every player's agent, name, and account level
- Current and peak rank for each player
- Party groupings — players queued together are highlighted so you can tell who makes plays as a unit
- Blue and Red team split with your own row highlighted
- Map name and server location
- Average and highest rank summary for the lobby
- Match history — click any player to see how many times you've matched with them, which map, and whether you won or lost

---

## Requirements

- Windows 10 or 11
- Valorant installed and running
- Riot Client running (BurgerLens reads from it locally)
- A Henrik Dev API key for rank data and match history (see below)

---

## Henrik Dev API Key

Ranks and match history require a free API key from [Henrik Dev](https://app.henrikdev.xyz).

> **Note:** Henrik Dev API signups are currently unavailable. The app works without a key — agent picks, levels, and party detection all function normally. Ranks and history will not load until a key is added.

When signups reopen, get your key at `https://app.henrikdev.xyz`, then add it in BurgerLens under **Settings**.

---

## Installation

1. Go to [Releases](https://github.com/BurgerSterg/burgerlens/releases)
2. Download `burgerlens_x64-setup.exe`
3. Run the installer
4. Launch BurgerLens from your Start menu or desktop

---

## How To Use

1. Start Riot Client and Valorant
2. Open BurgerLens
3. Go to **Settings** and add your Henrik API key and set your region
4. Click **Auto** — BurgerLens will automatically detect when you enter agent select or a live match and load the lobby
5. Click any player row to see your match history with them

---

## Known Limitations

- Ranks take approximately 20 seconds to load on first fetch due to Henrik API rate limits (30 requests per minute on the free tier)
- Enemy team is hidden during agent select by Riot's design — only your team is visible until the match starts
- Party detection only works for your own party during agent select
- Match history only records matches played while BurgerLens is running, plus a one-time backfill of past matches on first launch (requires Henrik key)

---

## Notes

BurgerLens reads data from your local Riot Client and the Henrik Dev API. It does not modify any game files or interact with Valorant's servers in any way that would violate terms of service. Use at your own discretion.
