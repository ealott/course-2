/** Dates are stored as local "YYYY-MM-DD" strings. */

export function todayISO(): string {
  const d = new Date();
  return toISO(d);
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso: string, days: number): string {
  const d = fromISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

export function daysUntil(iso: string): number {
  const ms = fromISO(iso).getTime() - fromISO(todayISO()).getTime();
  return Math.round(ms / 86_400_000);
}

export function formatDate(iso: string | null | undefined, opts: { weekday?: boolean } = {}): string {
  if (!iso) return "";
  const d = fromISO(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    weekday: opts.weekday ? "short" : undefined,
  });
}

export function expiryInfo(iso: string): { label: string; tone: "danger" | "warn" | "neutral" } {
  const days = daysUntil(iso);
  if (days < 0) return { label: `Expired ${formatDate(iso)}`, tone: "danger" };
  if (days === 0) return { label: "Use today", tone: "danger" };
  if (days === 1) return { label: "Use by tomorrow", tone: "danger" };
  if (days <= 4) return { label: `Use within ${days} days`, tone: "warn" };
  return { label: `Use by ${formatDate(iso)}`, tone: "neutral" };
}
