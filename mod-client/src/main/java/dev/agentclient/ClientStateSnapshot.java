package dev.agentclient;

import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.MobType;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.FishingHook;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.state.BlockState;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads the game state the agent needs - the direct replacement for vision.
 *
 * The agent never looks at a screenshot. It gets the same structured data the game
 * itself works with: block states straight out of the client level, the player's own
 * fields, entity lists, and the inventory. On a modded server this is strictly better
 * than what mineflayer could do, because modded blocks and items come with their real
 * identities instead of being guessed from a vanilla registry.
 *
 * MUST be called on the client thread. The result is a string, which is then cached and
 * handed to HTTP threads - that is the whole threading strategy.
 */
final class ClientStateSnapshot {

    /**
     * Horizontal radius of the block scan.
     *
     * 30, not 24: the mine-ore task searches "the nearest ore within 30 blocks on x/z", and
     * a scan that stops at 24 would silently answer "no ore" for veins the operator can see.
     */
    private static final int SCAN_RADIUS = 30;
    private static final int SCAN_UP = 8;
    private static final int SCAN_DOWN = 8;

    /** Crop blocks whose growth stage matters (they all carry an integer `age` property). */
    private static final java.util.regex.Pattern CROP_NAME = java.util.regex.Pattern.compile(
            "(wheat|carrots|potatoes|beetroots|nether_wart|sweet_berry_bush|melon_stem|pumpkin_stem|cave_vines|torchflower_crop|pitcher_crop|_crop$)"
    );
    /** Entities worth reporting to the agent. */
    private static final double ENTITY_RANGE = 24.0D;

    private ClientStateSnapshot() {
    }

