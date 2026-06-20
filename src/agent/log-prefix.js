/**
 * Shared log-line prefix for agent processes.
 *
 * Returns a formatted prefix with full date and microsecond-precision
 * wall-clock time. Format:  [<tag> YYYY-MM-DD HH:MM:SS.ffffff]
 *
 * Why microseconds: agents emit many close-spaced events (WebSocket
 * frames, claude stream-json chunks, status flips) and millisecond
 * resolution loses ordering when several land in the same tick. The
 * extra three digits are cheap and let an operator reconstruct exact
 * sequencing from `grep` output without resorting to the dashboard.
 *
 * Microsecond accuracy comes from `performance.timeOrigin +
 * performance.now()` which is wall-clock-anchored and exposes
 * sub-millisecond precision in Node 22+. We anchor the integer ms
 * portion to a fresh `Date` so DST and clock adjustments are honoured;
 * the sub-ms fraction is treated as monotonic offset only.
 */
function logPrefix(tag) {
  const { performance } = require('perf_hooks');
  const total = performance.timeOrigin + performance.now(); // ms since unix epoch (float)
  const wholeMs = Math.trunc(total);
  const fracMs = total - wholeMs;                            // 0.xxx sub-ms
  const microsExtra = Math.floor(fracMs * 1000);             // 0..999

  const d = new Date(wholeMs);
  const iso = d.toISOString();                               // 2026-06-01T13:05:46.123Z
  const datePart = iso.slice(0, 10);                         // 2026-06-01
  const timePart = iso.slice(11, 19);                        // 13:05:46
  const ms = iso.slice(20, 23);                              // 123
  const us = String(microsExtra).padStart(3, '0');           // 456
  return `[${tag} ${datePart} ${timePart}.${ms}${us}]`;
}

module.exports = { logPrefix };
