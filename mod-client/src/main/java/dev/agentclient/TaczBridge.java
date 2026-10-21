package dev.agentclient;

import net.minecraft.client.KeyMapping;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.ItemStack;

import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

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
 *
 * Firing path (live bug, 2026-10-13): the entity-generic
 * {@code IGunOperator.shoot(Supplier, Supplier)} is the server-side routine - invoked on
 * a client {@code LocalPlayer} it throws internally, and every 8s burst died with an
 * empty result code while the magazine never moved. The game itself fires through
 * {@code IClientPlayerGunOperator} (decompiled {@code ShootKey.autoShoot}:
 * {@code chargeShoot(true)} then {@code shoot()}, which builds a
 * {@code ClientMessagePlayerShoot} and sends it to the server). Every action verb here
 * therefore resolves against the client-side operator API.
 */
final class TaczBridge {

    private static boolean resolved = false;
    private static boolean available = false;

    private static Method fromLocalPlayer;
    private static Method aimMethod;
    private static Method isAimMethod;
    /** TACZ's own aim key mapping; null when the mod predates AimKey. */
    private static KeyMapping aimKey;
    private static Method chargeShoot;
    private static Method shoot;
    private static Method reload;
    private static Method bolt;
    private static Method draw;
    private static Method cooldown;
    private static Method aimingProgress;
    private static Method useInventoryAmmo;
    private static Method getCommonGunIndex;
    private static Method indexGetType;

    /** Last reflection failure on the fire path; surfaced via /progress for diagnostics. */
    private static volatile String fireError = null;

    /** Last reflection/key failure on the aim path; surfaced via /progress for diagnostics. */
    private static volatile String aimError = null;

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
            Class<?> operator = Class.forName("com.tacz.guns.api.client.gameplay.IClientPlayerGunOperator");
            fromLocalPlayer = operator.getMethod("fromLocalPlayer", LocalPlayer.class);
            aimMethod = operator.getMethod("aim", boolean.class);
            isAimMethod = operator.getMethod("isAim");
            chargeShoot = operator.getMethod("chargeShoot", boolean.class);
            shoot = operator.getMethod("shoot");
            reload = operator.getMethod("reload");
            bolt = operator.getMethod("bolt");
            draw = operator.getMethod("draw", ItemStack.class);
            cooldown = operator.getMethod("getClientShootCoolDown");
            aimingProgress = operator.getMethod("getClientAimingProgress", float.class);
            Class<?> iGun = Class.forName("com.tacz.guns.api.item.IGun");
            useInventoryAmmo = iGun.getMethod("useInventoryAmmo", ItemStack.class);
            Class<?> api = Class.forName("com.tacz.guns.api.TimelessAPI");
            getCommonGunIndex = api.getMethod("getCommonGunIndex", ResourceLocation.class);
            Class<?> index = Class.forName("com.tacz.guns.resource.index.CommonGunIndex");
            indexGetType = index.getMethod("getType");
            available = true;
            AgentClientMod.LOGGER.info("tacz bridge resolved (client operator) - gun verbs enabled");
            /**
             * TACZ's own aim key (decompiled tacz-1.20.1-1.1.8-hotfix): {@code AimKey} is
             * a Forge subscriber whose client-tick handler forces the aim state to
             * {@code AIM_KEY.isDown()} whenever {@code HoldToAim} is true - the shipped
             * default, and true in this client's tacz-client.toml. Calling
             * {@code IClientPlayerGunOperator.aim(true)} alone is therefore reverted on the
             * next tick and the scope never rises (the live "right-click aim is broken"
             * bug). Resolve the mapping in its own try so an older TACZ without AimKey
             * still keeps the operator bridge.
             */
            try {
                Class<?> aimKeyClass = Class.forName("com.tacz.guns.client.input.AimKey");
                Object mapping = aimKeyClass.getField("AIM_KEY").get(null);
                if (mapping instanceof KeyMapping key) {
                    aimKey = key;
                    AgentClientMod.LOGGER.info("tacz aim key resolved - hold-to-aim supported");
                }
            } catch (Throwable ignored) {
                aimKey = null;
            }
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

