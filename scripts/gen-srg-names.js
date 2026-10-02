'use strict';

/**
 * Build an official-name -> SRG-name lookup from the ForgeGradle/MCP caches.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Minecraft jars the launcher downloaded use **official class names** (the ones in
 * Mojang's mapping file, e.g. `net.minecraft.core.BlockPos`) but **SRG member names**
 * (`m_123341_` instead of `getX()`). ForgeGradle normally hides that by recompiling
 * Minecraft from official mappings, but that step needs maven.minecraftforge.net, which
 * is unreachable from this machine.
 *
 * APPROACH
 * --------
 * Matching by member *name* alone is not reliable here:
 *   - most of the methods we need are inherited (LocalPlayer#getX comes from Entity),
 *     so they are absent from LocalPlayer's own mapping entry;
 *   - obfuscated names repeat across classes, so a global name index collides.
 *
 * The 3-column TSRG (`tsrg2 obf srg id`) avoids both problems: the trailing `id` column
 * is globally unique, and the official ProGuard mapping gives us `official -> obf` with
 * the owner class, so we can join on (class, obf-name) and fall back to the id column.
 *
 * STATUS: NOT WORKING YET - do not rely on this.
 *
 * Fields resolve, but methods do not: the TSRG descriptor lines (tab-indented
 * `(params)ret`) are being mistaken for method entries by this parser, so names come
 * out as descriptors. Fixing it properly means a real TSRG parser plus the multi-column
 * join, which is a tool-sized job.
 *
 * It is kept in the tree because it documents the investigation and because the parse
 * bug is small and well understood - see mod-client/BUILDING.md for the two supported
 * ways to actually produce the jar (neither needs this script).
 *
 *   node scripts/gen-srg-names.js            # print the table
 *   node scripts/gen-srg-names.js --json     # machine-readable
 *   node scripts/gen-srg-names.js --check    # exit 1 if a wanted member is unresolved
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const GRADLE = path.join(os.homedir(), '.gradle', 'caches', 'forge_gradle');
const MCP = path.join(GRADLE, 'mcp_repo', 'de', 'oceanlabs', 'mcp', 'mcp_config');

/** Members the client mod needs, as official "Class#member" or "Class#member(desc)". */
const WANTED = [
  // --- client entry points -------------------------------------------------
  'net.minecraft.client.Minecraft#getInstance',
  'net.minecraft.client.Minecraft#player',
  'net.minecraft.client.Minecraft#level',
  'net.minecraft.client.Minecraft#gameMode',
  'net.minecraft.client.Minecraft#getConnection',
  'net.minecraft.client.Minecraft#execute',
  'net.minecraft.client.Minecraft#isSameThread',
  'net.minecraft.client.Minecraft#options',
  'net.minecraft.client.Minecraft#screen',
  'net.minecraft.client.Minecraft#setScreen',

  // --- player --------------------------------------------------------------
  'net.minecraft.client.player.LocalPlayer#getX',
  'net.minecraft.client.player.LocalPlayer#getY',
  'net.minecraft.client.player.LocalPlayer#getZ',
  'net.minecraft.client.player.LocalPlayer#getYRot',
  'net.minecraft.client.player.LocalPlayer#getXRot',
  'net.minecraft.client.player.LocalPlayer#setYRot',
  'net.minecraft.client.player.LocalPlayer#setXRot',
  'net.minecraft.client.player.LocalPlayer#getEyePosition',
  'net.minecraft.client.player.LocalPlayer#getInventory',
  'net.minecraft.client.player.LocalPlayer#getMainHandItem',
  'net.minecraft.client.player.LocalPlayer#getFoodData',
  'net.minecraft.client.player.LocalPlayer#getHealth',
  'net.minecraft.client.player.LocalPlayer#getMaxHealth',
  'net.minecraft.client.player.LocalPlayer#getAirSupply',
  'net.minecraft.client.player.LocalPlayer#onGround',
  'net.minecraft.client.player.LocalPlayer#isSprinting',
  'net.minecraft.client.player.LocalPlayer#isInWater',
  'net.minecraft.client.player.LocalPlayer#isInLava',
  'net.minecraft.client.player.LocalPlayer#isDeadOrDying',
  'net.minecraft.client.player.LocalPlayer#blockPosition',
  'net.minecraft.client.player.LocalPlayer#swing',
  'net.minecraft.client.player.LocalPlayer#drop',
  'net.minecraft.client.player.LocalPlayer#distanceTo',
  'net.minecraft.client.player.LocalPlayer#distanceToSqr',
  'net.minecraft.client.player.LocalPlayer#isCreative',
  'net.minecraft.client.player.LocalPlayer#horizontalCollision',
  'net.minecraft.client.player.LocalPlayer#experienceLevel',
  'net.minecraft.client.player.LocalPlayer#getGameProfile',

  // --- level ---------------------------------------------------------------
  'net.minecraft.client.multiplayer.ClientLevel#getBlockState',
  'net.minecraft.client.multiplayer.ClientLevel#hasChunkAt',
  'net.minecraft.client.multiplayer.ClientLevel#getEntity',
  'net.minecraft.client.multiplayer.ClientLevel#players',
  'net.minecraft.client.multiplayer.ClientLevel#entitiesForRendering',
  'net.minecraft.client.multiplayer.ClientLevel#dimension',
  'net.minecraft.client.multiplayer.ClientLevel#getDayTime',
  'net.minecraft.client.multiplayer.ClientLevel#isDay',
  'net.minecraft.client.multiplayer.ClientLevel#isRaining',
  'net.minecraft.client.multiplayer.ClientLevel#isThundering',

  // --- network -------------------------------------------------------------
  'net.minecraft.client.multiplayer.ClientPacketListener#sendChat',
  'net.minecraft.client.multiplayer.ClientPacketListener#sendCommand',
  'net.minecraft.client.multiplayer.ClientPacketListener#send',

  // --- interaction ---------------------------------------------------------
  'net.minecraft.client.multiplayer.MultiPlayerGameMode#startDestroyBlock',
  'net.minecraft.client.multiplayer.MultiPlayerGameMode#continueDestroyBlock',
  'net.minecraft.client.multiplayer.MultiPlayerGameMode#stopDestroyBlock',
  'net.minecraft.client.multiplayer.MultiPlayerGameMode#isDestroying',
  'net.minecraft.client.multiplayer.MultiPlayerGameMode#attack',
  'net.minecraft.client.multiplayer.MultiPlayerGameMode#useItem',
  'net.minecraft.client.multiplayer.MultiPlayerGameMode#useItemOn',

  // --- positions / math ----------------------------------------------------
  'net.minecraft.core.BlockPos#getX',
  'net.minecraft.core.BlockPos#getY',
  'net.minecraft.core.BlockPos#getZ',
  'net.minecraft.core.BlockPos#below',
  'net.minecraft.core.BlockPos#relative',
  'net.minecraft.core.BlockPos#offset',
  'net.minecraft.core.BlockPos#getCenter',
  'net.minecraft.world.phys.Vec3#atCenterOf',
  'net.minecraft.world.phys.Vec3#add',
  'net.minecraft.world.phys.Vec3#subtract',
  'net.minecraft.world.phys.Vec3#x',
  'net.minecraft.world.phys.Vec3#y',
  'net.minecraft.world.phys.Vec3#z',

  // --- inventory -----------------------------------------------------------
  'net.minecraft.world.entity.player.Inventory#getItem',
  'net.minecraft.world.entity.player.Inventory#getContainerSize',
  'net.minecraft.world.entity.player.Inventory#selected',
  'net.minecraft.world.item.ItemStack#isEmpty',
  'net.minecraft.world.item.ItemStack#getCount',
  'net.minecraft.world.item.ItemStack#getItem',
  'net.minecraft.world.item.Item#toString',

  // --- registry ------------------------------------------------------------
  'net.minecraft.core.registries.BuiltInRegistries#BLOCK',
  'net.minecraft.core.registries.BuiltInRegistries#ITEM',
  'net.minecraft.core.registries.BuiltInRegistries#ENTITY_TYPE',
  'net.minecraft.core.Registry#getKey',

  // --- block / entity ------------------------------------------------------
  'net.minecraft.world.level.block.state.BlockState#isAir',
  'net.minecraft.world.level.block.state.BlockState#getBlock',
  'net.minecraft.world.level.block.Block#getDescriptionId',
  'net.minecraft.world.entity.Entity#getId',
  'net.minecraft.world.entity.Entity#getType',
  'net.minecraft.world.entity.Entity#getX',
  'net.minecraft.world.entity.Entity#getY',
  'net.minecraft.world.entity.Entity#getZ',
  'net.minecraft.world.entity.Entity#isAlive',
  'net.minecraft.world.entity.Entity#getEyeHeight',
  'net.minecraft.world.entity.player.Player#getGameProfile',
  'net.minecraft.world.entity.LivingEntity#getHealth',
  'net.minecraft.world.entity.LivingEntity#getMobType',
  'net.minecraft.world.entity.item.ItemEntity#getItem',

  // --- worldgen / misc -----------------------------------------------------
  'net.minecraft.resources.ResourceLocation#toString',
  'net.minecraft.resources.ResourceKey#location',
  'net.minecraft.world.food.FoodData#getFoodLevel',
  'net.minecraft.world.food.FoodData#getSaturationLevel'
];

