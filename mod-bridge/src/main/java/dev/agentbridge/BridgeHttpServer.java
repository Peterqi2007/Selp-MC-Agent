package dev.agentbridge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.server.MinecraftServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.BindException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The JDK-only HTTP bridge the Node.js agent talks to.
 *
 * <p>Endpoints:
 * <ul>
 *   <li>{@code GET  /health}  - liveness probe, never touches the server thread</li>
 *   <li>{@code GET  /state}   - world + per-player snapshot</li>
 *   <li>{@code GET  /players} - online players with positions</li>
 *   <li>{@code POST /command} - run a whitelisted server command</li>
 * </ul>
 *
 * <p><b>Threading.</b> Request handlers run on the {@code agent-bridge-http} pool, never on the
 * server thread. Every handler that needs world or entity state goes through
 * {@link #submitToServer}, which hands a task to {@code MinecraftServer#execute} and waits (with a
 * timeout) for the result. World/entity APIs are therefore only ever touched from the server
 * thread.
 *
 * <p><b>Failure isolation.</b> If the port is already taken the bridge logs a warning and stays
 * down; the dedicated server keeps running without it.
 */
public final class BridgeHttpServer {
	private static final int MAX_REQUEST_BYTES = 8 * 1024;
	private static final long SERVER_TASK_TIMEOUT_MS = 5_000L;

	private final ModConfig config;
	private final PlayerTracker players;
	private final AtomicBoolean running = new AtomicBoolean(false);

	private volatile HttpServer httpServer;
	private volatile ExecutorService executor;
	private volatile MinecraftServer minecraftServer;

	// Rolling ticks-per-second estimate, derived from the tick counter the server exposes.
	private volatile long tpsSampleNanos;
	private volatile int tpsSampleTicks;

	public BridgeHttpServer(ModConfig config, PlayerTracker players) {
		this.config = config;
		this.players = players;
	}

	// -------------------------------------------------------------- lifecycle

	/** Starts the bridge. Safe to call when disabled or when the port is taken. */
	public synchronized void start(MinecraftServer server) {
		this.minecraftServer = server;

		if (!config.enabled) {
			AgentBridgeMod.LOGGER.info("[agent-bridge] bridge disabled in config; HTTP server not started");
			return;
		}

		if (running.get()) {
			return;
		}

		InetSocketAddress address;

		try {
			address = new InetSocketAddress(InetAddress.getByName(config.bindAddress), config.port);
		} catch (IOException e) {
			AgentBridgeMod.LOGGER.warn("[agent-bridge] cannot resolve bind address '{}': {}", config.bindAddress, e.toString());
			return;
		}

		try {
			HttpServer created = HttpServer.create(address, 0);
			created.createContext("/health", wrap(this::handleHealth));
			created.createContext("/state", wrap(this::handleState));
			created.createContext("/players", wrap(this::handlePlayers));
			created.createContext("/command", wrap(this::handleCommand));
			created.createContext("/", wrap(this::handleNotFound));

			ExecutorService pool = Executors.newFixedThreadPool(2, runnable -> {
				Thread thread = new Thread(runnable, "agent-bridge-http");
				thread.setDaemon(true);
				return thread;
			});

			created.setExecutor(pool);
			created.start();

			this.executor = pool;
			this.httpServer = created;
			this.running.set(true);
			AgentBridgeMod.LOGGER.info("[agent-bridge] HTTP bridge listening on http://{}:{}",
					config.bindAddress, config.port);
		} catch (BindException e) {
			AgentBridgeMod.LOGGER.warn("[agent-bridge] port {} is already in use ({}); "
					+ "continuing WITHOUT the HTTP bridge, the server is unaffected", config.port, e.getMessage());
		} catch (IOException e) {
			AgentBridgeMod.LOGGER.warn("[agent-bridge] could not start the HTTP bridge on {}:{} ({}); continuing without it",
					config.bindAddress, config.port, e.toString());
		}
	}

	/** Stops the bridge. Safe to call when it never started. */
	public synchronized void stop() {
		HttpServer current = httpServer;
		httpServer = null;
		running.set(false);

		if (current != null) {
			current.stop(0);
			AgentBridgeMod.LOGGER.info("[agent-bridge] HTTP bridge stopped");
		}

		ExecutorService pool = executor;
		executor = null;

		if (pool != null) {
			pool.shutdownNow();
		}

		minecraftServer = null;
	}

	public boolean isRunning() {
		return running.get();
	}

