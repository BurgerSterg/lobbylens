export interface SeasonInfo {
  label: string;
  short: string;
  startDate: string;
  endDate: string;
}

export const SEASON_MAP: Record<string, SeasonInfo> = {
  // Episode 1
  e1a1: { label: "Episode 1 Act 1", short: "E1A1", startDate: "Jun 2020", endDate: "Aug 2020" },
  e1a2: { label: "Episode 1 Act 2", short: "E1A2", startDate: "Aug 2020", endDate: "Oct 2020" },
  e1a3: { label: "Episode 1 Act 3", short: "E1A3", startDate: "Oct 2020", endDate: "Jan 2021" },
  // Episode 2
  e2a1: { label: "Episode 2 Act 1", short: "E2A1", startDate: "Jan 2021", endDate: "Mar 2021" },
  e2a2: { label: "Episode 2 Act 2", short: "E2A2", startDate: "Mar 2021", endDate: "Apr 2021" },
  e2a3: { label: "Episode 2 Act 3", short: "E2A3", startDate: "Apr 2021", endDate: "Jun 2021" },
  // Episode 3
  e3a1: { label: "Episode 3 Act 1", short: "E3A1", startDate: "Jun 2021", endDate: "Sep 2021" },
  e3a2: { label: "Episode 3 Act 2", short: "E3A2", startDate: "Sep 2021", endDate: "Nov 2021" },
  e3a3: { label: "Episode 3 Act 3", short: "E3A3", startDate: "Nov 2021", endDate: "Jan 2022" },
  // Episode 4
  e4a1: { label: "Episode 4 Act 1", short: "E4A1", startDate: "Jan 2022", endDate: "Mar 2022" },
  e4a2: { label: "Episode 4 Act 2", short: "E4A2", startDate: "Mar 2022", endDate: "Apr 2022" },
  e4a3: { label: "Episode 4 Act 3", short: "E4A3", startDate: "Apr 2022", endDate: "Jun 2022" },
  // Episode 5
  e5a1: { label: "Episode 5 Act 1", short: "E5A1", startDate: "Jun 2022", endDate: "Aug 2022" },
  e5a2: { label: "Episode 5 Act 2", short: "E5A2", startDate: "Aug 2022", endDate: "Oct 2022" },
  e5a3: { label: "Episode 5 Act 3", short: "E5A3", startDate: "Oct 2022", endDate: "Jan 2023" },
  // Episode 6
  e6a1: { label: "Episode 6 Act 1", short: "E6A1", startDate: "Jan 2023", endDate: "Mar 2023" },
  e6a2: { label: "Episode 6 Act 2", short: "E6A2", startDate: "Mar 2023", endDate: "Apr 2023" },
  e6a3: { label: "Episode 6 Act 3", short: "E6A3", startDate: "Apr 2023", endDate: "Jun 2023" },
  // Episode 7
  e7a1: { label: "Episode 7 Act 1", short: "E7A1", startDate: "Jun 2023", endDate: "Aug 2023" },
  e7a2: { label: "Episode 7 Act 2", short: "E7A2", startDate: "Aug 2023", endDate: "Oct 2023" },
  e7a3: { label: "Episode 7 Act 3", short: "E7A3", startDate: "Oct 2023", endDate: "Jan 2024" },
  // Episode 8
  e8a1: { label: "Episode 8 Act 1", short: "E8A1", startDate: "Jan 2024", endDate: "Mar 2024" },
  e8a2: { label: "Episode 8 Act 2", short: "E8A2", startDate: "Mar 2024", endDate: "Apr 2024" },
  e8a3: { label: "Episode 8 Act 3", short: "E8A3", startDate: "Apr 2024", endDate: "Jun 2024" },
  // Episode 9
  e9a1: { label: "Episode 9 Act 1", short: "E9A1", startDate: "Jun 2024", endDate: "Aug 2024" },
  e9a2: { label: "Episode 9 Act 2", short: "E9A2", startDate: "Aug 2024", endDate: "Oct 2024" },
  e9a3: { label: "Episode 9 Act 3", short: "E9A3", startDate: "Oct 2024", endDate: "Jan 2025" },
  // Season 2025
  v25a1: { label: "Season 2025 Act 1", short: "S25A1", startDate: "Jan 2025", endDate: "Mar 2025" },
  v25a2: { label: "Season 2025 Act 2", short: "S25A2", startDate: "Mar 2025", endDate: "Apr 2025" },
  v25a3: { label: "Season 2025 Act 3", short: "S25A3", startDate: "Apr 2025", endDate: "Jun 2025" },
  v25a4: { label: "Season 2025 Act 4", short: "S25A4", startDate: "Jun 2025", endDate: "Aug 2025" },
  v25a5: { label: "Season 2025 Act 5", short: "S25A5", startDate: "Aug 2025", endDate: "Oct 2025" },
  v25a6: { label: "Season 2025 Act 6", short: "S25A6", startDate: "Oct 2025", endDate: "Jan 2026" },
  // Season 2025 (Henrik internal codes use e10 instead of v25)
  e10a1: { label: "Season 2025 Act 1", short: "S25A1", startDate: "Jan 2025", endDate: "Mar 2025" },
  e10a2: { label: "Season 2025 Act 2", short: "S25A2", startDate: "Mar 2025", endDate: "Apr 2025" },
  e10a3: { label: "Season 2025 Act 3", short: "S25A3", startDate: "Apr 2025", endDate: "Jun 2025" },
  e10a4: { label: "Season 2025 Act 4", short: "S25A4", startDate: "Jun 2025", endDate: "Aug 2025" },
  e10a5: { label: "Season 2025 Act 5", short: "S25A5", startDate: "Aug 2025", endDate: "Oct 2025" },
  e10a6: { label: "Season 2025 Act 6", short: "S25A6", startDate: "Oct 2025", endDate: "Jan 2026" },
  // Season 2026
  v26a1: { label: "Season 2026 Act 1", short: "S26A1", startDate: "Jan 2026", endDate: "Mar 2026" },
  v26a2: { label: "Season 2026 Act 2", short: "S26A2", startDate: "Mar 2026", endDate: "Apr 2026" },
  v26a3: { label: "Season 2026 Act 3", short: "S26A3", startDate: "Apr 2026", endDate: "Jun 2026" },
  // Season 2026 (Henrik internal codes use e11 instead of v26)
  e11a1: { label: "Season 2026 Act 1", short: "S26A1", startDate: "Jan 2026", endDate: "Mar 2026" },
  e11a2: { label: "Season 2026 Act 2", short: "S26A2", startDate: "Mar 2026", endDate: "Apr 2026" },
  e11a3: { label: "Season 2026 Act 3", short: "S26A3", startDate: "Apr 2026", endDate: "Jun 2026" },
};

