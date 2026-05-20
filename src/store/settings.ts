import type { Settings } from "../types";

export type { Settings };

const DEFAULTS: Settings = {
  henrikApiKey: import.meta.env.VITE_HENRIK_API_KEY ?? "",
  refreshRate: 5000,
  region: "na",
  alwaysOnTop: true,
  opacity: 1,
  soundEnabled: true,
  darkMode: true,
};

const STORAGE_KEY = "burgerlens_settings";
const LEGACY_STORAGE_KEY = "lobbylens_settings";

export function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored != null && stored.trim() !== "") {
      return { ...DEFAULTS, ...JSON.parse(stored) };
    }
  } catch {}

  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy != null && legacy.trim() !== "") {
      const merged = { ...DEFAULTS, ...JSON.parse(legacy) };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return merged;
    }
  } catch {}

  return { ...DEFAULTS };
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
