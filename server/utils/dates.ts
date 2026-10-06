/** Convertit une date (YYYY-MM-DD, ISO 8601 ou YYYYMMDDhhmmss) au format OneStock YYYYMMDDhhmmss (UTC). */
export function toOnestockDate(value: string | undefined, endOfDay = false): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d{14}$/.test(v)) return Number(v);
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(bareDate ? `${v}T${endOfDay ? "23:59:59" : "00:00:00"}Z` : v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  const p = (n: number) => String(n).padStart(2, "0");
  return Number(
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`,
  );
}
