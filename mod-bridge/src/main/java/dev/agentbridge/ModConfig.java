package dev.agentbridge;

import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/**
 * Persistent configuration, stored as {@code config/agent-bridge.json} inside the server's
 * {@code config} directory (the directory Fabric hands us via
 * {@link FabricLoader#getConfigDir()}).
 *
 * <p>The file is created with defaults on first launch and rewritten on every load, so an operator
 * can always see every knob without reading the source.
 */
public final class ModConfig {
	public static final String FILE_NAME = "agent-bridge.json";

	/** TCP port the bridge listens on. */
	public int port = 8765;

	/** Interface to bind. Loopback by default: the bridge is not meant to face the network. */
	public String bindAddress = "127.0.0.1";

	/** Master switch. When false the HTTP server is never started and chat commands are ignored. */
	public boolean enabled = true;

	/** When false, {@code POST /command} is rejected even for whitelisted command roots. */
	public boolean allowCommands = true;

	/** When non-empty, every request must present this token (header {@code X-Agent-Token} or {@code ?token=}). */
	public String authToken = "";

	/** Where {@code !!agent <text>} chat messages are forwarded. */
	public String agentCallbackUrl = "http://127.0.0.1:8766/command";

	/** Chat prefix that triggers the relay. */
	public String chatPrefix = "!!agent";

	/** Player the bridge acts "on behalf of" when running whitelisted commands. */
	public String botPlayerName = "AgentSteve";

	public static ModConfig load() {
		ModConfig config = new ModConfig();
		Path path = path();

		if (!Files.isRegularFile(path)) {
			config.save();
			AgentBridgeMod.LOGGER.info("[agent-bridge] wrote default config to {}", path);
			return config;
		}

		try {
			String text = Files.readString(path, StandardCharsets.UTF_8);
			Map<String, Object> root = Json.parseObject(text);

			config.port = Json.getInt(root, "port", config.port);
			config.bindAddress = Json.getString(root, "bindAddress", config.bindAddress);
			config.enabled = Json.getBoolean(root, "enabled", config.enabled);
			config.allowCommands = Json.getBoolean(root, "allowCommands", config.allowCommands);
			config.authToken = Json.getString(root, "authToken", config.authToken);
			config.agentCallbackUrl = Json.getString(root, "agentCallbackUrl", config.agentCallbackUrl);
			config.chatPrefix = Json.getString(root, "chatPrefix", config.chatPrefix);
			config.botPlayerName = Json.getString(root, "botPlayerName", config.botPlayerName);
		} catch (Exception e) {
			AgentBridgeMod.LOGGER.warn("[agent-bridge] could not read {} ({}); falling back to defaults", path, e.toString());
		}

		if (config.port < 1 || config.port > 65535) {
			AgentBridgeMod.LOGGER.warn("[agent-bridge] invalid port {} in config, using 8765", config.port);
			config.port = 8765;
		}

		// Normalise, then rewrite so the on-disk file always shows the full set of keys.
		config.save();
		return config;
	}

	public void save() {
		Path path = path();

		try {
			Files.createDirectories(path.getParent());
			Files.writeString(path, Json.write(toJson()) + System.lineSeparator(), StandardCharsets.UTF_8);
		} catch (IOException e) {
			AgentBridgeMod.LOGGER.warn("[agent-bridge] could not write {}: {}", path, e.toString());
		}
	}

	private Map<String, Object> toJson() {
		return Json.obj(
				"enabled", enabled,
				"bindAddress", bindAddress,
				"port", port,
				"allowCommands", allowCommands,
				"authToken", authToken,
				"agentCallbackUrl", agentCallbackUrl,
				"chatPrefix", chatPrefix,
				"botPlayerName", botPlayerName);
	}

	public static Path path() {
		return FabricLoader.getInstance().getConfigDir().resolve(FILE_NAME);
	}
}
