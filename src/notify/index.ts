// Shared notify utility — deliberately narrow. FRIDAY's/TUESDAY's/CLARA's actual dedupe and
// persistence strategies diverge for real reasons (see each app's own notify.ts) and were NOT
// unified here — same reasoning as excluding authority/risk and most of engines.ts from this
// shared library. This module holds only the one genuinely pure, identical-across-apps piece:
// parsing a "START-END" 24h-local quiet-hours window and checking whether a given time falls
// inside it (handles the midnight-wrap case, e.g. "22-7").

/**
 * @param raw Quiet-hours spec as "START-END" (24h local). Each side is H, HH, H:MM, or HH:MM —
 * e.g. "22-7", "22:30-7", "9-17:45". Whitespace around the dash is tolerated. Returns false
 * (no quiet hours) if `raw` doesn't match the expected shape (including minutes > 59).
 *
 * Comparison is minute-precision, half-open [start, end), with the midnight wrap handled the same
 * way the original hour-only parser did ("22-7" = 22:00 tonight through 06:59 tomorrow). Plain
 * "H-H" specs behave exactly as before — minutes default to :00 on both sides.
 */
export function parseQuietHours(raw: string, at: Date = new Date()): boolean {
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return false;
  const startMin = m[2] ? Number(m[2]) : 0;
  const endMin = m[4] ? Number(m[4]) : 0;
  if (startMin > 59 || endMin > 59) return false; // "22:99-7" is malformed, not quiet hours
  const start = Number(m[1]) * 60 + startMin;
  const end = Number(m[3]) * 60 + endMin;
  const now = at.getHours() * 60 + at.getMinutes();
  return start <= end ? now >= start && now < end : now >= start || now < end;
}
