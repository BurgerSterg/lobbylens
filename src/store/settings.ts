import type { Settings } from "../types";

export type { Settings };

const DEFAULTS: Settings = {
  henrikApiKey: import.meta.env.VITE_HENRIK_API_KEY ?? "",
  refreshRate: 5000,
  region: "na",
  alwaysOnTop: true,
  opacity: 1,
};

const STORAGE_KEY = "burgerlens_settings";

export function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...DEFAULTS, ...JSON.parse(stored) };
  } catch {}
  return { ...DEFAULTS };
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
