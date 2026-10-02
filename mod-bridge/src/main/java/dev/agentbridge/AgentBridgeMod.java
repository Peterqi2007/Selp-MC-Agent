package dev.agentbridge;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * agent-bridge — an in-game companion for the external Node.js/mineflayer survival agent.
 *
 * <p>It does three things:
 * <ol>
 *   <li>serves a small localhost-only HTTP API ({@code /health}, {@code /state}, {@code /players},
 *       {@code /command}) so the agent can read authoritative server state and use operator powers
 *       without a human at the console;</li>
 *   <li>relays {@code !!agent <text>} chat messages to the Node agent at
 *       {@code http://127.0.0.1:8766/command};</li>
 *   <li>tracks who is online and where.</li>
 * </ol>
 */
public class AgentBridgeMod implements ModInitializer {
	public static final String MOD_ID = "agent-bridge";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	private static final String FALLBACK_VERSION = "dev";

	private static ModConfig config;
	private static PlayerTracker playerTracker;
	private static ChatCommandBridge chatBridge;
	private static BridgeHttpServer httpServer;

	@Override
	public void onInitialize() {
		config = ModConfig.load();
		playerTracker = new PlayerTracker();
		chatBridge = new ChatCommandBridge(config);
		httpServer = new BridgeHttpServer(config, playerTracker);

		playerTracker.register();
		chatBridge.register();

		ServerLifecycleEvents.SERVER_STARTED.register(server -> httpServer.start(server));
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			httpServer.stop();
			chatBridge.shutdown();
		});

		LOGGER.info("[agent-bridge] v{} initialised — http={}:{} enabled={} allowCommands={} chatPrefix='{}' bot='{}'",
				version(), config.bindAddress, config.port, config.enabled, config.allowCommands,
				config.chatPrefix, config.botPlayerName);
	}

	/**
	 * The mod version declared in {@code fabric.mod.json}. Never throws: {@code /health} must answer
	 * even if the loader metadata cannot be read.
	 */
	public static String version() {
		try {
			return FabricLoader.getInstance()
					.getModContainer(MOD_ID)
					.map(container -> container.getMetadata().getVersion().getFriendlyString())
					.orElse(FALLBACK_VERSION);
		} catch (Throwable t) {
			return FALLBACK_VERSION;
		}
	}

	public static ModConfig config() {
		return config;
	}

	public static PlayerTracker playerTracker() {
		return playerTracker;
	}

	public static ChatCommandBridge chatBridge() {
		return chatBridge;
	}

	public static BridgeHttpServer httpServer() {
		return httpServer;
	}
}
