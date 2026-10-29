package dev.agentclient;

import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.Container;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.MobType;
import net.minecraft.world.entity.Saddleable;
import net.minecraft.world.entity.animal.horse.AbstractChestedHorse;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.FishingHook;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraftforge.common.capabilities.ForgeCapabilities;
import net.minecraftforge.common.util.LazyOptional;
import net.minecraftforge.items.IItemHandler;

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
        return build(false);
    }

    /**
     * The action layer, registered once at mod construction.
     *
     * The snapshot is static (it only reads game objects) but the input ledger lives on
     * {@link ClientActions}; a static back-reference keeps /state a single call without
     * threading an instance through every caller.
     */
    private static volatile ClientActions ACTIONS;

    static void setActions(ClientActions actions) {
        ACTIONS = actions;
    }

    /**
     * Build the snapshot.
     *
     * `playersOnly` is the lightweight follow poll: it returns the self position and the
     * player list only, skipping the 40817-cell block scan, inventory, crops and entity
     * scans. A moving-player follow reads this at 150ms and full-scans only before each A*
     * route, instead of paying for the whole world every poll.
     */
    static String build(boolean playersOnly) {
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
        if (playersOnly) {
            out.put("players", playersJson(level, player));
            return Json.obj(out);
        }
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
         * `mc.hitResult` is the same raycast the game draws the block outline from, and in
         * 1.20 it is entity-aware: aiming at a mob yields an EntityHitResult. Reporting both
         * is what makes "what am I aiming at" answerable; blocks alone meant a player aiming
         * at a zombie produced `target: null` (live 2026-10-29).
         */
        out.put("target", targetJson(player));

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
        /**
         * Monotonic clock for the input layer.
         *
         * Held keys are released by a client tick counter, so "did the game advance since I
         * pressed?" has to be answerable from the snapshot. getGameTime() is server-synced
         * and monotonic; timeOfDay wraps every 24000 ticks and cannot serve as this clock.
         */
        out.put("gameTime", Json.num(level.getGameTime()));
        /**
         * The mod-side half of the input ledger (F1'b): which keys are held, their release
         * deadline, and whether a screen currently swallows player input. Embedded here so
         * one /state answers both "what is the world" and "is a key stuck".
         */
        out.put("input", ACTIONS == null ? Json.str("null") : ACTIONS.inputJson());
        out.put("weather", Json.obj(new LinkedHashMap<>(Map.of(
                "raining", Json.bool(level.isRaining()),
                "thundering", Json.bool(level.isThundering())
        ))));

        // ---- inventory -----------------------------------------------------
        out.put("inventory", inventoryJson(player));
        /**
         * Edible-item metadata (nutrition/saturation) straight from the item's own
         * FoodProperties. Vanilla's hard-coded food table cannot see Farmer's Delight,
         * Alex's Mobs, etc.; the client already has the real registry, so report it.
         */
        out.put("foods", foodsJson(player));
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
        /**
         * Everything nearby that is not a block, including MOD entities.
         *
         * 2026-10-29 live: the player stood on a modded stool, which is an Entity and not a
         * BlockState. Nothing in the snapshot described it, so the agent saw "air under my
         * feet, onGround=false, keys do nothing" with no way to find out why. A short entity
         * list is the missing half of the world model.
         */
        out.put("entities", entitiesJson(level, player));
        /** The entity carrying us (boat/minecart/seat), or "null". */
        out.put("riding", ridingJson(level, player));
        /** Explicit mount flag; the vehicle object carries inventory + integrity. */
        out.put("mounted", Json.bool(player.getVehicle() != null));
        /** The entity under our feet (chair/stool), or "null". */
        out.put("standingOnEntity", standingOnEntityJson(level, player));

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

    /**
     * Edible-item metadata from the item's real FoodProperties.
     *
     * The Node side used to have a vanilla-only food table; Farmer's Delight / addons and
     * Alex's Mobs foods scored as inedible, so a hungry agent with a full modded pantry
     * reported "nothing edible". The client registry knows every installed item, so the
     * snapshot carries nutrition/saturation and the eater picks by real value.
     */
    private static String foodsJson(LocalPlayer player) {
        Map<String, String> foods = new LinkedHashMap<>();
        for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
            ItemStack stack = player.getInventory().getItem(slot);
            if (stack.isEmpty() || !stack.isEdible()) {
                continue;
            }
            String name = itemName(stack);
            if (foods.containsKey(name)) {
                continue;
            }
            FoodProperties fp = stack.getItem().getFoodProperties();
            if (fp == null) {
                continue;
            }
            Map<String, String> entry = new LinkedHashMap<>();
            entry.put("nutrition", Json.num(fp.getNutrition()));
            entry.put("saturation", Json.num(fp.getSaturationModifier()));
            entry.put("alwaysEat", Json.bool(fp.canAlwaysEat()));
            foods.put(name, Json.obj(entry));
        }
        List<String> parts = new ArrayList<>();
        for (Map.Entry<String, String> e : foods.entrySet()) {
            parts.add(Json.str(e.getKey()) + ":" + e.getValue());
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

    /**
     * The crosshair target as JSON: a block, an entity, or "null".
     *
     * Shared by `/state` and the `target` verb so both answer the same question the same way.
     * The game's own `hitResult` is preferred (it is what the outline is drawn from and is
     * entity-aware); a fresh 4.5-block pick is the fallback when the frame has no hit yet.
     */
    static String targetJson(LocalPlayer player) {
        if (player == null || Minecraft.getInstance().level == null) {
            return "null";
        }
        HitResult hit = Minecraft.getInstance().hitResult;
        if (hit == null || hit.getType() == HitResult.Type.MISS) {
            hit = player.pick(4.5D, 1.0F, false);
        }
        /**
         * A miss must stay a miss. Falling through to the block branch reported the position
         * of the miss as a block target, so aiming at the sky came back as
         * `{"type":"block","name":"minecraft:air"}` (live 2026-10-29) - a target that looks
         * real and points at nothing.
         */
        if (hit == null || hit.getType() == HitResult.Type.MISS) {
            return "null";
        }
        if (hit instanceof EntityHitResult entityHit) {
            Entity entity = entityHit.getEntity();
            if (entity == null) {
                return "null";
            }
            Map<String, String> out = new LinkedHashMap<>();
            out.put("type", Json.str("entity"));
            out.put("name", Json.str(entityName(entity)));
            out.put("entityType", Json.str(entity.getType().toString()));
            out.put("id", Json.num(entity.getId()));
            out.put("kind", Json.str(entity instanceof Monster ? "hostile"
                    : (entity instanceof LivingEntity ? "living" : "entity")));
            out.put("position", Json.point(entity.getX(), entity.getY(), entity.getZ()));
            out.put("distance", Json.num(player.getEyePosition().distanceTo(entityHit.getLocation())));
            if (entity instanceof LivingEntity living) {
                out.put("health", Json.num(living.getHealth()));
            }
            return Json.obj(out);
        }
        if (hit instanceof BlockHitResult blockHit) {
            BlockPos pos = blockHit.getBlockPos();
            Map<String, String> out = new LinkedHashMap<>();
            out.put("type", Json.str("block"));
            out.put("name", Json.str(blockName(Minecraft.getInstance().level.getBlockState(pos))));
            out.put("position", Json.point(pos.getX(), pos.getY(), pos.getZ()));
            out.put("face", Json.str(blockHit.getDirection().getName()));
            out.put("distance", Json.num(player.getEyePosition().distanceTo(blockHit.getLocation())));
            return Json.obj(out);
        }
        return "null";
    }

    /** Nearby non-block entities, including mod ones (stools, chairs, boats, minecarts). */
    private static String entitiesJson(ClientLevel level, LocalPlayer player) {
        List<String> parts = new ArrayList<>();
        for (Entity entity : level.entitiesForRendering()) {
            if (entity == player || !entity.isAlive()) {
                continue;
            }
            double d = entity.distanceTo(player);
            if (d > 16.0D) {
                continue;
            }
            String kind;
            if (entity instanceof Monster) {
                kind = "hostile";
            } else if (entity instanceof ItemEntity) {
                kind = "item";
            } else if (entity instanceof net.minecraft.world.entity.player.Player) {
                kind = "player";
            } else if (entity instanceof LivingEntity) {
                kind = "living";
            } else {
                kind = "entity";
            }
            parts.add(entityJson(entity, d, kind));
        }
        return "[" + String.join(",", parts) + "]";
    }

    /** The entity whose passenger list contains us (boat / minecart / seat). */
    private static String ridingJson(ClientLevel level, LocalPlayer player) {
        for (Entity entity : level.entitiesForRendering()) {
            if (entity == player) {
                continue;
            }
            for (Entity passenger : entity.getPassengers()) {
                if (passenger == player) {
                    return vehicleJson(entity, player);
                }
            }
        }
        return Json.str("null");
    }

    /**
     * The vehicle we are riding, with the two things a control loop actually needs beyond
     * its identity: what it carries, and how damaged it is.
     *
     * Inventory probing is vendor-neutral and ordered by reliability:
     *   1. vanilla `Container` - chest boats, minecart chests/hoppers, and mod vehicles that
     *      implement the vanilla container interface (Immersive Aircraft's
     *      `InventoryVehicleEntity` does);
     *   2. Forge `IItemHandler` - horses (Forge wraps the horse inventory), chested horses,
     *      and mod vehicles that attach an item handler instead of `Container`.
     * Everything else honestly reports `known:false`; the agent must not guess what a
     * vehicle carries.
     *
     * Integrity: living vehicles report health/maxHealth. Non-living mod vehicles are probed
     * by their public `getHealth()/getMaxHealth()` (Immersive Aircraft exposes health as a
     * 0..1 ratio and has no max method - that case is labelled `unit:"ratio"` with
     * `inferredMax:true` so the reader can tell an inference from a reported value).
     *
     * MUST run on the client thread (same rule as the rest of this class).
     */
    private static String vehicleJson(Entity entity, LocalPlayer player) {
        Map<String, String> out = new LinkedHashMap<>();
        out.put("id", Json.num(entity.getId()));
        out.put("type", Json.str(entity.getType().toString()));
        out.put("name", Json.str(entityName(entity)));
        out.put("kind", Json.str("vehicle"));
        out.put("position", Json.point(entity.getX(), entity.getY(), entity.getZ()));
        out.put("distance", Json.num(entity.distanceTo(player)));
        List<String> passengers = new ArrayList<>();
        for (Entity passenger : entity.getPassengers()) {
            Map<String, String> entry = new LinkedHashMap<>();
            entry.put("id", Json.num(passenger.getId()));
            entry.put("type", Json.str(passenger.getType().toString()));
            entry.put("name", Json.str(passenger instanceof Player p
                    ? p.getGameProfile().getName()
                    : entityName(passenger)));
            entry.put("isPlayer", Json.bool(passenger instanceof Player));
            passengers.add(Json.obj(entry));
        }
        out.put("passengers", Json.arr(passengers));
        if (entity instanceof Saddleable saddleable) {
            out.put("saddled", Json.bool(saddleable.isSaddled()));
        }
        if (entity instanceof AbstractChestedHorse chested) {
            out.put("chested", Json.bool(chested.hasChest()));
        }
        out.put("integrity", vehicleIntegrityJson(entity));
        out.put("inventory", vehicleInventoryJson(entity));
        return Json.obj(out);
    }

    /** How many slots we are willing to enumerate on a vehicle (a chest boat is 27). */
    private static final int MAX_VEHICLE_SLOTS = 64;

    /** What the vehicle carries; vendor-neutral, `known:false` when it cannot be read. */
    private static String vehicleInventoryJson(Entity entity) {
        List<ItemStack> stacks = new ArrayList<>();
        String source = "none";
        /**
         * Vanilla `Container` first: chest boats and minecart containers implement it, and
         * mod vehicles that proxy a container (Immersive Aircraft) do too. The Forge
         * capability is checked second because some mods expose both.
         */
        if (entity instanceof Container container) {
            int size = 0;
            try {
                size = container.getContainerSize();
            } catch (Throwable ignored) {
                size = 0;
            }
            int scanned = Math.min(size, MAX_VEHICLE_SLOTS);
            for (int i = 0; i < scanned; i++) {
                try {
                    stacks.add(container.getItem(i));
                } catch (Throwable ignored) {
                    stacks.add(ItemStack.EMPTY);
                }
            }
            source = "container";
        } else {
            try {
                LazyOptional<IItemHandler> optional = entity.getCapability(ForgeCapabilities.ITEM_HANDLER, null);
                IItemHandler handler = optional.orElse(null);
                if (handler != null) {
                    int slots = Math.min(handler.getSlots(), MAX_VEHICLE_SLOTS);
                    for (int i = 0; i < slots; i++) {
                        ItemStack stack = handler.getStackInSlot(i);
                        stacks.add(stack == null ? ItemStack.EMPTY : stack);
                    }
                    source = "item_handler";
                }
            } catch (Throwable ignored) {
                // A mod capability that throws must not take the whole snapshot down.
            }
        }
        List<String> items = new ArrayList<>();
        int occupied = 0;
        for (int i = 0; i < stacks.size(); i++) {
            ItemStack stack = stacks.get(i);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            occupied++;
            Map<String, String> item = new LinkedHashMap<>();
            item.put("slot", Json.num(i));
            item.put("item", Json.str(itemName(stack)));
            item.put("count", Json.num(stack.getCount()));
            if (stack.isDamageableItem()) {
                item.put("damage", Json.num(stack.getDamageValue()));
                item.put("maxDamage", Json.num(stack.getMaxDamage()));
            }
            items.add(Json.obj(item));
        }
        Map<String, String> out = new LinkedHashMap<>();
        out.put("known", Json.bool(!"none".equals(source)));
        out.put("source", Json.str(source));
        out.put("size", Json.num(stacks.size()));
        out.put("occupied", Json.num(occupied));
        out.put("items", Json.arr(items));
        return Json.obj(out);
    }

    /** Vehicle integrity: health for living vehicles, health/damage probes for mod ones. */
    private static String vehicleIntegrityJson(Entity entity) {
        Map<String, String> out = new LinkedHashMap<>();
        if (entity instanceof LivingEntity living) {
            out.put("known", Json.bool(true));
            out.put("current", Json.num(living.getHealth()));
            out.put("max", Json.num(living.getMaxHealth()));
            out.put("unit", Json.str("points"));
            out.put("source", Json.str("living"));
            return Json.obj(out);
        }
        Double health = callNumber(entity, "getHealth");
        if (health != null) {
            Double max = callNumber(entity, "getMaxHealth");
            out.put("known", Json.bool(true));
            out.put("current", Json.num(health));
            if (max != null) {
                out.put("max", Json.num(max));
                out.put("unit", Json.str("points"));
            } else if (health <= 1.0D) {
                // Immersive Aircraft: health is a 0..1 ratio and there is no max method.
                out.put("max", Json.num(1.0D));
                out.put("unit", Json.str("ratio"));
                out.put("inferredMax", Json.bool(true));
            } else {
                out.put("unit", Json.str("unknown"));
            }
            out.put("source", Json.str("getHealth"));
            return Json.obj(out);
        }
        Double damage = callNumber(entity, "getDamage");
        Double maxDamage = callNumber(entity, "getMaxDamage");
        if (damage != null && maxDamage != null) {
            out.put("known", Json.bool(true));
            out.put("current", Json.num(damage));
            out.put("max", Json.num(maxDamage));
            out.put("unit", Json.str("points"));
            out.put("source", Json.str("getDamage"));
            return Json.obj(out);
        }
        out.put("known", Json.bool(false));
        out.put("source", Json.str("none"));
        return Json.obj(out);
    }

    /**
     * Best-effort numeric probe for third-party vehicles.
     *
     * The mod cannot compile against arbitrary vehicle mods, so the only generic path is a
     * public no-arg accessor. It is wrapped so a hostile/broken mod cannot break `/state`;
     * a missing or non-numeric method simply yields `null`.
     */
    private static Double callNumber(Object target, String name) {
        try {
            java.lang.reflect.Method method = target.getClass().getMethod(name);
            if (method.getParameterCount() != 0) {
                return null;
            }
            Object value = method.invoke(target);
            if (value instanceof Number number) {
                return number.doubleValue();
            }
        } catch (Throwable ignored) {
            // Not every vehicle is a LivingEntity or exposes health; absence is a valid answer.
        }
        return null;
    }

    /**
     * The entity we are standing on.
     *
     * A modded stool/chair is an Entity with a hitbox, so the block under the player is air
     * while `onGround` stays false. Matching the hitbox top against our feet is what makes
     * that visible (live 2026-10-29).
     */
    private static String standingOnEntityJson(ClientLevel level, LocalPlayer player) {
        double feetY = player.getY();
        for (Entity entity : level.entitiesForRendering()) {
            if (entity == player || !entity.isAlive()) {
                continue;
            }
            double dx = entity.getX() - player.getX();
            double dz = entity.getZ() - player.getZ();
            if (Math.hypot(dx, dz) > 1.2D) {
                continue;
            }
            if (Math.abs(entity.getBoundingBox().maxY - feetY) <= 0.6D) {
                return entityJson(entity, entity.distanceTo(player), "standing-on");
            }
        }
        return Json.str("null");
    }

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
            entry.put("inventoryAmmo", Json.bool(TaczBridge.usesInventoryAmmo(stack)));
            entry.put("bullets", Json.bool(magazine > 0 || dummy > 0 || TaczBridge.usesInventoryAmmo(stack)));
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