function findFile(dir, predicate) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, predicate);
      if (found) return found;
    } else if (predicate(entry.name)) {
      return full;
    }
  }
  return null;
}

/** obf -> srg, from the MCP TSRG. Also indexes the TSRG id column when present. */
function loadSrg(tsrgPath) {
  const lines = fs.readFileSync(tsrgPath, 'utf8').split(/\r?\n/);
  const methods = new Map(); // obfName -> srgName
  const fields = new Map();
  const header = lines[0] || '';
  // tsrg2 obf srg id  -> three name columns; plain tsrg -> two.
  const columns = header.split(/\s+/).length - 1;
  /** srg name -> tsrg id, for the collision-resistant path. */
  const srgToId = new Map();
  /** obf name + descriptor-free class scope -> srg */
  const scoped = new Map();

  let currentClass = null;
  for (const line of lines) {
    if (!line) continue;
    if (!line.startsWith('\t')) {
      const parts = line.split(/\s+/);
      currentClass = parts.length >= 2 ? parts[1] : null;
      continue;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length === 1) continue; // descriptor line for the previous member
    if (parts.length < 2) continue;

    const [obf, second, third] = parts;
    const isMethod = second.startsWith('(');
    const srgName = isMethod ? second : second;
    const id = columns >= 3 ? third : null;

    if (isMethod) {
      methods.set(obf, srgName);
    } else {
      fields.set(obf, srgName);
    }
    if (id) srgToId.set(srgName, id);
    if (currentClass) scoped.set(`${currentClass}\u0000${obf}`, srgName);
  }
  return { methods, fields, srgToId, scoped };
}

