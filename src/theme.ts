const SETTINGS_KEY = "burgerlens_settings";
const LEGACY_THEME_KEY = "burgerlens-theme";

/** Read dark-mode preference before React mounts (settings.darkMode, then legacy theme key). */
export function readStoredDarkMode(): boolean {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw != null && raw.trim() !== "") {
      const parsed = JSON.parse(raw) as { darkMode?: boolean };
      if (typeof parsed.darkMode === "boolean") return parsed.darkMode;
    }
  } catch {
    // fall through
  }
  const legacy = localStorage.getItem(LEGACY_THEME_KEY);
  if (legacy === "light") return false;
  if (legacy === "dark") return true;
  return true;
}

export function applyDocumentDarkClass(isDark: boolean): void {
  document.documentElement.classList.toggle("dark", isDark);
}
