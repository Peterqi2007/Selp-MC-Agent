package dev.agentclient;

import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.protocol.game.ServerboundMovePlayerPacket;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Executes agent actions inside the client.
 *
 * Two rules shape everything here:
 *
 *  1. **Threading.** Every method posts to the client thread with
 *     {@code Minecraft.getInstance().execute(...)} and waits on a future with a hard
 *     timeout. HTTP handler threads never touch game state directly.
 *
 *  2. **Use the game's own paths.** Digging goes through
 *     {@code MultiPlayerGameMode.startDestroyBlock/continueDestroyBlock/stopDestroyBlock},
 *     exactly what a mouse hold does; movement uses the game's own travel by setting
 *     input state. Nothing is packet-forged, so the server sees ordinary play.
 *
 * Continuous actions (walking, digging) are driven from the client tick - a single HTTP
 * call starts them and later calls stop them, because a client cannot do "walk 12 blocks"
 * instantaneously.
 */
public final class ClientActions {

    /** How long an action may take on the client thread before we give up on it. */
    private static final long DEFAULT_TIMEOUT_MS = 15_000L;

    private final Minecraft mc = Minecraft.getInstance();

    /** Currently running continuous action, polled each client tick. */
    private volatile Continuous continuous;
    /**
     * Verdict of the last finished action.
     *
     * The continuous slot is cleared the moment an action finishes, so a /progress poll that
     * lands after that tick used to see only `{busy:false}` - the caller then treated every
     * finished action, including a failed walk, as a success by default. Retaining the final
     * progress means "done/failed/reason/cell" survive until the next action starts.
     */
    private volatile String lastProgress;

    // ------------------------------------------------------------------ simple

    /** Send a chat message (no leading slash needed). */
    public boolean chat(String message) {
        return onClient(() -> {
            if (mc.player == null || mc.getConnection() == null) {
                return false;
            }
            mc.getConnection().sendChat(message);
            return true;
        });
    }

    /**
     * Send a command.
     *
     * IMPORTANT - this is the AuthMe `/login` path and the slash handling was verified
     * empirically (see {@code /diag/slash}): Minecraft's {@code sendCommand} expects the
     * command WITHOUT the leading slash and adds it itself. Passing "/login pw" would
     * therefore send "//login pw" and fail. This method normalises either form.
     */
    /**
     * Server commands this mod will never send, regardless of which layer asks.
     *
     * Defence in depth: ControlHttpServer gates the request surface, but the escape hatch
     * there (`cmd ...`) already proved that a single gate is not enough. This one sits at
     * the point where a command actually reaches the network, so every caller is covered.
     *
     * `/register` matters because registering an existing character RESETS its saved data.
     */
    private static final java.util.List<String> FORBIDDEN = java.util.List.of("register", "reg");

    /** @return the offending verb, or null when the command is safe to send. */
    static String forbiddenVerb(String command) {
        String current = command == null ? "" : command.trim();
        for (int depth = 0; depth < 5; depth += 1) {
            while (current.startsWith("/")) {
                current = current.substring(1).trim();
            }
            String[] parts = current.split("\\s+", 2);
            String verb = parts[0].toLowerCase(Locale.ROOT);
            if ((verb.equals("cmd") || verb.equals("command")) && parts.length > 1) {
                current = parts[1].trim();
                continue;
            }
            return FORBIDDEN.contains(verb) ? verb : null;
        }
        return null;
    }

    public boolean command(String rawCommand) {
        String blocked = forbiddenVerb(rawCommand);
        if (blocked != null) {
            AgentClientMod.LOGGER.warn("refused to send '{}': it resets player data", blocked);
            return false;
        }
        return onClient(() -> {
            if (mc.player == null || mc.getConnection() == null) {
                return false;
            }
            String cmd = stripLeadingSlashes(rawCommand);
            if (cmd.isEmpty()) {
                return false;
            }
            mc.getConnection().sendCommand(cmd);
            return true;
        });
    }

    /**
     * Deliberately send the command WITH a leading slash.
     *
     * Used only by /diag/slash to prove which form the client wants: if
     * {@code sendCommand} adds its own slash, this sends "//cmd" and the server will not
     * recognise it. Never call this from normal agent code.
     */
    boolean rawCommandWithSlash(String commandWithSlash) {
        return onClient(() -> {
            if (mc.player == null || mc.getConnection() == null) {
                return false;
            }
            mc.getConnection().sendCommand(commandWithSlash);
            return true;
        });
    }

    private static String stripLeadingSlashes(String command) {
        String cmd = command == null ? "" : command.trim();
        while (cmd.startsWith("/")) {
            cmd = cmd.substring(1);
        }
        return cmd;
    }

    public boolean look(double yaw, double pitch) {
        return onClient(() -> {
            if (mc.player == null) {
                return false;
            }
            mc.player.setYRot((float) yaw);
            mc.player.setXRot((float) pitch);
            return true;
        });
    }

    /** Look at a point in the world. */
    public boolean lookAt(double x, double y, double z) {
        return onClient(() -> {
            if (mc.player == null) {
                return false;
            }
            Vec3 target = new Vec3(x, y, z);
            Vec3 eye = mc.player.getEyePosition();
            Vec3 delta = target.subtract(eye);
            double horizontal = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
            float yaw = (float) (Math.toDegrees(Math.atan2(-delta.x, delta.z)));
            float pitch = (float) (-Math.toDegrees(Math.atan2(delta.y, horizontal)));
            mc.player.setYRot(yaw);
            mc.player.setXRot(pitch);
            return true;
        });
    }

    /**
     * What is under the crosshair right now? A fresh client-side raycast.
     *
     * This is "aimed vision": the agent looks at something and asks what it is, exactly like
     * a player reading the block outline. Mining uses it to dig what is already in front of
     * the bot instead of walking (and jumping) to a scanned coordinate.
     *
     * @return a JSON object, or the literal {@code null}
     */
    public String targetJson() {
        return onClient(() -> {
            if (mc.player == null || mc.level == null) {
                return "null";
            }
            HitResult hit = mc.player.pick(4.5D, 1.0F, false);
            if (!(hit instanceof BlockHitResult blockHit)) {
                return "null";
            }
            BlockPos pos = blockHit.getBlockPos();
            Map<String, String> out = new LinkedHashMap<>();
            out.put("name", Json.str(blockNameAt(pos)));
            out.put("position", Json.point(pos.getX(), pos.getY(), pos.getZ()));
            out.put("face", Json.str(blockHit.getDirection().getName()));
            out.put("distance", Json.num(mc.player.getEyePosition().distanceTo(blockHit.getLocation())));
            return Json.obj(out);
        });
    }