/** official class -> {obf, members: officialMember -> obfMember} from the ProGuard file. */
function loadOfficial(mappingsPath) {
  const lines = fs.readFileSync(mappingsPath, 'utf8').split(/\r?\n/);
  const classes = new Map();
  let current = null;
  for (const raw of lines) {
    if (!raw || raw.startsWith('#')) continue;
    if (!raw.startsWith(' ')) {
      const m = raw.match(/^(\S+) -> (\S+):$/);
      if (m) {
        current = { official: m[1], obf: m[2], members: new Map() };
        classes.set(m[1], current);
      }
      continue;
    }
    if (!current) continue;
    const m = raw.trim().match(/^(?:\d+:\d+:)?(\S+) (\S+) -> (\S+)$/);
    if (m) {
      current.members.set(`${m[2]}`, m[3]); // official member name -> obf
    }
  }
  return classes;
}

function main() {
  const wantJson = process.argv.includes('--json');
  const check = process.argv.includes('--check');

  const tsrg = findFile(MCP, (n) => n.endsWith('obf_to_srg.tsrg'));
  const official = findFile(path.join(__dirname, '..', 'runtime', 'mdk', 'mappings'), (n) => n.endsWith('mappings.txt'));
  if (!tsrg || !official) {
    console.error('missing inputs:');
    console.error(`  tsrg     : ${tsrg || 'NOT FOUND (expected under ~/.gradle/caches/forge_gradle/mcp_repo)'}`);
    console.error(`  official : ${official || 'NOT FOUND (expected runtime/mdk/mappings/client-1.20.1-mappings.txt)'}`);
    process.exit(2);
  }

  const srg = loadSrg(tsrg);
  const classes = loadOfficial(official);

  const resolved = [];
  const missing = [];

  for (const want of WANTED) {
    const [className, member] = want.split('#');
    const cls = classes.get(className);
    if (!cls) {
      missing.push({ want, why: 'class not in official mappings' });
      continue;
    }
    const obfMember = cls.members.get(member);
    if (!obfMember) {
      missing.push({ want, why: 'member not in official mappings' });
      continue;
    }
    const srgName = srg.methods.get(obfMember) || srg.fields.get(obfMember);
    if (!srgName) {
      missing.push({ want, why: `obf member ${obfMember} not in obf_to_srg` });
      continue;
    }
    resolved.push({
      className,
      official: member,
      obf: obfMember,
      srg: srgName,
      kind: srg.methods.has(obfMember) ? 'method' : 'field'
    });
  }

  if (wantJson) {
    console.log(JSON.stringify({ resolved, missing }, null, 2));
  } else {
    console.log(`official -> SRG lookup (${resolved.length} resolved, ${missing.length} missing)`);
    console.log(`  tsrg     : ${tsrg}`);
    console.log(`  official : ${official}`);
    console.log('');
    let lastClass = null;
    for (const r of resolved) {
      if (r.className !== lastClass) {
        console.log(`\n${r.className}`);
        lastClass = r.className;
      }
      console.log(`  ${r.official.padEnd(24)} -> ${r.srg.padEnd(14)} (${r.kind})`);
    }
    if (missing.length) {
      console.log('\nMISSING:');
      for (const m of missing) console.log(`  ${m.want}  [${m.why}]`);
    }
  }

  if (check && missing.length) {
    process.exit(1);
  }
}

main();