    /**
     * Does this gun draw rounds straight from the inventory instead of a magazine?
     *
     * TACZ's own ReloadKey returns immediately for such guns; treating magazine=0 as
     * "no ammo" made the agent stop firing and call reload in a loop. The method lives on
     * IGun; resolve it defensively because older TACZ builds may lack the field.
     */
    static boolean usesInventoryAmmo(ItemStack stack) {
        if (!isGun(stack)) {
            return false;
        }
        resolve();
        if (!available || useInventoryAmmo == null) {
            return false;
        }
        try {
            Object result = useInventoryAmmo.invoke(stack.getItem(), stack);
            return result instanceof Boolean b && b;
        } catch (Throwable ignored) {
            return false;
        }
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

    static Object operator(LocalPlayer player) {
        resolve();
        if (!available || player == null) {
            return null;
        }
        try {
            return fromLocalPlayer.invoke(null, player);
        } catch (Throwable e) {
            return null;
        }
    }

    /**
     * Hold/release TACZ's own aim key mapping.
     *
     * This is what a real right-click does to the mod: {@code KeyMapping.set(key, down)}
     * forwards to each mapping's {@code setDown}, so the mapping's {@code isDown()} - the
     * exact value {@code AimKey.onAimHoldingPreInput} reads every client tick - flips.
     * Writing the field directly through the public {@code setDown} keeps it independent
     * of the player's key bindings (rebinding the aim key does not break automation).
     */
    private static void holdAimKey(boolean down) {
        resolve();
        KeyMapping key = aimKey;
        if (key == null) {
            return;
        }
        try {
            key.setDown(down);
        } catch (Throwable e) {
            aimError = e.getClass().getSimpleName() + ": " + (e.getMessage() == null ? "" : e.getMessage());
        }
    }

    /** True when TACZ reports the gun as aimed (client prediction). */
    static boolean isAim(Object op) {
        if (op == null || !available) {
            return false;
        }
        try {
            Object value = isAimMethod.invoke(op);
            return value instanceof Boolean b && b;
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * Aim or lower the gun.
     *
     * Two configs exist: {@code HoldToAim=true} (default) needs the real key held, because
     * TACZ's tick handler is the authority; {@code HoldToAim=false} (toggle) ignores the
     * key and needs the operator call. Doing both makes aiming work under either config,
     * and the isAim check avoids spamming {@code ClientMessagePlayerAim} every tick.
     */
    static void aim(Object op, boolean on) {
        holdAimKey(on);
        if (!available || op == null) {
            return;
        }
        try {
            if (isAim(op) != on) {
                aimMethod.invoke(op, on);
            }
            aimError = null;
        } catch (Throwable e) {
            aimError = e.getClass().getSimpleName() + ": " + (e.getMessage() == null ? "" : e.getMessage());
        }
    }

    /** Human-readable reason for the last failed aim() call; null after a clean call. */
    static String lastAimError() {
        return aimError;
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

    static void draw(Object op, ItemStack stack) {
        if (op == null || !available) {
            return;
        }
        try {
            draw.invoke(op, stack);
        } catch (Throwable ignored) {
        }
    }

    /** Client-side milliseconds until the gun can shoot again; Long.MAX_VALUE when unknown. */
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

    /** Client scope progress 0..1; 0 when unknown. */
    static float aimingProgress(Object op) {
        if (op == null || !available) {
            return 0.0F;
        }
        try {
            Object value = aimingProgress.invoke(op, 1.0F);
            return value instanceof Number n ? n.floatValue() : 0.0F;
        } catch (Throwable e) {
            return 0.0F;
        }
    }

    /**
     * Client-side trigger pull, mirroring the game's own input path
     * ({@code ShootKey.autoShoot}): tick the charge state, then fire. The shot itself is
     * aimed along the player's current view angles (the caller keeps facing the target).
     *
     * @return the ShootResult name; "CHARGING" while a charge weapon is winding up; null
     *         when the call itself failed - see {@link #lastFireError()}.
     */
    static String fire(Object op) {
        if (op == null || !available) {
            return null;
        }
        try {
            Object ready = chargeShoot.invoke(op, Boolean.TRUE);
            if (ready instanceof Boolean b && !b) {
                fireError = null;
                return "CHARGING";
            }
            Object result = shoot.invoke(op);
            fireError = null;
            return result == null ? null : result.toString();
        } catch (Throwable e) {
            fireError = e.getClass().getSimpleName() + ": " + (e.getMessage() == null ? "" : e.getMessage());
            return null;
        }
    }

    /** Human-readable reason for the last failed fire() call; null after a clean call. */
    static String lastFireError() {
        return fireError;
    }
}
