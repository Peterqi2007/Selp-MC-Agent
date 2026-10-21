'use strict';

/**
 * The skill catalogue - one import that registers every skill and exposes the registry.
 *
 * `require('../skills')` gives you `{ register, get, all, names, run, describe }`.
 * The modules below only *register*; nothing runs until `run(name, ctx, params)` is called,
 * which keeps the catalogue side-effect free and the offline tests fast.
 */

const registry = require('./registry');

// Registration order is the help order; keep it grouped by area.
require('./movement');
require('./inventory');
require('./blocks');
require('./combat');
require('./containers');
require('./crafting');
require('./smelting');
require('./farming');
require('./mining');
require('./collect');
require('./fishing');

module.exports = registry;
