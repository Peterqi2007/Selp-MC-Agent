package dev.agentclient;

import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;

import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * Reflection bridge to TACZ (Timeless and Classics Zero) - no compile-time dependency.
 *
 * The agent-client mod must load and run on any client, TACZ installed or not, so every
 * TACZ call goes through cached reflective lookups resolved once, lazily. When the mod is
 * absent {@link #available()} stays false and the verbs report {@code tacz_unavailable}
 * honestly instead of crashing the class loader.
 *
 * Gun state needs no reflection: it lives on the item stack under stable string tags
 * (verified against tacz-1.20.1-1.1.8 by decompiling {@code GunItemDataAccessor}):
 * {@code GunId} (tacz:ak47 ...), {@code GunCurrentAmmoCount} (rounds in the magazine),
 * {@code DummyAmmo} (rounds for guns that use dummy ammo).
 */
final class TaczBridge {

    private static boolean resolved = false;
    private static boolean available = false;

    private static Method fromLivingEntity;
    private static Method aim;
    private static Method shoot;
    private static Method reload;
    private static Method bolt;
    private static Method draw;
    private static Method cooldown;
    private static Method aimingProgress;
    private static Method getCommonGunIndex;
    private static Method indexGetType;

    /** gunId -> gun type ("rifle"/"sniper"/...); "unknown" is a valid, cached answer. */
    private static final Map<String, String> TYPE_CACHE = new HashMap<>();

    private TaczBridge() {
    }

    static synchronized boolean available() {
        resolve();
        return available;
    }

    private static synchronized void resolve() {
        if (resolved) {
            return;
        }
        resolved = true;
        try {
            Class<?> operator = Class.forName("com.tacz.guns.api.entity.IGunOperator");
            fromLivingEntity = operator.getMethod("fromLivingEntity", LivingEntity.class);
            aim = operator.getMethod("aim", boolean.class);
            shoot = operator.getMethod("shoot", Supplier.class, Supplier.class);
            reload = operator.getMethod("reload");
            bolt = operator.getMethod("bolt");
            draw = operator.getMethod("draw", Supplier.class);
            cooldown = operator.getMethod("getSynShootCoolDown");
            aimingProgress = operator.getMethod("getSynAimingProgress");
            Class<?> api = Class.forName("com.tacz.guns.api.TimelessAPI");
            getCommonGunIndex = api.getMethod("getCommonGunIndex", ResourceLocation.class);
            Class<?> index = Class.forName("com.tacz.guns.resource.index.CommonGunIndex");
            indexGetType = index.getMethod("getType");
            available = true;
            AgentClientMod.LOGGER.info("tacz bridge resolved - gun verbs enabled");
        } catch (Throwable e) {
            available = false;
            AgentClientMod.LOGGER.info("tacz not present - gun verbs will report tacz_unavailable");
        }
    }

    // ---------------------------------------------------------------- stack tags

    static String gunIdOf(ItemStack stack) {
        if (stack == null || stack.isEmpty() || !stack.hasTag() || stack.getTag() == null) {
            return null;
        }
        if (!stack.getTag().contains("GunId")) {
            return null;
        }
        String id = stack.getTag().getString("GunId");
        return id == null || id.isEmpty() ? null : id;
    }

    static boolean isGun(ItemStack stack) {
        return gunIdOf(stack) != null;
    }

    static int magazineOf(ItemStack stack) {
        if (!isGun(stack)) {
            return 0;
        }
        return stack.getTag().getInt("GunCurrentAmmoCount");
    }

    static int dummyOf(ItemStack stack) {
        if (!isGun(stack)) {
            return 0;
        }
        return stack.getTag().getInt("DummyAmmo");
    }

    static boolean hasRounds(ItemStack stack) {
        return magazineOf(stack) > 0 || dummyOf(stack) > 0;
    }

    /** Gun type from the TACZ index; "unknown" when TACZ is absent or the id is not indexed. */
    static String typeOf(String gunId) {
        if (gunId == null) {
            return "unknown";
        }
        synchronized (TYPE_CACHE) {
            String hit = TYPE_CACHE.get(gunId);
            if (hit != null) {
                return hit;
            }
        }
        String type = "unknown";
        try {
            resolve();
            if (available) {
                Object idx = getCommonGunIndex.invoke(null, new ResourceLocation(gunId));
                if (idx instanceof Optional<?> opt && opt.isPresent()) {
                    Object value = indexGetType.invoke(opt.get());
                    if (value instanceof String s && !s.isEmpty()) {
                        type = s;
                    }
                }
            }
        } catch (Throwable ignored) {
            // keep "unknown"
        }
        synchronized (TYPE_CACHE) {
            TYPE_CACHE.put(gunId, type);
        }
        return type;
    }

    // ------------------------------------------------------------- operator calls
    // All operator helpers MUST be called on the client thread; the callers wrap with
    // ClientActions.onClient().

    static Object operator(LivingEntity player) {
        resolve();
        if (!available || player == null) {
            return null;
        }
        try {
            return fromLivingEntity.invoke(null, player);
        } catch (Throwable e) {
            return null;
        }
    }

    static void aim(Object op, boolean on) {
        if (op == null || !available) {
            return;
        }
        try {
            aim.invoke(op, on);
        } catch (Throwable ignored) {
        }
    }

    static void reload(Object op) {
        if (op == null || !available) {
            return;
        }
        try {
            reload.invoke(op);
        } catch (Throwable ignored) {
        }
    }

    static void bolt(Object op) {
        if (op == null || !available) {
            return;
        }
        try {
            bolt.invoke(op);
        } catch (Throwable ignored) {
        }
    }

    static void draw(Object op, Supplier<ItemStack> stack) {
        if (op == null || !available) {
            return;
        }
        try {
            draw.invoke(op, stack);
        } catch (Throwable ignored) {
        }
    }

    /** Milliseconds until the gun can shoot again; Long.MAX_VALUE when unknown. */
    static long shootCooldown(Object op) {
        if (op == null || !available) {
            return Long.MAX_VALUE;
        }
        try {
            Object value = cooldown.invoke(op);
            return value instanceof Number n ? n.longValue() : Long.MAX_VALUE;
        } catch (Throwable e) {
            return Long.MAX_VALUE;
        }
    }

    /** Scope progress 0..1; 0 when unknown. */
    static float aimingProgress(Object op) {
        if (op == null || !available) {
            return 0.0F;
        }
        try {
            Object value = aimingProgress.invoke(op);
            return value instanceof Number n ? n.floatValue() : 0.0F;
        } catch (Throwable e) {
            return 0.0F;
        }
    }

    /** Fire once along the player's current view. Returns the ShootResult name, or null. */
    static String fire(Object op, Supplier<Float> pitch, Supplier<Float> yaw) {
        if (op == null || !available) {
            return null;
        }
        try {
            Object result = shoot.invoke(op, pitch, yaw);
            return result == null ? null : result.toString();
        } catch (Throwable e) {
            return null;
        }
    }
}
