package dev.agentclient;

import com.mojang.logging.LogUtils;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.server.ServerStoppedEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.loading.FMLEnvironment;
import org.slf4j.Logger;

/**
 * Entry point for the agent-client control mod.
 *
 * Client-side only: it is constructed on the physical client and refuses to load on a
 * dedicated server, because everything it does (levels, players, game mode, chat)
 * only exists client-side.
 *
 * Lifecycle: start the HTTP API once Forge is up, pump continuous actions from the
 * client tick, and shut the API down on the way out so a reload never leaks a port.
 */
@Mod(AgentClientMod.MOD_ID)
public final class AgentClientMod {

    public static final String MOD_ID = "agentclient";
    public static final Logger LOGGER = LogUtils.getLogger();

    private static String version = "dev";

    private final ClientActions actions;
    private final ControlHttpServer http;

    public AgentClientMod() {
        if (FMLEnvironment.dist != Dist.CLIENT) {
            // Should be unreachable given the mods.toml side="CLIENT", but a mod that
            // silently half-loads on a server is worse than one that says so.
            throw new IllegalStateException("agent-client is a CLIENT-only mod");
        }

        ClientModConfig config = ClientModConfig.get();
        this.actions = new ClientActions();
        // /state embeds the input ledger; a static back-reference keeps the snapshot a
        // single call (see ClientStateSnapshot.setActions).
        ClientStateSnapshot.setActions(this.actions);
        this.http = new ControlHttpServer(this.actions, config);

        MinecraftForge.EVENT_BUS.register(this);
        MinecraftForge.EVENT_BUS.addListener(this::onServerStopped);
        // Capture incoming chat so /diag/slash can prove whether commands need a slash,
        // and so /chatlog lets the agent see what the server replied to /login.
        ChatLog.register();

        // Start slightly late so the log shows it after the usual mod-loading noise, and
        // so we do not open a socket while the render thread is still initialising.
        new Thread(() -> {
            try {
                Thread.sleep(2000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            /**
             * Headless driving must not be paused by focus changes.
             *
             * `pauseOnLostFocus` is on by default: whenever OS focus leaves the game window
             * (i.e. every time the operator types in another app) Minecraft opens the
             * PauseScreen and stops applying player input. Measured live 2026-10-29: the input
             * layer reported `blockedByScreen=true` for every key while the snapshot still said
             * `screen=null`, and the agent concluded "cannot walk". Disabling it keeps the
             * client ticking with the window in the background.
             */
            net.minecraft.client.Minecraft.getInstance().execute(() -> {
                try {
                    net.minecraft.client.Minecraft.getInstance().options.pauseOnLostFocus = false;
                    LOGGER.info("agent-client: pauseOnLostFocus disabled (headless input)");
                } catch (Exception e) {
                    LOGGER.warn("agent-client: could not disable pauseOnLostFocus: {}", e.toString());
                }
            });
            boolean started = http.start();
            if (started) {
                LOGGER.info("agent-client ready - state: GET http://{}:{}/state", config.bindAddress, config.port);
            } else {
                /**
                 * Say plainly that the agent cannot use this client.
                 *
                 * This branch used to be missing: `http.start()` already reported the bind
                 * failure honestly, but the line after it printed "agent-client ready" and the
                 * URL anyway. That is worse than no message at all - an operator (or an agent
                 * reading the log) is told the API is up while every request is refused, and the
                 * real cause scrolls away hundreds of lines earlier.
                 */
                LOGGER.error("agent-client is NOT usable: the control API did not start, so nothing can drive this client.");
                LOGGER.error("  the game itself is unaffected - you can still play normally.");
                LOGGER.error("  usual cause: port {} is already owned by another Minecraft instance.", config.port);
                LOGGER.error("  fix: close every other client (or whatever holds the port), then restart this one.");
            }
        }, "agent-client-boot").start();

        LOGGER.info("agent-client initialising (port {})", config.port);
    }

    public static String version() {
        return version;
    }

    /** Forge calls this with the mod's own version during construction. */
    public static void setVersion(String value) {
        if (value != null && !value.isEmpty()) {
            version = value;
        }
    }

    /**
     * Drive continuous actions (walking, digging) from the client tick.
     *
     * END phase, so the action runs after the world has updated this tick and the packets
     * it sends line up with the position the server is about to see.
     */
    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) {
            return;
        }
        actions.tick();
    }

    private void onServerStopped(ServerStoppedEvent event) {
        // Only relevant in singleplayer, but stopping the API when the world unloads keeps
        // things predictable during quick world switching.
        LOGGER.debug("world stopped");
    }
}