    private String blockNameAt(BlockPos pos) {
        if (mc.level == null || pos == null) {
            return "minecraft:air";
        }
        var id = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(pos).getBlock());
        return id == null ? "minecraft:air" : id.toString();
    }

    /** Swap the held item to the given slot, or to the first slot holding itemName. */
    public boolean selectItem(String itemName) {
        return onClient(() -> {
            if (mc.player == null) {
                return false;
            }
            for (int slot = 0; slot < 9; slot++) {
                ItemStack stack = mc.player.getInventory().getItem(slot);
                if (!stack.isEmpty() && stack.getItem().toString() != null && nameOf(stack).equals(itemName)) {
                    mc.player.getInventory().selected = slot;
                    return true;
                }
            }
            return false;
        });
    }

    public boolean dropHeld(boolean all) {
        return onClient(() -> {
            if (mc.player == null) {
                return false;
            }
            mc.player.drop(all);
            return true;
        });
    }

    /** Attack an entity by id until it dies or the timeout expires. */
    /**
     * Attack an entity until it dies or the timeout runs out.
     *
     * Returns **true when the target died**: a mob that drops is a won fight, and the old
     * code answered false for exactly that case, so the skill layer reported "still alive"
     * right after every kill.
     */
    public boolean attack(int entityId, long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        boolean seenAlive = false;
        while (System.currentTimeMillis() < deadline) {
            Boolean alive = onClient(() -> {
                if (mc.player == null || mc.level == null || mc.gameMode == null) {
                    return false;
                }
                Entity target = mc.level.getEntity(entityId);
                if (!(target instanceof LivingEntity living) || !living.isAlive()) {
                    return false;
                }
                if (mc.player.distanceTo(target) > 2.9D) {
                    // Step toward it before swinging, so we are not punching air. Jump when
                    // a step or a target just above us blocks the way (the old code walked
                    // into the ledge under a zombie forever).
                    faceEntity(target);
                    setKey("forward", true);
                    boolean stepUp = mc.player.onGround()
                            && (mc.player.horizontalCollision || living.getY() > mc.player.getY() + 0.5D);
                    setKey("jump", stepUp);
                    return true;
                }
                setKey("forward", false);
                setKey("jump", false);
                faceEntity(target);
                /**
                 * Swing only when the attack meter is charged.
                 *
                 * The old loop clicked every 250 ms regardless. Vanilla scales damage by
                 * the recharge (a spam-clicked sword deals about a fifth of its damage), so
                 * the bot lost fights it should have won. A charged stone sword kills a
                 * zombie in three hits.
                 */
                if (mc.player.getAttackStrengthScale(0.5F) >= 0.92F) {
                    mc.gameMode.attack(mc.player, target);
                    mc.player.swing(InteractionHand.MAIN_HAND);
                }
                return true;
            });
            if (alive == null) {
                setKeyOnClient("forward", false);
                setKeyOnClient("jump", false);
                return false;
            }
            if (!alive) {
                setKeyOnClient("forward", false);
                setKeyOnClient("jump", false);
                // Died during the fight -> killed. Never valid -> failed.
                return seenAlive;
            }
            seenAlive = true;
            sleep(100);
        }
        setKeyOnClient("forward", false);
        setKeyOnClient("jump", false);
        return false;
    }

    // ------------------------------------------------------------ continuous

    /**
     * Walk toward a position. Starts a continuous action and returns immediately; the
     * agent polls {@code /state} to see whether it arrived, and can call {@code /stop}.
     */
    public boolean moveTo(double x, double y, double z, double range) {
        return onClient(() -> {
            if (mc.player == null || mc.level == null) {
                return false;
            }
            this.lastProgress = null;
            this.continuous = new WalkTo(new Vec3(x, y, z), range);
            return true;
        });
    }

    /**
     * Break a block. Continuous: the client must hold the "attack" for several ticks
     * (the server validates dig progress), so this starts an action and the tick handler
     * calls continueDestroyBlock until the block is gone.
     */
    public boolean dig(int x, int y, int z) {
        return onClient(() -> {
            if (mc.player == null || mc.level == null || mc.gameMode == null) {
                return false;
            }
            BlockPos pos = new BlockPos(x, y, z);
            if (mc.level.getBlockState(pos).isAir()) {
                return true; // already gone
            }
            // Stand close enough and face it, otherwise the server ignores the dig.
            double distance = Math.sqrt(mc.player.distanceToSqr(x + 0.5D, y + 0.5D, z + 0.5D));
            if (distance > 4.5D) {
                return false;
            }
            lookAtOnClient(x + 0.5D, y + 0.5D, z + 0.5D);
            this.lastProgress = null;
            this.continuous = new DigBlock(pos);
            return true;
        });
    }

    /**
     * Walk a planned tunnel as ONE continuous action: hold forward, clear whatever blocks the
     * way, jump only real one-block steps, and report the cells actually dug plus the cell
     * that stopped it.
     *
     * This is the "dig while walking" primitive. The Node side computes the stair (quotable,
     * testable, offline); this controller executes it tick by tick, so walking and digging
     * are no longer two alternating HTTP actions with a stop in between - and a step-up is
     * decided from the block's collision shape (a real one-block step with headroom) instead
     * of "collided, therefore jump".
     *
     * @param waypoints feet cells in order ({x, y, z} triples)
     */
    public boolean tunnel(List<int[]> waypoints) {
        return tunnel(waypoints, java.util.Collections.emptyList());
    }

    /**
     * Dig-while-walking with a protection list: any block whose bare name is in
     * `protectBlocks` stops the controller before it is destroyed and reports
     * `target_requires_acquisition` with the exact cell, so Node can run the real
     * take/collection flow instead of losing a vein to a corridor dig (collection plan §6.2).
     */
    public boolean tunnel(List<int[]> waypoints, List<String> protectBlocks) {
        return onClient(() -> {
            if (mc.player == null || mc.level == null || mc.gameMode == null) {
                return false;
            }
            if (waypoints == null || waypoints.isEmpty()) {
                return false;
            }
            List<BlockPos> cells = new ArrayList<>(waypoints.size());
            for (int[] wp : waypoints) {
                cells.add(new BlockPos(wp[0], wp[1], wp[2]));
            }
            java.util.Set<String> protect = new java.util.HashSet<>();
            if (protectBlocks != null) {
                for (String name : protectBlocks) {
                    if (name != null && !name.isBlank()) protect.add(bareName(name));
                }
            }
            this.lastProgress = null;
            this.continuous = new Tunnel(cells, protect);
            return true;
        });
    }

    /**
     * Pillar straight up `count` blocks: jump and place the held block under the feet, the
     * vanilla way out of a 1-wide shaft where the stair climber has no horizontal room.
     * The caller equips a scaffold block first; this controller owns the jump/place timing.
     */
    public boolean pillar(int count) {
        return onClient(() -> {
            if (mc.player == null || mc.level == null || mc.gameMode == null) {
                return false;
            }
            int steps = Math.max(1, Math.min(64, count));
            this.lastProgress = null;
            this.continuous = new Pillar(steps);
            return true;
        });
    }

    /** Place the held item against a block face. */
    public boolean place(int x, int y, int z, String face, String itemName) {
        return onClient(() -> {
            if (mc.player == null || mc.level == null || mc.gameMode == null) {
                return false;
            }
            if (itemName != null && !itemName.isEmpty()) {
                selectItemInClient(itemName);
            }
            BlockPos pos = new BlockPos(x, y, z);
            Direction direction = parseDirection(face);
            Vec3 hit = Vec3.atCenterOf(pos).add(
                    direction.getStepX() * 0.5D, direction.getStepY() * 0.5D, direction.getStepZ() * 0.5D);
            lookAtOnClient(hit.x, hit.y, hit.z);
            BlockHitResult result = new BlockHitResult(hit, direction, pos, false);
            var action = mc.gameMode.useItemOn(mc.player, InteractionHand.MAIN_HAND, result);
            if (action.consumesAction()) {
                mc.player.swing(InteractionHand.MAIN_HAND);
            }
            return true;
        });
    }

    /** Use the held item (eat, throw, place in air). */
    public boolean useItem() {
        return onClient(() -> {
            if (mc.player == null || mc.gameMode == null) {
                return false;
            }
            var action = mc.gameMode.useItem(mc.player, InteractionHand.MAIN_HAND);
            if (action.consumesAction()) {
                mc.player.swing(InteractionHand.MAIN_HAND);
            }
            return true;
        });
    }

    /**
     * Hold the use key for up to `ms`, stopping early when the item finishes being used.
     *
     * Eating is a *held* action in Minecraft: the food is consumed after ~1.6 s of holding
     * the use key, and a single `useItem()` call only starts (and immediately drops) the
     * animation - which is why the bot stood there "clicking bread" and never ate. Holding
     * the key down is exactly what a player does; the item's own use timer does the rest.
     */
    public boolean holdUse(long ms) {
        long budget = Math.max(250L, Math.min(ms, 10000L));
        long started = System.currentTimeMillis();
        long deadline = started + budget;
        setKeyOnClient("use", true);
        while (System.currentTimeMillis() < deadline) {
            Boolean using = onClient(() -> mc.player != null && mc.player.isUsingItem());
            if (using == null) {
                break;
            }
            // Started and finished, or the item is not a held-use item at all.
            if (!using && System.currentTimeMillis() > started + 250L) {
                break;
            }
            sleep(80);
        }
        setKeyOnClient("use", false);
        return true;
    }

    /**
     * Dump the menu the player currently has open, as JSON.
     *
     * The player's own inventory menu (containerId 0) is always open, so this works whether or
     * not a screen is visible. Index layout follows vanilla:
     *
     *   player inventory : 0 result, 1-4 craft grid, 5-8 armour, 9-35 main, 36-44 hotbar, 45 offhand
     *   crafting table   : 0 result, 1-9 grid, 10-36 main, 37-45 hotbar
     *   chest            : 0..n-1 chest, then the player part
     *   furnace          : 0 input, 1 fuel, 2 output, then the player part
     *
     * Every slot carries an `i` (its index for `click`), `item`, `count` and `player` flag.
     */
    public String menuJson() {
        return onClient(() -> {
            if (mc.player == null) {
                return "{\"open\":false,\"reason\":\"not in world\"}";
            }
            AbstractContainerMenu menu = mc.player.containerMenu;
            if (menu == null) {
                return "{\"open\":false,\"reason\":\"no menu\"}";
            }
            java.util.List<String> slots = new java.util.ArrayList<>();
            for (int i = 0; i < menu.slots.size(); i += 1) {
                Slot slot = menu.getSlot(i);
                ItemStack stack = slot.getItem();
                java.util.Map<String, String> entry = new LinkedHashMap<>();
                entry.put("i", Json.num(i));
                entry.put("item", stack.isEmpty() ? "null" : Json.str(nameOf(stack)));
                entry.put("count", Json.num(stack.isEmpty() ? 0 : stack.getCount()));
                entry.put("player", Json.bool(slot.container instanceof net.minecraft.world.entity.player.Inventory));
                slots.add(Json.obj(entry));
            }
            ItemStack carried = menu.getCarried();
            java.util.Map<String, String> carriedJson = new LinkedHashMap<>();
            carriedJson.put("item", carried.isEmpty() ? "null" : Json.str(nameOf(carried)));
            carriedJson.put("count", Json.num(carried.isEmpty() ? 0 : carried.getCount()));

            java.util.Map<String, String> out = new LinkedHashMap<>();
            out.put("open", Json.bool(true));
            out.put("containerId", Json.num(menu.containerId));
            out.put("size", Json.num(menu.slots.size()));
            out.put("menuClass", Json.str(menu.getClass().getSimpleName()));
            out.put("carried", Json.obj(carriedJson));
            out.put("slots", Json.arr(slots));
            return Json.obj(out);
        });
    }

    /**
     * Click a slot in the currently open menu.
     *
     * `mode` is `pickup` (default), `quickmove` (shift-click) or `swap`. This is the same path
     * the vanilla mouse takes (`handleInventoryMouseClick`), so servers see ordinary play.
     */
    public boolean clickSlot(int slot, int button, String mode) {
        return onClient(() -> {
            if (mc.player == null || mc.gameMode == null) {
                return false;
            }
            AbstractContainerMenu menu = mc.player.containerMenu;
            if (menu == null || slot < 0 || slot >= menu.slots.size()) {
                return false;
            }
            ClickType type = switch (mode == null ? "" : mode.toLowerCase(Locale.ROOT)) {
                case "quickmove", "quick_move", "shift" -> ClickType.QUICK_MOVE;
                case "swap" -> ClickType.SWAP;
                case "clone" -> ClickType.CLONE;
                default -> ClickType.PICKUP;
            };
            mc.gameMode.handleInventoryMouseClick(menu.containerId, slot, button, type, mc.player);
            return true;
        });
    }

    /**
     * Close the currently open container (no-op when only the inventory menu is open).
     *
     * Deliberately does NOT dismiss the pause menu or chat: both belong to the operator.
     * The agent waits for the human to come back instead of closing their screen - the
     * earlier "close anything" version fixed the agent's "cannot walk: PauseScreen" stall
     * but stole the operator's pause menu, which is worse.
     */
    public boolean closeMenu() {
        return onClient(() -> {
            if (mc.player == null) {
                return false;
            }
            mc.player.closeContainer();
            return true;
        });
    }

    /** Stop whatever continuous action is running. */
    public boolean stop() {
        return onClient(() -> {
            Continuous interrupted = this.continuous;
            this.continuous = null;
            setKeyInClient("forward", false);
            setKeyInClient("jump", false);
            setKeyInClient("sprint", false);
            if (mc.gameMode != null && mc.gameMode.isDestroying()) {
                mc.gameMode.stopDestroyBlock();
            }
            /**
             * Keep a verdict for whoever is waiting on /progress: an interrupted action is
             * not a success. Without this the stopped action leaves no trace and a late poll
             * defaults to "done".
             */
            if (interrupted != null) {
                this.lastProgress = Json.obj(new java.util.LinkedHashMap<>(java.util.Map.of(
                        "busy", Json.bool(false),
                        "action", Json.str(interrupted.describe()),
                        "done", Json.bool(false),
                        "failed", Json.bool(true),
                        "reason", Json.str("stopped")
                )));
            }
            return true;
        });
    }

    // -------------------------------------------------------------- tick pump

    /** Called from the client tick; advances whatever continuous action is running. */
    public void tick() {
        Continuous action = this.continuous;
        if (action == null) {
            return;
        }
        try {
            if (action.tick(mc)) {
                // Capture the verdict before dropping the action; see lastProgress.
                this.lastProgress = action.progressJson();
                this.continuous = null;
            }
        } catch (Exception e) {
            AgentClientMod.LOGGER.warn("continuous action failed: {}", e.getMessage());
            this.lastProgress = Json.obj(new java.util.LinkedHashMap<>(java.util.Map.of(
                    "busy", Json.bool(false),
                    "action", Json.str(action.describe()),
                    "done", Json.bool(false),
                    "failed", Json.bool(true),
                    "reason", Json.str("crashed")
            )));
            this.continuous = null;
        }
    }

    public boolean isBusy() {
        return this.continuous != null;
    }

    public String busyWith() {
        Continuous action = this.continuous;
        return action == null ? null : action.describe();
    }

    /** Progress report for the agent, so it can poll instead of guessing. */
    public String progressJson() {
        Continuous action = this.continuous;
        if (action == null) {
            if (this.lastProgress != null) {
                return this.lastProgress;
            }
            return Json.obj(new java.util.LinkedHashMap<>(java.util.Map.of("busy", Json.bool(false))));
        }
        return action.progressJson();
    }

    // ------------------------------------------------------------ continuous impls

    private interface Continuous {
        /** @return true when finished (successfully or not) */
        boolean tick(Minecraft mc);

        String describe();

        String progressJson();
    }

    /** Walk toward a point by holding forward; the game does the physics. */
    private final class WalkTo implements Continuous {
        /**
         * How many jumps in a row without getting closer mean "this is a wall, not a step".
         *
         * The jump key is pressed whenever we collide while grounded - that is how a player
         * climbs a 1-block step, and it is also how a bot ends up pogoing against a 2-block
         * wall or a fence for the full 60s timeout, which looks broken and wastes the trip.
         * A real step-up needs one or two jumps and covers ground between them, so four
         * fruitless jumps is a wall.
         */
        private static final int MAX_BLOCKED_JUMPS = 4;
        /** ...and it must have been fruitless for at least this long, to ignore one bad tick. */
        private static final long JUMP_GIVE_UP_MS = 1200L;
        /** No progress at all (not even a jump) for this long: stuck, whatever the cause. */
        private static final long STUCK_MS = 6000L;
        /** After this many fruitless jumps, try backing off + sidestepping instead of pogoing. */
        private static final int JUMPS_BEFORE_REPOSITION = 2;
        /** ...and the stall must be at least this old before the reposition triggers. */
        private static final long NO_PROGRESS_BEFORE_REPOSITION_MS = 800L;
        /** How long one back-off + sidestep window lasts. */
        private static final long REPOSITION_MS = 500L;
        /** Attempts before giving up and reporting jump-blocked. */
        private static final int MAX_REPOSITIONS = 2;

        private final Vec3 target;
        private final double range;
        /** When true, only "standing in the target block" counts as arrival. */
        private final boolean strictBlock;
        private final long started = System.currentTimeMillis();
        private boolean arrived;
        private boolean failed;
        private String reason = "";
        /**
         * Closest we have ever been to the target, in **three** dimensions.
         *
         * Three, not horizontal: climbing a ladder or swimming straight up changes no
         * horizontal coordinate at all, and a horizontal-only measure would call a perfectly
         * good vertical climb "no progress" after six seconds and abort it.
         */
        private double bestDistance = Double.MAX_VALUE;
        private long lastProgressAt = System.currentTimeMillis();
        private int jumpsSinceProgress;
        private boolean jumpHeld;
        /** Un-stick manoeuvre state: the sidestep direction alternates between attempts. */
        private int sidestep = 1;
        private long repositionUntil;
        private int repositionCount;
        /** Time spent with a GUI open: the human is busy, so it must not count as stall. */
        private long pausedMs;
        private long screenOpenedAt = -1L;

        WalkTo(Vec3 target, double range) {
            this.target = target;
            this.range = range <= 0 ? 1.5D : range;
            /**
             * A sub-block range means "stand in that block".
             *
             * Waypoints normally stop within `range` of the coordinate, which is right for
             * walking routes; a 1-block tunnel step needs the block itself, so for tiny
             * ranges only the in-block test below counts as arrival.
             */
            this.strictBlock = range > 0 && range <= 0.5D;
        }

        @Override
        public boolean tick(Minecraft mc) {
            LocalPlayer player = mc.player;
            if (player == null) {
                return true;
            }
            double dx = target.x - player.getX();
            double dy = target.y - player.getY();
            double dz = target.z - player.getZ();
            double horizontal = Math.sqrt(dx * dx + dz * dz);
            double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            long now = System.currentTimeMillis();

            /**
             * Arrived = standing in the target block, or close enough to the coordinate.
             *
             * The distance check alone cannot express "step into the next block": moveto
             * coordinates are floored to block corners, so stopping `range` short of the
             * corner leaves the bot in the previous block and a tunnel routine re-digs the
             * same cell forever - and aiming past the corner walks it into the un-dug wall.
             * The block test fires the moment the feet cross into the target cell.
             */
            boolean inTargetBlock = (int) Math.floor(player.getX()) == (int) Math.floor(target.x)
                    && (int) Math.floor(player.getZ()) == (int) Math.floor(target.z)
                    && Math.abs(player.getY() - target.y) < 2.0D;
            if (inTargetBlock || (!strictBlock && horizontal <= range)) {
                arrived = true;
                release();
                return true;
            }
            /**
             * A GUI screen open means the player is busy - the game ignores every movement
             * key, so "no progress" here is not a stuck walk, it is a human typing a command
             * or looking in a chest. Freeze the stall clocks instead of failing the task;
             * the moment the screen closes the walk resumes.
             */
            if (mc.screen != null) {
                if (screenOpenedAt < 0L) {
                    screenOpenedAt = now;
                }
                lastProgressAt = now;
                jumpsSinceProgress = 0;
                return false;
            }
            if (screenOpenedAt >= 0L) {
                pausedMs += now - screenOpenedAt;
                screenOpenedAt = -1L;
            }

            if (now - started - pausedMs > 60_000L) {
                failed = true;
                reason = "timeout";
                release();
                return true;
            }

            /**
             * Getting closer counts as progress and clears the jump streak - but only when
             * the feet are actually on something.
             *
             * A failed jump at a wall still lifts the body toward a higher waypoint for a
             * moment, and that transient rise used to count as progress: the streak reset on
             * every hop and the bot jumped nine times at the same stone step (live
             * 2026-10-08). In water the bot is rarely onGround, so swimming still counts.
             */
            if ((player.onGround() || player.isInWater()) && distance < bestDistance - 0.25D) {
                bestDistance = distance;
                lastProgressAt = now;
                jumpsSinceProgress = 0;
            }

            // Face the target, then walk. Jump when we are blocked by a 1-block step.
            lookAtOnClient(target.x, player.getY() + 1.0D, target.z);

            /**
             * Un-stick: after a couple of fruitless jumps, back off and sidestep for a
             * moment, then approach again from a slightly different position. Pogoing in
             * place cannot clear a half-blocked body; a short reposition can.
             */
            if (repositionUntil == 0L
                    && jumpsSinceProgress >= JUMPS_BEFORE_REPOSITION
                    && now - lastProgressAt > NO_PROGRESS_BEFORE_REPOSITION_MS
                    && repositionCount < MAX_REPOSITIONS) {
                repositionCount += 1;
                sidestep = -sidestep;
                repositionUntil = now + REPOSITION_MS;
                jumpsSinceProgress = 0;
                AgentClientMod.LOGGER.info(
                        "walkTo: jump blocked at {} - backing off and sidestepping (attempt {}/{})",
                        target, repositionCount, MAX_REPOSITIONS);
            }
            if (repositionUntil > now) {
                setKeyInClient("forward", false);
                setKeyInClient("sprint", false);
                setKeyInClient("jump", false);
                jumpHeld = false;
                setKeyInClient("back", true);
                setKeyInClient(sidestep > 0 ? "left" : "right", true);
                return false;
            }
            if (repositionUntil != 0L) {
                setKeyInClient("back", false);
                setKeyInClient("left", false);
                setKeyInClient("right", false);
                repositionUntil = 0L;
            }

            setKeyInClient("forward", true);
            setKeyInClient("sprint", horizontal > 3.0D);
            /**
             * In water the jump key is the swim-up key.
             *
             * Without holding it the bot bobs at the surface, cannot climb a 1-block bank
             * it is pressed against, and the walk dies as "stuck": the cross-river test
             * swam thirteen blocks and then stalled at the far bank for exactly this
             * reason. Hold it while the waypoint is at or above our feet, or while a bank
             * is blocking us; a waypoint below us (a dive) still lets the bot sink.
             */
            boolean inWater = player.isInWater();
            boolean swimUp = inWater && (dy > -0.1D || player.horizontalCollision);
            if (swimUp) {
                setKeyInClient("jump", true);
                jumpHeld = true; // not a blocked step-up: do not count it toward the give-up
            } else if (player.horizontalCollision && player.onGround()) {
                setKeyInClient("jump", true);
                if (!jumpHeld) {
                    jumpHeld = true;
                    jumpsSinceProgress++;
                }
            } else {
                setKeyInClient("jump", false);
                jumpHeld = false;
            }

            /**
             * Give up on a wall instead of pogoing at it.
             *
             * The agent's walker has a matching rule (WaypointWalker's jump streak) and
             * answers this reason by trying a different direction; reporting it *quickly* is
             * the whole point, because the agent cannot help while this action is still
             * holding the forward key.
             */
            if (jumpsSinceProgress >= MAX_BLOCKED_JUMPS && now - lastProgressAt > JUMP_GIVE_UP_MS) {
                failed = true;
                reason = "jump-blocked";
                release();
                return true;
            }
            if (now - lastProgressAt > STUCK_MS) {
                failed = true;
                reason = "stuck";
                release();
                return true;
            }
            return false;
        }

        /** Let go of the movement keys before ending the action. */
        private void release() {
            setKeyInClient("forward", false);
            setKeyInClient("sprint", false);
            setKeyInClient("jump", false);
            setKeyInClient("back", false);
            setKeyInClient("left", false);
            setKeyInClient("right", false);
            jumpHeld = false;
        }

        @Override
        public String describe() {
            return "walkTo";
        }

        @Override
        public String progressJson() {
            Map<String, String> map = new java.util.LinkedHashMap<>();
            map.put("busy", Json.bool(!arrived && !failed));
            map.put("action", Json.str("walkTo"));
            map.put("arrived", Json.bool(arrived));
            map.put("failed", Json.bool(failed));
            map.put("reason", Json.str(reason));
            map.put("target", Json.point(target.x, target.y, target.z));
            map.put("jumpsBlocked", Json.num(jumpsSinceProgress));
            return Json.obj(map);
        }
    }

    /** Break a block by holding the attack key, the way a player does. */
    private final class DigBlock implements Continuous {
        private final BlockPos pos;
        private final long started = System.currentTimeMillis();
        private boolean done;
        private boolean failed;
        private String reason = "";
        private boolean started_;

        DigBlock(BlockPos pos) {
            this.pos = pos;
        }

        @Override
        public boolean tick(Minecraft mc) {
            LocalPlayer player = mc.player;
            ClientLevel level = mc.level;
            if (player == null || level == null || mc.gameMode == null) {
                return true;
            }
            if (level.getBlockState(pos).isAir()) {
                done = true;
                return true;
            }
            if (System.currentTimeMillis() - started > 30_000L) {
                failed = true;
                reason = "timeout";
                mc.gameMode.stopDestroyBlock();
                return true;
            }
            // Re-aim every tick: the server rejects dig progress when the player is not
            // looking at the block.
            lookAtOnClient(pos.getX() + 0.5D, pos.getY() + 0.5D, pos.getZ() + 0.5D);

            if (!started_) {
                mc.gameMode.startDestroyBlock(pos, faceToward(pos, player));
                started_ = true;
            } else {
                mc.gameMode.continueDestroyBlock(pos, faceToward(pos, player));
            }
            player.swing(InteractionHand.MAIN_HAND);
            return false;
        }

        @Override
        public String describe() {
            return "dig";
        }

        @Override
        public String progressJson() {
            Map<String, String> map = new java.util.LinkedHashMap<>();
            map.put("busy", Json.bool(!done && !failed));
            map.put("action", Json.str("dig"));
            map.put("done", Json.bool(done));
            map.put("failed", Json.bool(failed));
            map.put("reason", Json.str(reason));
            map.put("target", Json.point(pos.getX(), pos.getY(), pos.getZ()));
            return Json.obj(map);
        }
    }

    /**
     * Dig-while-walking controller for one planned tunnel (see {@link #tunnel}).
     *
     * Per tick: steer to the current waypoint's block centre, hold forward, and decide the
     * next action from the collision shapes of the column being entered -
     *
     *   - both cells free  -> just walk (a descent is walked off the edge, never jumped);
     *   - foot solid, head free, own headroom free -> a real one-block step: jump while
     *     touching it (pressed once per landing, capped, so it can never pogo a wall);
     *   - anything else solid -> aim at the blocking cell and hold the attack until it is
     *     air, then keep walking. No separate dig action, no stop between steps.
     *
     * Arrival is strict ("feet block == waypoint block", y included). Giving up names the
     * cell and block so the planner can clear exactly that cell and retry.
     */
    private final class Tunnel implements Continuous {
        private static final long TOTAL_TIMEOUT_MS = 180_000L;
        private static final long STUCK_MS = 8_000L;
        private static final long DIG_STALL_MS = 4_000L;
        private static final int MAX_BLOCKED_JUMPS = 3;
        private static final int MAX_DIGS = 256;

        private final List<BlockPos> waypoints;
        /** Bare block names the tunnel must never destroy (target ores). */
        private final java.util.Set<String> protect;
        private final long started = System.currentTimeMillis();
        /** Resolved on the first tick from the body's actual position (retries skip ahead). */
        private int index = -1;
        private boolean done;
        private boolean failed;
        private String reason = "";
        private BlockPos failCell;
        private String failBlock;
        private int jumpsSinceProgress;
        private boolean jumpHeld;
        private double bestDistance = Double.MAX_VALUE;
        private long lastProgressAt = System.currentTimeMillis();
        private BlockPos digTarget;
        private long digStartedAt;
        private int digs;
        private final List<BlockPos> dug = new ArrayList<>();

        Tunnel(List<BlockPos> waypoints, java.util.Set<String> protect) {
            this.waypoints = waypoints;
            this.protect = protect;
        }

        @Override
        public boolean tick(Minecraft mc) {
            LocalPlayer player = mc.player;
            ClientLevel level = mc.level;
            if (player == null || level == null || mc.gameMode == null) {
                fail("no-body", null, null);
                release();
                return true;
            }
            long now = System.currentTimeMillis();
            if (now - started > TOTAL_TIMEOUT_MS) {
                fail("timeout", null, null);
                release();
                return true;
            }
            if (index < 0) {
                int best = 0;
                double bestD = Double.MAX_VALUE;
                for (int i = 0; i < waypoints.size(); i += 1) {
                    double d = player.distanceToSqr(Vec3.atCenterOf(waypoints.get(i)));
                    if (d < bestD) {
                        bestD = d;
                        best = i;
                    }
                }
                index = best;
            }
            if (index >= waypoints.size()) {
                release();
                done = true;
                return true;
            }
            BlockPos wp = waypoints.get(index);

            // Strict arrival: the feet block is the waypoint block, y included.
            if ((int) Math.floor(player.getX()) == wp.getX()
                    && (int) Math.floor(player.getZ()) == wp.getZ()
                    && Math.abs(player.getY() - wp.getY()) < 0.5D) {
                index += 1;
                bestDistance = Double.MAX_VALUE;
                lastProgressAt = now;
                jumpsSinceProgress = 0;
                digTarget = null;
                return false;
            }

            double distance = player.position().distanceTo(Vec3.atCenterOf(wp));
            /**
             * Same rule as WalkTo: a failed jump's transient rise must not count as progress,
             * or the blocked-jump counter resets forever and the bot pogos at one step.
             */
            if ((player.onGround() || player.isInWater()) && distance < bestDistance - 0.2D) {
                bestDistance = distance;
                lastProgressAt = now;
                jumpsSinceProgress = 0;
            }
            if (now - lastProgressAt > STUCK_MS) {
                fail("stuck", wp, null);
                release();
                return true;
            }

            int fx = (int) Math.floor(player.getX());
            int fy = (int) Math.floor(player.getY());
            int fz = (int) Math.floor(player.getZ());
            int dx = wp.getX() - fx;
            int dz = wp.getZ() - fz;
            int sx = Math.abs(dx) >= Math.abs(dz) ? Integer.signum(dx) : 0;
            int sz = sx == 0 ? Integer.signum(dz) : 0;
            BlockPos frontFoot = new BlockPos(fx + sx, fy, fz + sz);
            BlockPos frontHead = frontFoot.above();
            boolean footSolid = isSolid(level, frontFoot);
            boolean headSolid = isSolid(level, frontHead);
            boolean ownCeiling = isSolid(level, new BlockPos(fx, fy + 2, fz));

            // Steer at the block CENTRE, not the integer corner: walking at a corner is what
            // makes a step-up clip the edge and fall back into a jump loop.
            lookAtOnClient(wp.getX() + 0.5D, player.getY() + 1.0D, wp.getZ() + 0.5D);
            setKeyInClient("forward", true);
            setKeyInClient("sprint", false);

            BlockPos toDig = null;
            boolean stepUp = false;
            int wpDy = wp.getY() - fy;
            if (wpDy > 0) {
                /**
                 * Climb step: the block at frontFoot is the STEP to jump onto - digging it
                 * removes the only place to land, which is why ascents used to fall back to
                 * the slow Node stair. Clear the same three cells the quote's stepCells use,
                 * in the same order: our own ceiling, the cell the feet move into, then the
                 * cell the head moves into.
                 */
                BlockPos newHead = frontHead.above();
                if (ownCeiling) {
                    toDig = new BlockPos(fx, fy + 2, fz);
                } else if (headSolid) {
                    toDig = frontHead;
                } else if (isSolid(level, newHead)) {
                    toDig = newHead;
                } else {
                    stepUp = true;
                }
            } else if (wpDy < 0) {
                /**
                 * Descent step: dig the next column down to the new foot level first, then
                 * the two cells above it - the same three cells the quote names. A natural
                 * slope already has them open, so this falls through to walking and the
                 * anti-fall probe guards the drop.
                 */
                BlockPos newFoot = new BlockPos(fx + sx, fy - 1, fz + sz);
                if (isSolid(level, newFoot)) {
                    toDig = newFoot;
                } else if (footSolid) {
                    toDig = frontFoot;
                } else if (headSolid) {
                    toDig = frontHead;
                }
            } else if (footSolid && !headSolid) {
                if (!ownCeiling) {
                    stepUp = true;
                } else {
                    toDig = new BlockPos(fx, fy + 2, fz); // clear our own headroom first
                }
            } else if (footSolid) {
                toDig = frontFoot; // a full-height wall: break the lower cell first
            } else if (headSolid) {
                toDig = frontHead; // a low lintel
            }

            if (toDig != null) {
                if (!protect.isEmpty() && protect.contains(bareName(blockName(level, toDig)))) {
                    fail("target_requires_acquisition", toDig, blockName(level, toDig));
                    release();
                    return true;
                }
                if (isLiquid(level, toDig)) {
                    fail("hazard", toDig, blockName(level, toDig));
                    release();
                    return true;
                }
                if (isFallingAbove(level, toDig)) {
                    fail("falling", toDig, blockName(level, toDig));
                    release();
                    return true;
                }
                if (digTarget == null || !digTarget.equals(toDig)) {
                    digTarget = toDig;
                    digStartedAt = now;
                    mc.gameMode.stopDestroyBlock();
                    mc.gameMode.startDestroyBlock(toDig, faceToward(toDig, player));
                } else {
                    mc.gameMode.continueDestroyBlock(toDig, faceToward(toDig, player));
                }
                lookAtOnClient(toDig.getX() + 0.5D, toDig.getY() + 0.5D, toDig.getZ() + 0.5D);
                player.swing(InteractionHand.MAIN_HAND);
                if (now - digStartedAt > DIG_STALL_MS) {
                    fail("unbreakable", toDig, blockName(level, toDig));
                    release();
                    return true;
                }
                setKeyInClient("jump", false);
                jumpHeld = false;
                return false;
            }

            if (digTarget != null) {
                if (level.getBlockState(digTarget).isAir()) {
                    digs += 1;
                    if (dug.size() < MAX_DIGS) dug.add(digTarget);
                    if (digs > MAX_DIGS) {
                        fail("dig-budget", digTarget, null);
                        release();
                        return true;
                    }
                }
                digTarget = null;
                digStartedAt = 0L;
                mc.gameMode.stopDestroyBlock();
            }

            if (player.isInWater()) {
                // The swim-up key doubles as jump; a flooded pocket must not sink the walk.
                setKeyInClient("jump", true);
                jumpHeld = true;
                return false;
            }

            if (stepUp) {
                boolean press = player.onGround() && player.horizontalCollision;
                setKeyInClient("jump", press);
                if (press && !jumpHeld) jumpsSinceProgress += 1;
                jumpHeld = press;
                if (jumpsSinceProgress >= MAX_BLOCKED_JUMPS && now - lastProgressAt > 1500L) {
                    fail("jump-blocked", frontFoot, blockName(level, frontFoot));
                    release();
                    return true;
                }
            } else {
                /**
                 * Anti-fall: this is a plain walk (not a step-up), so the next thing the feet
                 * meet is whatever lies under the front cell. Probe down: a floor within two
                 * blocks is an ordinary step down (or already flat ground); three or more air
                 * (a ledge over a cave, ravine or a column someone mined out) or liquid first
                 * (walking straight into a pool/lava pocket) is refused before the feet leave
                 * the ground.
                 *
                 * The Node side pre-checks the quoted waypoints against its own scan; this
                 * tick-level probe is what catches a world that changed after that scan, which
                 * a one-shot pre-check can never see.
                 */
                BlockPos stopCell = null;
                String stopBlock = null;
                int fall = 0;
                for (int i = 1; i <= 3; i += 1) {
                    BlockPos probe = frontFoot.below(i);
                    if (isLiquid(level, probe)) {
                        stopCell = probe;
                        stopBlock = blockName(level, probe);
                        break;
                    }
                    if (isSolid(level, probe)) break;
                    fall = i;
                    stopCell = probe;
                }
                if (stopBlock != null || fall > 2) {
                    fail("ledge", stopCell, stopBlock);
                    release();
                    return true;
                }
                setKeyInClient("jump", false);
                jumpHeld = false;
            }
            return false;
        }

        private void fail(String why, BlockPos cell, String block) {
            failed = true;
            reason = why;
            failCell = cell;
            failBlock = block;
        }

        private void release() {
            setKeyInClient("forward", false);
            setKeyInClient("sprint", false);
            setKeyInClient("jump", false);
            jumpHeld = false;
            if (mc.gameMode != null && mc.gameMode.isDestroying()) {
                mc.gameMode.stopDestroyBlock();
            }
        }

        @Override
        public String describe() {
            return "tunnel";
        }

        @Override
        public String progressJson() {
            Map<String, String> map = new LinkedHashMap<>();
            map.put("busy", Json.bool(!done && !failed));
            map.put("action", Json.str("tunnel"));
            map.put("done", Json.bool(done));
            map.put("failed", Json.bool(failed));
            map.put("reason", Json.str(reason));
            map.put("index", Json.num(index));
            map.put("waypoints", Json.num(waypoints.size()));
            map.put("dug", Json.num(digs));
            map.put("jumpsBlocked", Json.num(jumpsSinceProgress));
            if (failCell != null) {
                map.put("cell", Json.point(failCell.getX(), failCell.getY(), failCell.getZ()));
            }
            if (failBlock != null) {
                map.put("block", Json.str(failBlock));
            }
            StringBuilder cells = new StringBuilder("[");
            for (int i = 0; i < dug.size(); i += 1) {
                if (i > 0) {
                    cells.append(',');
                }
                BlockPos p = dug.get(i);
                cells.append(Json.point(p.getX(), p.getY(), p.getZ()));
            }
            cells.append(']');
            map.put("dugCells", cells.toString());
            return Json.obj(map);
        }
    }

    /**
     * Jump-and-place pillar: rise one block per hop by putting the held block under the feet.
     *
     * This is the move a 1-wide shaft needs: the stair climber has no horizontal room per
     * step, and the walker cannot jump onto a block it is already pressed against (live
     * 2026-10-10: the bot oscillated at (5,-59,171) -> (6,-58,171) until the run died).
     * Each step: stand on solid ground, jump, and while airborne click the top face of the
     * floor block so the block appears in the cell the feet just left; land on it, repeat.
     */
    private final class Pillar implements Continuous {
        private static final long STEP_TIMEOUT_MS = 4_000L;
        private static final long TOTAL_TIMEOUT_MS = 60_000L;
        /**
         * Feet must clear the cell before a block placed inside it is legal: the bounding box
         * bottom has to sit above the cell's top face (1.0), not merely overlap less.
         */
        private static final double PLACE_CLEARANCE = 1.0D;
        /** The game may need a tick or two before the jump actually lifts us. */
        private static final long JUMP_GRACE_MS = 300L;
        private static final int MAX_ATTEMPTS_PER_STEP = 3;

        private final int targetSteps;
        private final long started = System.currentTimeMillis();
        private int steps;
        private boolean jumping;
        private long stepStartedAt = System.currentTimeMillis();
        private int attempts;
        private int baseX;
        private int baseY;
        private int baseZ;
        private boolean done;
        private boolean failed;
        private String reason = "";
        private BlockPos failCell;
        /**
         * Per-hop evidence (plan §5.4.1): the cell the hop started from, the cell it landed
         * in and every block actually placed. Without these, Node can only trust `steps`,
         * and the live retry bug hid behind exactly that.
         */
        private BlockPos actionStart;
        private BlockPos actionEnd;
        private BlockPos hopStart;
        private final List<BlockPos> placedCells = new ArrayList<>();
        /** Live diagnostics for a failed hop: how high the jump actually got, what was held, what the floor was. */
        private double hopPeakY = 0.0D;
        private String failDetail = "";

        Pillar(int targetSteps) {
            this.targetSteps = targetSteps;
        }

        @Override
        public boolean tick(Minecraft mc) {
            LocalPlayer player = mc.player;
            ClientLevel level = mc.level;
            if (player == null || level == null || mc.gameMode == null) {
                fail("no-body", null);
                release();
                return true;
            }
            long now = System.currentTimeMillis();
            if (now - started > TOTAL_TIMEOUT_MS) {
                fail("timeout", null);
                release();
                return true;
            }
            if (steps >= targetSteps) {
                release();
                done = true;
                return true;
            }

            if (player.onGround()) {
                if (jumping) {
                    int landedY = (int) Math.floor(player.getY());
                    if (landedY == baseY + 1) {
                        steps += 1; // the placed block held: on to the next hop
                        hopPeakY = 0.0D;
                        if (hopStart != null) {
                            placedCells.add(hopStart);
                            actionEnd = new BlockPos(
                                (int) Math.floor(player.getX()),
                                landedY,
                                (int) Math.floor(player.getZ())
                            );
                        }
                        jumping = false;
                        attempts = 0;
                    } else if (now - stepStartedAt < JUMP_GRACE_MS) {
                        return false; // the jump is queued but not applied yet
                    } else if (landedY == baseY) {
                        attempts += 1; // placement refused / block gone: try the hop again
                        jumping = false;
                        if (attempts >= MAX_ATTEMPTS_PER_STEP) {
                            failDetail = String.format(
                                    java.util.Locale.ROOT,
                                    "peak+%.2f held=%s floor=%s",
                                    hopPeakY - baseY,
                                    itemNameOf(player.getMainHandItem()),
                                    blockName(level, new BlockPos(baseX, baseY - 1, baseZ)));
                            fail("place-failed", new BlockPos(baseX, baseY, baseZ));
                            release();
                            return true;
                        }
                        hopPeakY = 0.0D;
                    } else {
                        fail("moved", new BlockPos(baseX, baseY, baseZ));
                        release();
                        return true;
                    }
                }
                if (steps >= targetSteps) {
                    release();
                    done = true;
                    return true;
                }
                if (!jumping) {
                    int fx = (int) Math.floor(player.getX());
                    int fy = (int) Math.floor(player.getY());
                    int fz = (int) Math.floor(player.getZ());
                    BlockPos floor = new BlockPos(fx, fy - 1, fz);
                    BlockPos aboveHead = new BlockPos(fx, fy + 2, fz);
                    if (!isSolid(level, floor)) {
                        fail("no-floor", floor);
                        release();
                        return true;
                    }
                    if (isSolid(level, aboveHead)) {
                        fail("no-headroom", aboveHead);
                        release();
                        return true;
                    }
                    if (!(player.getMainHandItem().getItem() instanceof net.minecraft.world.item.BlockItem)) {
                        fail("no-block", floor);
                        release();
                        return true;
                    }
                    baseX = fx;
                    baseY = fy;
                    baseZ = fz;
                    if (actionStart == null) actionStart = new BlockPos(fx, fy, fz);
                    hopStart = new BlockPos(fx, fy, fz);
                    setKeyInClient("jump", true);
                    jumping = true;
                    stepStartedAt = now;
                }
                return false;
            }

            // Airborne: one hop per step, so let the jump key go immediately.
            setKeyInClient("jump", false);
            hopPeakY = Math.max(hopPeakY, player.getY());
            if (now - stepStartedAt > STEP_TIMEOUT_MS) {
                fail("step-timeout", new BlockPos(baseX, baseY, baseZ));
                release();
                return true;
            }
            BlockPos target = new BlockPos(baseX, baseY, baseZ);
            if (isSolid(level, target)) {
                return false; // placed; the landing check above finishes the step
            }
            if (player.getY() < baseY + PLACE_CLEARANCE) {
                return false; // still too low - a block placed now would clip our own body
            }
            place(baseX, baseY - 1, baseZ, "up", "");
            return false;
        }

        private void fail(String why, BlockPos cell) {
            failed = true;
            reason = why;
            failCell = cell;
        }

        private String itemNameOf(net.minecraft.world.item.ItemStack stack) {
            if (stack == null || stack.isEmpty()) return "empty";
            return net.minecraft.core.registries.BuiltInRegistries.ITEM
                    .getKey(stack.getItem())
                    .toString();
        }

        private void release() {
            setKeyInClient("jump", false);
            setKeyInClient("forward", false);
            setKeyInClient("sprint", false);
        }

        @Override
        public String describe() {
            return "pillar";
        }

        @Override
        public String progressJson() {
            Map<String, String> map = new LinkedHashMap<>();
            map.put("busy", Json.bool(!done && !failed));
            map.put("action", Json.str("pillar"));
            map.put("done", Json.bool(done));
            map.put("failed", Json.bool(failed));
            map.put("reason", Json.str(reason));
            map.put("steps", Json.num(steps));
            map.put("target", Json.num(targetSteps));
            if (actionStart != null) {
                map.put("start", Json.point(actionStart.getX(), actionStart.getY(), actionStart.getZ()));
            }
            if (actionEnd != null) {
                map.put("end", Json.point(actionEnd.getX(), actionEnd.getY(), actionEnd.getZ()));
            }
            if (!placedCells.isEmpty()) {
                List<String> placed = new ArrayList<>();
                for (BlockPos cell : placedCells) {
                    placed.add(Json.point(cell.getX(), cell.getY(), cell.getZ()));
                }
                map.put("placedCells", Json.arr(placed));
            }
            if (failCell != null) {
                map.put("cell", Json.point(failCell.getX(), failCell.getY(), failCell.getZ()));
            }
            if (!failDetail.isEmpty()) {
                map.put("detail", Json.str(failDetail));
            }
            return Json.obj(map);
        }
    }

    /** Collision-shape solidity, the same test vanilla movement uses. */
    private static boolean isSolid(ClientLevel level, BlockPos pos) {
        return !level.getBlockState(pos).getCollisionShape(level, pos).isEmpty();
    }

    private static boolean isLiquid(ClientLevel level, BlockPos pos) {
        return !level.getBlockState(pos).getFluidState().isEmpty();
    }

    private static boolean isFallingAbove(ClientLevel level, BlockPos pos) {
        String name = blockName(level, pos.above());
        return name.endsWith("sand") || name.endsWith("gravel");
    }

    private static String blockName(ClientLevel level, BlockPos pos) {
        return net.minecraft.core.registries.BuiltInRegistries.BLOCK
                .getKey(level.getBlockState(pos).getBlock())
                .toString();
    }

    /** "minecraft:diamond_ore" -> "diamond_ore"; other namespaces keep their name part. */
    private static String bareName(String name) {
        if (name == null) return "";
        int i = name.indexOf(':');
        return i < 0 ? name : name.substring(i + 1);
    }

    // ------------------------------------------------------------------ helpers

    /** Which face of the block the player is looking at. */
    private static Direction faceToward(BlockPos pos, LocalPlayer player) {
        Vec3 eye = player.getEyePosition();
        Vec3 centre = Vec3.atCenterOf(pos);
        Vec3 delta = eye.subtract(centre);
        return Direction.getNearest(delta.x, delta.y, delta.z);
    }

    private static Direction parseDirection(String face) {
        if (face == null) {
            return Direction.UP;
        }
        return switch (face.toLowerCase(Locale.ROOT)) {
            case "down" -> Direction.DOWN;
            case "north" -> Direction.NORTH;
            case "south" -> Direction.SOUTH;
            case "west" -> Direction.WEST;
            case "east" -> Direction.EAST;
            default -> Direction.UP;
        };
    }

    private void faceEntity(Entity entity) {
        lookAtOnClient(entity.getX(), entity.getY() + entity.getEyeHeight() * 0.8D, entity.getZ());
    }

    private static void lookAtOnClient(double x, double y, double z) {
        LocalPlayer player = Minecraft.getInstance().player;
        if (player == null) {
            return;
        }
        Vec3 eye = player.getEyePosition();
        double dx = x - eye.x;
        double dy = y - eye.y;
        double dz = z - eye.z;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        player.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
        player.setXRot((float) -Math.toDegrees(Math.atan2(dy, horizontal)));
    }

    /** Hold/release a movement key through the game's own options. */
    private static void setKeyInClient(String key, boolean down) {
        Minecraft mc = Minecraft.getInstance();
        switch (key) {
            case "forward" -> mc.options.keyUp.setDown(down);
            case "back" -> mc.options.keyDown.setDown(down);
            case "left" -> mc.options.keyLeft.setDown(down);
            case "right" -> mc.options.keyRight.setDown(down);
            case "jump" -> mc.options.keyJump.setDown(down);
            case "sprint" -> mc.options.keySprint.setDown(down);
            case "use" -> mc.options.keyUse.setDown(down);
            default -> { }
        }
    }

    private void setKey(String key, boolean down) {
        setKeyInClient(key, down);
    }

    private void setKeyOnClient(String key, boolean down) {
        onClient(() -> {
            setKeyInClient(key, down);
            return true;
        });
    }

    private static String nameOf(ItemStack stack) {
        var id = net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(stack.getItem());
        return id == null ? "minecraft:air" : id.toString();
    }

    private boolean selectItemInClient(String itemName) {
        if (mc.player == null) {
            return false;
        }
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = mc.player.getInventory().getItem(slot);
            if (!stack.isEmpty() && nameOf(stack).equals(itemName)) {
                mc.player.getInventory().selected = slot;
                return true;
            }
        }
        return false;
    }

    /**
     * Run something on the client thread and wait for it.
     *
     * Returns false (never throws, never hangs) if the client is not in a state to run
     * it or the timeout expires, so a broken client can never wedge an agent request.
     */
    private <T> T onClient(java.util.function.Supplier<T> work) {
        return onClient(work, DEFAULT_TIMEOUT_MS);
    }

    private <T> T onClient(java.util.function.Supplier<T> work, long timeoutMs) {
        if (mc.isSameThread()) {
            return work.get(); // already on the client thread (e.g. from the tick handler)
        }
        CompletableFuture<T> future = new CompletableFuture<>();
        mc.execute(() -> {
            try {
                future.complete(work.get());
            } catch (Throwable t) {
                AgentClientMod.LOGGER.warn("action failed: {}", t.toString());
                future.complete(null);
            }
        });
        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            AgentClientMod.LOGGER.warn("action did not complete within {}ms: {}", timeoutMs, e.getMessage());
            return null;
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Kept for callers that want to know if the client can act at all. */
    public boolean isInWorld() {
        return mc.player != null && mc.level != null && mc.getConnection() != null;
    }

    /** Force a position packet, used right after teleports so the server agrees. */
    public void resyncPosition() {
        onClient(() -> {
            if (mc.player != null && mc.getConnection() != null) {
                mc.getConnection().send(new ServerboundMovePlayerPacket.PosRot(
                        mc.player.getX(), mc.player.getY(), mc.player.getZ(),
                        mc.player.getYRot(), mc.player.getXRot(), mc.player.onGround()));
            }
            return true;
        });
    }

    /** Exposed for diagnostics: what does an ItemEntity in range look like. */
    static String describeItemEntity(ItemEntity drop) {
        return nameOf(drop.getItem()) + "x" + drop.getItem().getCount();
    }
}
