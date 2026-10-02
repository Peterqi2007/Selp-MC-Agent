package dev.agentbridge;

import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Relays in-game chat of the form {@code !!agent <text>} to the external Node.js agent.
 *
 * <p>The chat callback runs on the server thread, so it does nothing but pattern-match and hand the
 * text to a small daemon {@link ExecutorService}: the actual HTTP POST happens off-thread and can
 * never stall a tick, however slow or absent the Node agent is.
 */
public final class ChatCommandBridge {
	private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(2);
	private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(5);

	private final ModConfig config;
	private final ExecutorService executor;
	private final HttpClient httpClient;
	private final AtomicLong forwarded = new AtomicLong();
	private final AtomicLong failed = new AtomicLong();

	public ChatCommandBridge(ModConfig config) {
		this.config = config;
		this.executor = Executors.newFixedThreadPool(2, runnable -> {
			Thread thread = new Thread(runnable, "agent-bridge-chat");
			thread.setDaemon(true);
			return thread;
		});
		this.httpClient = HttpClient.newBuilder().connectTimeout(CONNECT_TIMEOUT).build();
	}

	public void register() {
		ServerMessageEvents.CHAT_MESSAGE.register((message, sender, params) -> {
			// Anything thrown here would propagate into the server thread, so swallow everything.
			try {
				if (!config.enabled || sender == null || message == null) {
					return;
				}

				handleChat(sender, message.getContent().getString());
			} catch (Throwable t) {
				AgentBridgeMod.LOGGER.warn("[agent-bridge] chat hook failed: {}", t.toString());
			}
		});
	}

	private void handleChat(ServerPlayerEntity sender, String content) {
		String prefix = config.chatPrefix;

		if (prefix == null || prefix.isEmpty()) {
			return;
		}

		String trimmed = content.trim();

		if (trimmed.length() < prefix.length() || !trimmed.regionMatches(true, 0, prefix, 0, prefix.length())) {
			return;
		}

		String text = trimmed.substring(prefix.length()).trim();
		String playerName = sender.getGameProfile().getName();
		AgentBridgeMod.LOGGER.info("[agent-bridge] relaying chat command from {}: {}", playerName, text);
		sender.sendMessage(Text.literal("[agent-bridge] -> agent: " + text), false);
		executor.execute(() -> forward(text));
	}

	/**
	 * Forwards {@code text} to the Node agent without blocking the calling thread. Exposed so the
	 * HTTP layer (or a future command) can inject a synthetic chat command.
	 */
	public void submit(String playerName, String text) {
		AgentBridgeMod.LOGGER.info("[agent-bridge] relaying command from {}: {}", playerName, text);
		executor.execute(() -> forward(text));
	}

	private void forward(String text) {
		// The contract with the Node agent is exactly {"command":"<text>"}.
		String body = Json.write(Json.obj("command", text));

		try {
			HttpRequest request = HttpRequest.newBuilder()
					.uri(URI.create(config.agentCallbackUrl))
					.timeout(REQUEST_TIMEOUT)
					.header("Content-Type", "application/json; charset=utf-8")
					.header("X-Agent-Bridge", AgentBridgeMod.MOD_ID)
					.POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
					.build();

			HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

			if (response.statusCode() / 100 == 2) {
				forwarded.incrementAndGet();
			} else {
				failed.incrementAndGet();
				AgentBridgeMod.LOGGER.warn("[agent-bridge] agent replied HTTP {} to a relayed chat command", response.statusCode());
			}
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		} catch (Exception e) {
			failed.incrementAndGet();
			AgentBridgeMod.LOGGER.warn("[agent-bridge] could not reach the agent at {}: {}", config.agentCallbackUrl, e.toString());
		}
	}

	public long forwardedCount() {
		return forwarded.get();
	}

	public long failedCount() {
		return failed.get();
	}

	public void shutdown() {
		executor.shutdownNow();

		try {
			executor.awaitTermination(1, TimeUnit.SECONDS);
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
	}
}