	// --------------------------------------------------------------- handlers

	private void handleHealth(HttpExchange exchange) throws IOException {
		if (!requireMethod(exchange, "GET") || !requireAuth(exchange)) {
			return;
		}

		sendJson(exchange, 200, Json.obj(
				"ok", true,
				"mod", AgentBridgeMod.MOD_ID,
				"version", AgentBridgeMod.version()));
	}

	private void handleState(HttpExchange exchange) throws IOException {
		if (!requireMethod(exchange, "GET") || !requireAuth(exchange)) {
			return;
		}

		MinecraftServer server = minecraftServer;

		if (server == null) {
			sendJson(exchange, 503, Json.obj("ok", false, "error", "server not started yet"));
			return;
		}

		try {
			Map<String, Object> state = submitToServer(server, () -> players.buildState(server));
			Object ticks = state.get("tick");

			if (ticks instanceof Number number) {
				state.put("tps", sampleTps(number.intValue()));
			}

			state.put("bridge", Json.obj(
					"running", running.get(),
					"bindAddress", config.bindAddress,
					"port", config.port,
					"allowCommands", config.allowCommands,
					"chatRelayed", AgentBridgeMod.chatBridge() == null ? 0L : AgentBridgeMod.chatBridge().forwardedCount(),
					"chatRelayFailures", AgentBridgeMod.chatBridge() == null ? 0L : AgentBridgeMod.chatBridge().failedCount()));

			sendJson(exchange, 200, state);
		} catch (Exception e) {
			sendJson(exchange, 500, Json.obj("ok", false, "error", describe(e)));
		}
	}

	private void handlePlayers(HttpExchange exchange) throws IOException {
		if (!requireMethod(exchange, "GET") || !requireAuth(exchange)) {
			return;
		}

		MinecraftServer server = minecraftServer;

		if (server == null) {
			sendJson(exchange, 503, Json.obj("ok", false, "error", "server not started yet"));
			return;
		}

		try {
			var online = submitToServer(server, () -> players.onlinePlayers(server));
			Map<String, Object> payload = new LinkedHashMap<>();
			payload.put("ok", true);
			payload.put("count", online.size());
			payload.put("players", online);
			sendJson(exchange, 200, payload);
		} catch (Exception e) {
			sendJson(exchange, 500, Json.obj("ok", false, "error", describe(e)));
		}
	}

	private void handleCommand(HttpExchange exchange) throws IOException {
		if (!requireMethod(exchange, "POST") || !requireAuth(exchange)) {
			return;
		}

		if (!config.allowCommands) {
			sendJson(exchange, 403, Json.obj("ok", false, "error", "commands are disabled (allowCommands=false)"));
			return;
		}

		String body = readBody(exchange);

		if (body == null) {
			sendJson(exchange, 413, Json.obj("ok", false, "error", "request body larger than " + MAX_REQUEST_BYTES + " bytes"));
			return;
		}

		String command;

		try {
			command = Json.getString(Json.parseObject(body), "command", "");
		} catch (Exception e) {
			sendJson(exchange, 400, Json.obj("ok", false, "error", "invalid JSON body: " + e.getMessage()));
			return;
		}

		MinecraftServer server = minecraftServer;

		if (server == null) {
			sendJson(exchange, 503, Json.obj("ok", false, "error", "server not started yet"));
			return;
		}

		try {
			Map<String, Object> result = submitToServer(server,
					() -> AgentCommandRunner.execute(server, command, config.botPlayerName));
			sendJson(exchange, Boolean.TRUE.equals(result.get("ok")) ? 200 : 400, result);
		} catch (Exception e) {
			sendJson(exchange, 500, Json.obj("ok", false, "error", describe(e)));
		}
	}

	private void handleNotFound(HttpExchange exchange) throws IOException {
		sendJson(exchange, 404, Json.obj(
				"ok", false,
				"error", "unknown endpoint",
				"endpoints", new String[] { "GET /health", "GET /state", "GET /players", "POST /command" }));
	}

	// ------------------------------------------------------- server-thread hop