    static String build() {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer player = mc.player;
        ClientLevel level = mc.level;

        if (player == null || level == null) {
            return Json.obj(new LinkedHashMap<>(Map.of(
                    "ready", Json.bool(false),
                    "reason", Json.str(mc.getConnection() == null ? "not connected" : "no level yet")
            )));
        }

        Map<String, String> out = new LinkedHashMap<>();
        out.put("ready", Json.bool(true));
        out.put("body", Json.str("clientmod"));

        // ---- self ----------------------------------------------------------
        BlockPos feet = player.blockPosition();
        out.put("position", Json.point(player.getX(), player.getY(), player.getZ()));
        out.put("blockPosition", Json.point(feet.getX(), feet.getY(), feet.getZ()));
        out.put("yaw", Json.num(player.getYRot()));
        out.put("pitch", Json.num(player.getXRot()));
        out.put("dimension", Json.str(level.dimension().location().toString()));
        out.put("health", Json.num(player.getHealth()));
        out.put("maxHealth", Json.num(player.getMaxHealth()));
        out.put("food", Json.num(player.getFoodData().getFoodLevel()));
        out.put("saturation", Json.num(player.getFoodData().getSaturationLevel()));
        out.put("air", Json.num(player.getAirSupply()));
        out.put("onGround", Json.bool(player.onGround()));
        out.put("sprinting", Json.bool(player.isSprinting()));
        out.put("inWater", Json.bool(player.isInWater()));
        out.put("inLava", Json.bool(player.isInLava()));
        out.put("dead", Json.bool(player.isDeadOrDying()));
        out.put("xpLevel", Json.num(player.experienceLevel));
        out.put("gamemode", Json.str(player.isCreative() ? "creative" : "survival"));

        /**
         * Is a GUI screen open, and is the mouse grabbed?
         *
         * This matters more than it looks. Minecraft ignores movement input while any screen
         * is open, so if a human leaves the inventory (or a chest, or the chat box) open, the
         * agent cannot walk a single step - and from the outside that is indistinguishable
         * from a broken pathfinder. Reporting it turns "it will not move" into a one-line
         * answer: someone has a screen open.
         *
         * `mouseGrabbed == false` also means the window does not have focus, which has the
         * same effect: the client stops applying the movement keys.
         */
        Object screen = Minecraft.getInstance().screen;
        out.put("screenOpen", Json.bool(screen != null));
        out.put("screen", Json.str(screen == null ? "null" : screen.getClass().getSimpleName()));
        out.put("mouseGrabbed", Json.bool(Minecraft.getInstance().mouseHandler.isMouseGrabbed()));
        out.put("windowFocused", Json.bool(Minecraft.getInstance().isWindowActive()));

        ItemStack held = player.getMainHandItem();
        out.put("heldItem", held.isEmpty() ? "null" : Json.str(itemName(held)));
        out.put("standingOn", Json.str(blockName(level.getBlockState(feet.below()))));
        out.put("feetBlock", Json.str(blockName(level.getBlockState(feet))));

        /**
         * Light at the feet, so the agent can light its own tunnel.
         *
         * `blockLight` is what a torch changes and what mob spawning reads in a tunnel
         * (there is no sky light underground); `lightLevel` is the combined value the F3
         * screen shows, reported so both can be compared.
         */
        out.put("lightLevel", Json.num(level.getMaxLocalRawBrightness(feet)));
        out.put("blockLight", Json.num(level.getBrightness(LightLayer.BLOCK, feet)));

        /**
         * The fishing bobber, so the agent can fish like a player.
         *
         * `biting` is a private field in 1.20.1 and the production jar carries SRG names,
         * so it is read reflectively - the same trick mc_aiplayer's FishTask uses for its
         * Yarn/intermediary names. `cast` alone would be useless: reeling in at the wrong
         * moment loses the fish.
         */
        out.put("fishing", fishingJson(player));
        ItemStack heldStack = player.getMainHandItem();
        if (!heldStack.isEmpty() && heldStack.getMaxDamage() > 0) {
            out.put("heldDurability", Json.obj(new LinkedHashMap<>(Map.of(
                    "remaining", Json.num(Math.max(0, heldStack.getMaxDamage() - heldStack.getDamageValue())),
                    "max", Json.num(heldStack.getMaxDamage())
            ))));
        }

        /**
         * What the crosshair points at ("aimed vision").
         *
         * `mc.hitResult` is the same raycast the game draws the block outline from, so this
         * is exactly what a player sees under the crosshair. The agent uses it to mine what
         * is already in front of it instead of pathfinding to a scanned coordinate.
         */
        var hit = Minecraft.getInstance().hitResult;
        if (hit instanceof net.minecraft.world.phys.BlockHitResult blockHit) {
            BlockPos targetPos = blockHit.getBlockPos();
            Map<String, String> target = new LinkedHashMap<>();
            target.put("name", Json.str(blockName(level.getBlockState(targetPos))));
            target.put("position", Json.point(targetPos.getX(), targetPos.getY(), targetPos.getZ()));
            target.put("face", Json.str(blockHit.getDirection().getName()));
            target.put("distance", Json.num(player.getEyePosition().distanceTo(blockHit.getLocation())));
            out.put("target", Json.obj(target));
        } else {
            out.put("target", "null");
        }

        // ---- time / weather ------------------------------------------------
        /**
         * Do NOT use level.isDay() here. On a client it is derived from sky-darken /
         * client light state, which can disagree with the server's dayTime: live
         * 2026-10-17 timeOfDay=14175 (night) still reported isDay=true and the agent
         * answered "天亮了". The server time packet is the authoritative clock; compute
         * the window from getDayTime() instead. Vanilla night is [13000, 23000).
         */
        long dayTime = level.getDayTime();
        long timeOfDay = Math.floorMod(dayTime, 24000L);
        boolean isDay = timeOfDay < 13000L || timeOfDay >= 23000L;
        out.put("time", Json.obj(new LinkedHashMap<>(Map.of(
                "timeOfDay", Json.num(timeOfDay),
                "day", Json.num(dayTime / 24000L),
                "isDay", Json.bool(isDay)
        ))));
        out.put("weather", Json.obj(new LinkedHashMap<>(Map.of(
                "raining", Json.bool(level.isRaining()),
                "thundering", Json.bool(level.isThundering())
        ))));

        // ---- inventory -----------------------------------------------------
        out.put("inventory", inventoryJson(player));
        out.put("guns", gunsJson(player));

        /**
         * Crop ages, so farming can tell ripe from growing.
         *
         * The block scan carries ids only, and `minecraft:wheat` looks identical at every
         * growth stage. Age lives in the block state, which is why this small extra scan
         * (12-block radius - farming happens near the bot) reports {name, position, age,
         * maxAge} for every crop with an integer `age` property.
         */
        out.put("crops", cropsJson(level, feet, 12));
        out.put("emptySlots", Json.num(countEmptySlots(player)));

        // ---- blocks (the "vision" replacement) ------------------------------
        out.put("blocks", blocksJson(level, feet));

        // ---- entities ------------------------------------------------------
        out.put("hostiles", hostilesJson(level, player));
        out.put("itemDrops", itemDropsJson(level, player));
        out.put("players", playersJson(level, player));

        return Json.obj(out);
    }

