'use strict';

/**
 * Is it daytime?
 *
 * The client snapshot carries both `isDay` and `timeOfDay`. Trust `isDay` first: live
 * 2026-10-17 the server reported `timeOfDay=13233` together with `isDay=true` (daylight
 * offset), so the vanilla timeOfDay window alone called it night and the sleep gate refused
 * to run tests in daylight. Fall back to the vanilla window only when `isDay` is absent.
 */
function isDaytime(time) {
  if (!time) return null;
  if (typeof time.isDay === 'boolean') return time.isDay;
  if (typeof time.timeOfDay === 'number' && Number.isFinite(time.timeOfDay)) {
    const t = ((time.timeOfDay % 24000) + 24000) % 24000;
    return !(t >= 12542 && t <= 23458);
  }
  return null;
}

module.exports = { isDaytime };