	/**
	 * Runs {@code task} on the server thread and waits for it, so callers can serve world state
	 * without ever touching world/entity APIs off-thread.
	 */
	private <T> T submitToServer(MinecraftServer server, Callable<T> task) throws Exception {
		if (server.isOnThread()) {
			return task.call();
		}

		CompletableFuture<T> future = new CompletableFuture<>();
		server.execute(() -> {
			try {
				future.complete(task.call());
			} catch (Throwable t) {
				future.completeExceptionally(t);
			}
		});

		try {
			return future.get(SERVER_TASK_TIMEOUT_MS, TimeUnit.MILLISECONDS);
		} catch (TimeoutException e) {
			throw new IllegalStateException("timed out after " + SERVER_TASK_TIMEOUT_MS + "ms waiting for the server thread");
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new IllegalStateException("interrupted while waiting for the server thread");
		} catch (ExecutionException e) {
			Throwable cause = e.getCause() != null ? e.getCause() : e;
			throw new IllegalStateException(describe(cause));
		}
	}

	/**
	 * Ticks per second between two consecutive {@code /state} polls. Minecraft's tick loop targets
	 * 20 TPS; a value well below that means the server is struggling. Returns 0 until two samples
	 * are available.
	 */
	private double sampleTps(int ticks) {
		long now = System.nanoTime();
		long previousNanos = tpsSampleNanos;
		int previousTicks = tpsSampleTicks;
		tpsSampleNanos = now;
		tpsSampleTicks = ticks;

		if (previousNanos == 0L) {
			return 0.0;
		}

		double seconds = (now - previousNanos) / 1.0e9;

		if (seconds <= 0.0) {
			return 0.0;
		}

		return Math.max(0.0, Math.min(20.0, (ticks - previousTicks) / seconds));
	}

	// ----------------------------------------------------------------- plumbing

	private interface ExchangeHandler {
		void handle(HttpExchange exchange) throws IOException;
	}

	private HttpHandler wrap(ExchangeHandler handler) {
		return exchange -> {
			try {
				handler.handle(exchange);
			} catch (Throwable t) {
				AgentBridgeMod.LOGGER.warn("[agent-bridge] {} {} failed: {}",
						exchange.getRequestMethod(), exchange.getRequestURI(), t.toString());

				try {
					sendJson(exchange, 500, Json.obj("ok", false, "error", describe(t)));
				} catch (IOException ignored) {
					// client already gone
				}
			} finally {
				exchange.close();
			}
		};
	}

	private boolean requireMethod(HttpExchange exchange, String expected) throws IOException {
		if (expected.equalsIgnoreCase(exchange.getRequestMethod())) {
			return true;
		}

		exchange.getResponseHeaders().set("Allow", expected);
		sendJson(exchange, 405, Json.obj("ok", false, "error", "method not allowed, use " + expected));
		return false;
	}

	private boolean requireAuth(HttpExchange exchange) throws IOException {
		String token = config.authToken;

		if (token == null || token.isEmpty()) {
			return true;
		}

		String provided = exchange.getRequestHeaders().getFirst("X-Agent-Token");

		if (provided == null) {
			provided = queryParameter(exchange, "token");
		}

		if (token.equals(provided)) {
			return true;
		}

		sendJson(exchange, 401, Json.obj("ok", false, "error", "unauthorized"));
		return false;
	}

	private static String queryParameter(HttpExchange exchange, String name) {
		String query = exchange.getRequestURI().getRawQuery();

		if (query == null) {
			return null;
		}

		for (String pair : query.split("&")) {
			int equals = pair.indexOf('=');

			if (equals > 0 && name.equals(pair.substring(0, equals))) {
				return URLDecoder.decode(pair.substring(equals + 1), StandardCharsets.UTF_8);
			}
		}

		return null;
	}

	/** @return the body, or {@code null} when it exceeds {@link #MAX_REQUEST_BYTES}. */
	private static String readBody(HttpExchange exchange) throws IOException {
		try (InputStream in = exchange.getRequestBody()) {
			byte[] buffer = in.readNBytes(MAX_REQUEST_BYTES + 1);

			if (buffer.length > MAX_REQUEST_BYTES) {
				return null;
			}

			return new String(buffer, StandardCharsets.UTF_8);
		}
	}

	private static void sendJson(HttpExchange exchange, int status, Object payload) throws IOException {
		byte[] bytes = Json.write(payload).getBytes(StandardCharsets.UTF_8);
		exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
		exchange.getResponseHeaders().set("Cache-Control", "no-store");
		exchange.sendResponseHeaders(status, bytes.length);

		try (OutputStream out = exchange.getResponseBody()) {
			out.write(bytes);
		}
	}

	private static String describe(Throwable t) {
		String message = t.getMessage();
		return message == null || message.isEmpty() ? t.getClass().getSimpleName() : message;
	}
}