    // ------------------------------------------------------------------ blocks

    /** The player's bobber: whether one is out, and whether a fish is on the line. */
    private static String fishingJson(LocalPlayer player) {
        Map<String, String> out = new LinkedHashMap<>();
        FishingHook hook = player.fishing;
        if (hook == null || !hook.isAlive()) {
            out.put("cast", Json.bool(false));
            return Json.obj(out);
        }
        boolean biting = readBoolean(hook, "biting", "f_37099_");
        boolean hookedEntity = false;
        try {
            hookedEntity = hook.getHookedIn() != null;
        } catch (Throwable ignored) {
            // Older/other mappings: the biting flag above is enough on its own.
        }
        out.put("cast", Json.bool(true));
        out.put("biting", Json.bool(biting || hookedEntity));
        out.put("hookedEntity", Json.bool(hookedEntity));
        out.put("x", Json.num(hook.getX()));
        out.put("y", Json.num(hook.getY()));
        out.put("z", Json.num(hook.getZ()));
        out.put("id", Json.num(hook.getId()));
        return Json.obj(out);
    }

    /** Read a private boolean field by any of its runtime names (dev name, SRG name). */
    private static boolean readBoolean(Object target, String... names) {
        for (String name : names) {
            try {
                java.lang.reflect.Field field = target.getClass().getDeclaredField(name);
                field.setAccessible(true);
                Object value = field.get(target);
                if (value instanceof Boolean flag) {
                    return flag;
                }
            } catch (ReflectiveOperationException | RuntimeException ignored) {
                // Try the next name.
            }
        }
        return false;
    }

    /**
     * Flat map of "x,y,z" -> block id for everything nearby.
     *
     * A flat map keeps the payload compact and lets the Node side answer arbitrary
     * "what is at ..." questions without a request per block. Air is included because
     * the pathfinder needs to know what is passable.
     */
    private static String blocksJson(ClientLevel level, BlockPos centre) {
        List<String> entries = new ArrayList<>();
        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
        for (int dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
            for (int dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
                for (int dy = -SCAN_DOWN; dy <= SCAN_UP; dy++) {
                    cursor.set(centre.getX() + dx, centre.getY() + dy, centre.getZ() + dz);
                    if (!level.hasChunkAt(cursor)) {
                        continue;
                    }
                    BlockState state = level.getBlockState(cursor);
                    entries.add(Json.str(cursor.getX() + "," + cursor.getY() + "," + cursor.getZ())
                            + ":" + Json.str(blockName(state)));
                }
            }
        }
        // Returned as {"cells": {"x,y,z": "minecraft:stone", ...}} so the Node side can
        // look up any nearby coordinate without another request per block.
        return "{\"cells\":{" + String.join(",", entries) + "}}";
    }

