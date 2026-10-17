'use strict';

/**
 * Is it daytime?
 *
 * `timeOfDay` is the server-synced clock and is authoritative. Do not trust the old
 * `isDay` boolean first: live 2026-10-17 the mod reported timeOfDay=14175 (vanilla night)
 * together with isDay=true, and the agent answered "天亮了" at night. `isDay` is retained
 * only as a fallback for older mods that omit timeOfDay.
 *
 * Vanilla night is [13000, 23000); the remaining window is day.
 */
function isDaytime(time) {
  if (!time) return null;
  if (typeof time.timeOfDay === 'number' && Number.isFinite(time.timeOfDay)) {
    const t = ((time.timeOfDay % 24000) + 24000) % 24000;
    return t < 13000 || t >= 23000;
  }
  if (typeof time.isDay === 'boolean') return time.isDay;
  return null;
}

module.exports = { isDaytime };
