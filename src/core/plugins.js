'use strict';

/**
 * mineflayer plugin installation.
 *
 * Plugin choice mirrors what the mature open-source mineflayer agents use:
 *   - mineflayer-pathfinder    : A* navigation (the single most important plugin)
 *   - mineflayer-collectblock  : "go get me N of item X" helper
 *   - mineflayer-tool          : automatic best-tool selection before digging
 *   - mineflayer-armor-manager : auto-equip armour (optional dependency)
 *   - minecrafthawkeye         : generic block/entity interaction helpers
 *
 * Every plugin is optional at runtime: if a package is missing we log it and carry
 * on with a degraded feature set instead of crashing the agent.
 */

const OPTIONAL_PLUGINS = [
  { name: 'pathfinder', pkg: 'mineflayer-pathfinder', apply: (bot, mod) => bot.loadPlugin(mod.pathfinder) },
  { name: 'collectblock', pkg: 'mineflayer-collectblock', apply: (bot, mod) => bot.loadPlugin(mod.plugin || mod) },
  { name: 'tool', pkg: 'mineflayer-tool', apply: (bot, mod) => bot.loadPlugin(mod.plugin || mod) },
  { name: 'armorManager', pkg: 'mineflayer-armor-manager', apply: (bot, mod) => bot.loadPlugin(mod.plugin || mod) },
  { name: 'hawkeye', pkg: 'minecrafthawkeye', apply: (bot, mod) => bot.loadPlugin(mod.plugin || (typeof mod === 'function' ? mod : mod.default)) }
];

function installPlugins(bot, cfg, log) {
  const loaded = [];
  for (const entry of OPTIONAL_PLUGINS) {
    let mod;
    try {
      mod = require(entry.pkg);
    } catch (err) {
      log.warn(`plugin ${entry.name} unavailable (${entry.pkg} not installed) - feature degraded`);
      continue;
    }
    try {
      const fn = entry.name === 'pathfinder' ? mod.pathfinder : mod.plugin || (typeof mod === 'function' ? mod : mod.default);
      if (typeof fn !== 'function') {
        log.warn(`plugin ${entry.name} skipped (${entry.pkg} does not export an inject function)`);
        continue;
      }
      entry.apply(bot, mod);
      loaded.push(entry.name);
      log.debug(`plugin loaded: ${entry.name}`);
    } catch (err) {
      log.warn(`plugin ${entry.name} failed to load: ${err.message}`);
    }
  }
  log.info(`plugins: ${loaded.join(', ') || 'none'}`);
  return loaded;
}

module.exports = { installPlugins, OPTIONAL_PLUGINS };