    // ---------------------------------------------------------------- inventory

    private static String inventoryJson(LocalPlayer player) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
            ItemStack stack = player.getInventory().getItem(slot);
            if (stack.isEmpty()) {
                continue;
            }
            counts.merge(itemName(stack), stack.getCount(), Integer::sum);
        }
        List<String> parts = new ArrayList<>();
        for (Map.Entry<String, Integer> e : counts.entrySet()) {
            parts.add(Json.str(e.getKey()) + ":" + Json.num(e.getValue()));
        }
        return "{" + String.join(",", parts) + "}";
    }

    /** Crops with an integer age property inside `radius`, as JSON. */
    private static String cropsJson(ClientLevel level, BlockPos centre, int radius) {
        List<String> parts = new ArrayList<>();
        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                for (int dy = -4; dy <= 4; dy++) {
                    cursor.set(centre.getX() + dx, centre.getY() + dy, centre.getZ() + dz);
                    if (!level.hasChunkAt(cursor)) {
                        continue;
                    }
                    BlockState state = level.getBlockState(cursor);
                    String name = blockName(state);
                    if (name == null || !CROP_NAME.matcher(name).find()) {
                        continue;
                    }
                    Integer age = ageOf(state);
                    if (age == null) {
                        continue;
                    }
                    Map<String, String> entry = new LinkedHashMap<>();
                    entry.put("name", Json.str(name));
                    entry.put("position", Json.point(cursor.getX(), cursor.getY(), cursor.getZ()));
                    entry.put("age", Json.num(age));
                    entry.put("maxAge", Json.num(maxAgeOf(state)));
                    parts.add(Json.obj(entry));
                    if (parts.size() >= 64) {
                        return Json.arr(parts);
                    }
                }
            }
        }
        return Json.arr(parts);
    }

    /** The integer `age` property of a block state, or null when it has none. */
    private static Integer ageOf(BlockState state) {
        for (var property : state.getProperties()) {
            if (property.getName().equals("age") && property.getValueClass() == Integer.class) {
                return (Integer) state.getValue(property);
            }
        }
        return null;
    }

    /** Highest value the `age` property can take (the ripe value). */
    private static int maxAgeOf(BlockState state) {
        for (var property : state.getProperties()) {
            if (property.getName().equals("age") && property.getValueClass() == Integer.class) {
                int max = 0;
                for (Object value : property.getPossibleValues()) {
                    max = Math.max(max, (Integer) value);
                }
                return max;
            }
        }
        return 0;
    }

    private static int countEmptySlots(LocalPlayer player) {
        int empty = 0;
        for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
            if (player.getInventory().getItem(slot).isEmpty()) {
                empty++;
            }
        }
        return empty;
    }

    // ----------------------------------------------------------------- entities

    private static String hostilesJson(ClientLevel level, LocalPlayer player) {
        List<String> parts = new ArrayList<>();
        for (Entity entity : level.entitiesForRendering()) {
            if (!(entity instanceof Monster) || !entity.isAlive()) {
                continue;
            }
            double d = entity.distanceTo(player);
            if (d > ENTITY_RANGE) {
                continue;
            }
            parts.add(entityJson(entity, d, "hostile"));
        }
        return "[" + String.join(",", parts) + "]";
    }

    private static String itemDropsJson(ClientLevel level, LocalPlayer player) {
        List<String> parts = new ArrayList<>();
        for (Entity entity : level.entitiesForRendering()) {
            if (!(entity instanceof ItemEntity drop) || !entity.isAlive()) {
                continue;
            }
            double d = entity.distanceTo(player);
            if (d > 16.0D) {
                continue;
            }
            parts.add(Json.obj(new LinkedHashMap<>(Map.of(
                    "id", Json.num(entity.getId()),
                    "item", Json.str(itemName(drop.getItem())),
                    "count", Json.num(drop.getItem().getCount()),
                    "position", Json.point(entity.getX(), entity.getY(), entity.getZ()),
                    "distance", Json.num(d)
            ))));
        }
        return "[" + String.join(",", parts) + "]";
    }

    private static String playersJson(ClientLevel level, LocalPlayer player) {
        List<String> parts = new ArrayList<>();
        for (Player other : level.players()) {
            if (other == player) {
                continue;
            }
            /**
             * `id` is what lets the agent aim at a player (PvP gunfire): the shoot verb
             * addresses entities by id, and names alone cannot be turned into a target.
             */
            Map<String, String> entry = new LinkedHashMap<>();
            entry.put("id", Json.num(other.getId()));
            entry.put("name", Json.str(other.getGameProfile().getName()));
            entry.put("position", Json.point(other.getX(), other.getY(), other.getZ()));
            entry.put("distance", Json.num(other.distanceTo(player)));
            entry.put("health", Json.num(other.getHealth()));
            parts.add(Json.obj(entry));
        }
        return "[" + String.join(",", parts) + "]";
    }

    /**
     * TACZ guns carried (hotbar + main inventory + offhand), for the agent's gun picker.
     *
     * Type comes from the TACZ index through TaczBridge (reflection, cached); magazine and
     * dummy are the stable NBT tags. `bullets` merges them so the agent can filter "has
     * rounds" without re-deriving the tag semantics.
     */
    private static String gunsJson(LocalPlayer player) {
        List<String> parts = new ArrayList<>();
        List<ItemStack> stacks = new ArrayList<>();
        var inventory = player.getInventory();
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            stacks.add(inventory.getItem(slot));
        }
        stacks.add(player.getOffhandItem());
        for (ItemStack stack : stacks) {
            String gunId = TaczBridge.gunIdOf(stack);
            if (gunId == null) {
                continue;
            }
            int magazine = TaczBridge.magazineOf(stack);
            int dummy = TaczBridge.dummyOf(stack);
            Map<String, String> entry = new LinkedHashMap<>();
            entry.put("item", Json.str(itemName(stack)));
            entry.put("gunId", Json.str(gunId));
            entry.put("type", Json.str(TaczBridge.typeOf(gunId)));
            entry.put("magazine", Json.num(magazine));
            entry.put("dummy", Json.num(dummy));
            entry.put("bullets", Json.bool(magazine > 0 || dummy > 0));
            parts.add(Json.obj(entry));
        }
        return "[" + String.join(",", parts) + "]";
    }

    private static String entityJson(Entity entity, double distance, String kind) {
        Map<String, String> map = new LinkedHashMap<>();
        map.put("id", Json.num(entity.getId()));
        map.put("type", Json.str(entity.getType().toString()));
        map.put("name", Json.str(entityName(entity)));
        map.put("kind", Json.str(kind));
        map.put("position", Json.point(entity.getX(), entity.getY(), entity.getZ()));
        map.put("distance", Json.num(distance));
        if (entity instanceof LivingEntity living) {
            map.put("health", Json.num(living.getHealth()));
            map.put("mobType", Json.str(living.getMobType() == MobType.UNDEAD ? "undead" : "normal"));
        }
        return Json.obj(map);
    }

    // ------------------------------------------------------------------ helpers

    /** "minecraft:oak_log" - namespaced, exactly as the registry reports it. */
    private static String blockName(BlockState state) {
        ResourceLocation id = BuiltInRegistries.BLOCK.getKey(state.getBlock());
        return id == null ? "minecraft:air" : id.toString();
    }

    private static String itemName(ItemStack stack) {
        ResourceLocation id = BuiltInRegistries.ITEM.getKey(stack.getItem());
        return id == null ? "minecraft:air" : id.toString();
    }

    private static String entityName(Entity entity) {
        ResourceLocation id = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType());
        return id == null ? "unknown" : id.toString();
    }
}
