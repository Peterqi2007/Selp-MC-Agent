package dev.agentbridge;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Runs a strictly whitelisted subset of server commands on behalf of the bot's player.
 *
 * <p>Only the command <em>roots</em> below are accepted. Anything else — {@code op}, {@code stop},
 * {@code execute}, {@code ban}, datapack or function commands, … — is rejected before it can reach
 * the command dispatcher, so a buggy or compromised agent client cannot escalate beyond these six
 * roots.
 *
 * <p>{@link #execute} touches world/entity state and therefore MUST be called from the server
 * thread.
 */
public final class AgentCommandRunner {
	/** The only command roots the bridge will run. */
	public static final Set<String> ALLOWED_ROOTS = Set.of("time", "weather", "give", "tp", "gamemode", "say");

	/** Hard cap on the command string, so a body cannot be used to smuggle a huge payload. */
	public static final int MAX_COMMAND_LENGTH = 256;

	private AgentCommandRunner() {
	}

	/** Why a command was rejected, or {@code null} when it is acceptable. */
	public static String rejectionReason(String command) {
		if (command == null || command.isBlank()) {
			return "empty command";
		}

		if (command.length() > MAX_COMMAND_LENGTH) {
			return "command longer than " + MAX_COMMAND_LENGTH + " characters";
		}

		// Never let a caller smuggle in a second command through a line break or a section sign.
		for (int i = 0; i < command.length(); i++) {
			char c = command.charAt(i);

			if (c == '\n' || c == '\r' || c == '\u0000' || c == '\u00a7') {
				return "command contains an illegal character";
			}
		}

		String root = root(command);

		if (root.isEmpty()) {
			return "empty command";
		}

		if (!ALLOWED_ROOTS.contains(root)) {
			return "command '" + root + "' is not whitelisted (allowed roots: " + String.join(", ", ALLOWED_ROOTS) + ")";
		}

		return null;
	}

	public static boolean isAllowed(String command) {
		return rejectionReason(command) == null;
	}

	/** First whitespace-delimited token, lower-cased, with any leading slashes removed. */
	public static String root(String command) {
		String trimmed = stripLeadingSlashes(command.trim());
		int end = 0;

		while (end < trimmed.length() && !Character.isWhitespace(trimmed.charAt(end))) {
			end++;
		}

		return trimmed.substring(0, end).toLowerCase(Locale.ROOT);
	}

	/**
	 * Executes {@code command} from the bot player's command source (so {@code @s} and relative
	 * coordinates resolve against the bot), falling back to the server console source when the bot
	 * is offline.
	 *
	 * @return a JSON-ready result map
	 */
	public static Map<String, Object> execute(MinecraftServer server, String command, String botPlayerName) {
		Map<String, Object> result = new LinkedHashMap<>();
		String rejection = rejectionReason(command);

		if (rejection != null) {
			result.put("ok", false);
			result.put("error", rejection);
			result.put("whitelist", ALLOWED_ROOTS);
			return result;
		}

		String normalised = stripLeadingSlashes(command.trim());
		ServerPlayerEntity bot = server.getPlayerManager().getPlayer(botPlayerName);
		StringBuilder output = new StringBuilder();
		int dispatchResult;

		try {
			ServerCommandSource source = bot != null
					? bot.getCommandSource()
					: server.getCommandSource().withSilent();

			// Capture whatever the command prints instead of spraying it into the server log.
			ServerCommandSource capturing = source.withOutput(new CollectingCommandOutput(output));

			dispatchResult = server.getCommandManager().executeWithPrefix(capturing, normalised);
		} catch (Exception e) {
			AgentBridgeMod.LOGGER.warn("[agent-bridge] command '{}' threw: {}", normalised, e.toString());
			result.put("ok", false);
			result.put("command", normalised);
			result.put("error", "command threw " + e.getClass().getSimpleName() + ": " + e.getMessage());
			return result;
		}

		result.put("ok", true);
		result.put("command", normalised);
		result.put("executedAs", bot != null ? bot.getGameProfile().getName() : "server-console");
		result.put("result", dispatchResult);
		result.put("output", output.toString().trim());
		return result;
	}

	private static String stripLeadingSlashes(String command) {
		String value = command;

		while (value.startsWith("/")) {
			value = value.substring(1).trim();
		}

		return value;
	}
}
