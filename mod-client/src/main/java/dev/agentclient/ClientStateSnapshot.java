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
import net.minecraft.world.item.ItemStack;
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

    /** Horizontal radius of the block scan. */
    private static final int SCAN_RADIUS = 24;
    private static final int SCAN_UP = 8;
    private static final int SCAN_DOWN = 8;
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
        out.put("time", Json.obj(new LinkedHashMap<>(Map.of(
                "timeOfDay", Json.num(level.getDayTime() % 24000L),
                "day", Json.num(level.getDayTime() / 24000L),
                "isDay", Json.bool(level.isDay())
        ))));
        out.put("weather", Json.obj(new LinkedHashMap<>(Map.of(
                "raining", Json.bool(level.isRaining()),
                "thundering", Json.bool(level.isThundering())
        ))));

        // ---- inventory -----------------------------------------------------
        out.put("inventory", inventoryJson(player));
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
            parts.add(Json.obj(new LinkedHashMap<>(Map.of(
                    "name", Json.str(other.getGameProfile().getName()),
                    "position", Json.point(other.getX(), other.getY(), other.getZ()),
                    "distance", Json.num(other.distanceTo(player)),
                    "health", Json.num(other.getHealth())
            ))));
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
