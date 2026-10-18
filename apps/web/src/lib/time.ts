/** The API stores UTC without a zone suffix; read it as UTC. */
export function parseUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", … */
export function timeAgo(d: Date | string | null | undefined): string {
  const t = typeof d === "string" ? parseUtc(d) : d;
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t.getTime()) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [[60, "min"], [3600, "h"], [86400, "d"], [604800, "w"], [2629800, "mo"], [31557600, "y"]];
  let i = 0;
  while (i + 1 < units.length && s >= units[i + 1][0]) i++;
  return `${Math.floor(s / units[i][0])} ${units[i][1]} ago`;
}