export function getSeasonInfo(short: string | undefined | null): SeasonInfo | null {
  if (!short) return null;
  return SEASON_MAP[short.toLowerCase()] ?? null;
}

/** Compact one-liner for UI, e.g. "S25A3 · Apr–Jun 2025". */
export function formatSeasonCompactLine(info: SeasonInfo): string {
  const startMonth = info.startDate.split(" ")[0] ?? "";
  const endParts = info.endDate.split(" ");
  const endMonth = endParts[0] ?? "";
  const endYear = endParts[1] ?? "";
  return `${info.short} · ${startMonth}–${endMonth} ${endYear}`;
}

/** Tooltip text: full label and date range. */
export function formatSeasonTooltip(info: SeasonInfo): string {
  return `${info.label} (${info.startDate} – ${info.endDate})`;
}

/** Compact line from Henrik season short, or raw short if unknown. */
export function formatPeakSeasonSubline(short: string | undefined | null): string | null {
  if (!short) return null;
  const info = getSeasonInfo(short);
  if (info) return formatSeasonCompactLine(info);
  return short;
}

/** Tooltip from Henrik season short, or raw short if unknown. */
export function formatPeakSeasonTooltip(short: string | undefined | null): string | undefined {
  if (!short) return undefined;
  const info = getSeasonInfo(short);
  if (info) return formatSeasonTooltip(info);
  return short;
}
