import com.sun.net.httpserver.HttpServer;
import dev.agentbridge.AgentCommandRunner;
import dev.agentbridge.BridgeHttpServer;
import dev.agentbridge.Json;
import dev.agentbridge.ModConfig;
import dev.agentbridge.PlayerTracker;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Offline verification harness for agent-bridge.
 *
 * Runs the parts of the mod that do not need a live Minecraft server: the hand-written JSON
 * reader/writer, the operator-command whitelist, and the real HTTP server (binding, routing,
 * auth, and the port-in-use path).
 */
public final class BridgeVerify {
	private static int checks;
	private static int failures;
	private static final List<String> failureDetails = new ArrayList<>();

	private static void check(String label, boolean condition, String detail) {
		checks++;

		if (condition) {
			System.out.println("PASS  " + label);
		} else {
			failures++;
			failureDetails.add(label + " -> " + detail);
			System.out.println("FAIL  " + label + "  -> " + detail);
		}
	}

	private static final HttpClient CLIENT = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(5))
			.build();

	private static HttpResponse<String> send(String method, String url, String body, String tokenHeader) throws Exception {
		HttpRequest.Builder builder = HttpRequest.newBuilder()
				.uri(URI.create(url))
				.timeout(Duration.ofSeconds(5));

		if (tokenHeader != null) {
			builder.header("X-Agent-Token", tokenHeader);
		}

		if ("POST".equals(method)) {
			builder.header("Content-Type", "application/json");
			builder.POST(HttpRequest.BodyPublishers.ofString(body == null ? "" : body, StandardCharsets.UTF_8));
		} else {
			builder.method(method, HttpRequest.BodyPublishers.noBody());
		}

		return CLIENT.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
	}

	public static void main(String[] args) throws Exception {
		jsonTests();
		whitelistTests();
		httpTests();
		authTests();
		portInUseTest();

		System.out.println();
		System.out.println("==================================================");
		System.out.println("checks: " + checks + "   failures: " + failures);
		System.out.println("==================================================");

		if (failures > 0) {
			System.out.println("FAILED:");
			failureDetails.forEach(d -> System.out.println("  - " + d));
			System.exit(1);
		}

		System.out.println("ALL CHECKS PASSED");
	}

	// ------------------------------------------------------------------- JSON

	private static void jsonTests() {
		System.out.println("--- Json ---");

		Map<String, Object> source = Json.obj(
				"ok", true,
				"tick", 48213,
				"tps", 19.75,
				"health", 20.0,
				"name", "AgentSteve",
				"nothing", null,
				"nested", Json.obj("x", 1.5, "y", -3, "z", 0.0),
				"list", List.of(1, 2, 3),
				"mixed", java.util.Arrays.asList(Json.obj("a", "b"), "c", 4, true, null));

		String encoded = Json.write(source);

		check("write produces an object", encoded.startsWith("{") && encoded.endsWith("}"), encoded);
		check("integral double is written without a decimal point", encoded.contains("\"health\":20"), encoded);
		check("null is preserved", encoded.contains("\"nothing\":null"), encoded);

		Map<String, Object> roundTrip = Json.parseObject(encoded);
		check("round-trip ok flag", Boolean.TRUE.equals(roundTrip.get("ok")), String.valueOf(roundTrip.get("ok")));
		check("round-trip tick", Long.valueOf(48213L).equals(roundTrip.get("tick")), String.valueOf(roundTrip.get("tick")));
		check("round-trip name", "AgentSteve".equals(roundTrip.get("name")), String.valueOf(roundTrip.get("name")));
		check("round-trip null", roundTrip.containsKey("nothing") && roundTrip.get("nothing") == null,
				String.valueOf(roundTrip.get("nothing")));
		check("round-trip nested double", Double.valueOf(1.5).equals(((Map<?, ?>) roundTrip.get("nested")).get("x")),
				String.valueOf(((Map<?, ?>) roundTrip.get("nested")).get("x")));
		check("round-trip list size", ((List<?>) roundTrip.get("list")).size() == 3,
				String.valueOf(((List<?>) roundTrip.get("list")).size()));
		check("round-trip mixed list", ((List<?>) roundTrip.get("mixed")).size() == 5,
				String.valueOf(((List<?>) roundTrip.get("mixed")).size()));

		// Escaping
		String nasty = "quote\" backslash\\ newline\n tab\t cr\r bell\u0001 unicode\u00e9 emoji\uD83D\uDE00";
		String encodedNasty = Json.write(Json.obj("v", nasty));
		Map<String, Object> decodedNasty = Json.parseObject(encodedNasty);
		check("string escaping round-trips", nasty.equals(decodedNasty.get("v")),
				"encoded=" + encodedNasty + " decoded=" + decodedNasty.get("v"));
		check("second quote is escaped", encodedNasty.contains("\\\""), encodedNasty);
		check("newline is escaped", encodedNasty.contains("\\n") && !encodedNasty.contains("\n"), encodedNasty);
		check("control char becomes \\u", encodedNasty.contains("\\u0001"), encodedNasty);

		// Parsing of hand-written documents
		Map<String, Object> command = Json.parseObject("{\"command\":\"time set day\"}");
		check("parse {command}", "time set day".equals(Json.getString(command, "command", "")),
				String.valueOf(command.get("command")));
		check("getString fallback", "fallback".equals(Json.getString(command, "missing", "fallback")), "n/a");

		Map<String, Object> padded = Json.parseObject("  {\n  \"a\" : 1 ,\n  \"b\" : [ true , false ]\n }  ");
		check("whitespace tolerant", Long.valueOf(1L).equals(padded.get("a")), String.valueOf(padded.get("a")));
		check("array in object", ((List<?>) padded.get("b")).size() == 2, String.valueOf(padded.get("b")));

		check("empty object", Json.parseObject("{}").isEmpty(), "n/a");
		check("empty array", ((List<?>) Json.parse("[]")).isEmpty(), "n/a");
		check("unicode escape decode", "é".equals(Json.parseObject("{\"v\":\"\\u00e9\"}").get("v")),
				String.valueOf(Json.parseObject("{\"v\":\"\\u00e9\"}").get("v")));
		check("negative and exponent numbers",
				Double.valueOf(-1.5e3).equals(Json.parseObject("{\"v\":-1.5e3}").get("v")),
				String.valueOf(Json.parseObject("{\"v\":-1.5e3}").get("v")));

		check("getInt reads a number", Json.getInt(padded, "a", -1) == 1, String.valueOf(Json.getInt(padded, "a", -1)));
		check("getInt falls back", Json.getInt(padded, "zz", 42) == 42, "n/a");
		check("getBoolean falls back", Json.getBoolean(padded, "zz", true), "n/a");

		// Malformed input must throw, not silently succeed
		for (String bad : new String[] { "{", "{\"a\"}", "{\"a\":}", "{\"a\":1,}", "[1,2", "\"unterminated", "{\"a\":tru}", "}" }) {
			boolean threw = false;

			try {
				Json.parse(bad);
			} catch (RuntimeException e) {
				threw = true;
			}

			check("rejects malformed input " + bad, threw, "parsed without error");
		}

		boolean threwNonObject = false;

		try {
			Json.parseObject("[1,2,3]");
		} catch (RuntimeException e) {
			threwNonObject = true;
		}

		check("parseObject rejects an array", threwNonObject, "accepted an array");
	}

	// -------------------------------------------------------------- whitelist

	private static void whitelistTests() {
		System.out.println("--- AgentCommandRunner whitelist ---");

		check("whitelist has exactly the six roots", AgentCommandRunner.ALLOWED_ROOTS.size() == 6,
				String.valueOf(AgentCommandRunner.ALLOWED_ROOTS));
		check("whitelist contents",
				AgentCommandRunner.ALLOWED_ROOTS.containsAll(List.of("time", "weather", "give", "tp", "gamemode", "say")),
				String.valueOf(AgentCommandRunner.ALLOWED_ROOTS));

		String[] allowed = {
				"time set day",
				"time set night",
				"weather clear",
				"weather rain 100",
				"give AgentSteve minecraft:diamond 3",
				"tp AgentSteve 100 64 -200",
				"gamemode creative AgentSteve",
				"say hello there",
				"/time set day",
				"//say hi",
				"  time   set   day  ",
				"TIME SET DAY",
				"Say hello",
				"say",
		};

		for (String command : allowed) {
			check("allows: " + command, AgentCommandRunner.isAllowed(command),
					String.valueOf(AgentCommandRunner.rejectionReason(command)));
		}

		String[] rejected = {
				"op AgentSteve",
				"stop",
				"execute run say hi",
				"kill AgentSteve",
				"ban AgentSteve",
				"setblock 0 0 0 minecraft:stone",
				"function mypack:thing",
				"reload",
				"deop AgentSteve",
				"whitelist add someone",
				"time set day\nop AgentSteve",
				"time set day\rop AgentSteve",
				"time set day\u00a7c",
				"time set day\u0000op",
				"",
				"   ",
				"give",
				"tp",
		};

		// "give" and "tp" with no arguments are still whitelisted roots; only roots are checked.
		for (String command : rejected) {
			boolean isBareAllowedRoot = command.equals("give") || command.equals("tp");
			boolean expected = isBareAllowedRoot;
			check((expected ? "allows bare root: " : "rejects: ") + command.replace("\n", "\\n").replace("\r", "\\r"),
					AgentCommandRunner.isAllowed(command) == expected,
					String.valueOf(AgentCommandRunner.rejectionReason(command)));
		}

		check("rejects null", !AgentCommandRunner.isAllowed(null), "accepted null");

		StringBuilder exactly = new StringBuilder("say ");
		exactly.append("a".repeat(AgentCommandRunner.MAX_COMMAND_LENGTH - 4));
		check("accepts a command of exactly MAX length", exactly.length() == AgentCommandRunner.MAX_COMMAND_LENGTH
				&& AgentCommandRunner.isAllowed(exactly.toString()),
				"length=" + exactly.length() + " reason=" + AgentCommandRunner.rejectionReason(exactly.toString()));

		StringBuilder tooLong = new StringBuilder(exactly).append('a');
		check("rejects a command one char over MAX", !AgentCommandRunner.isAllowed(tooLong.toString()),
				"length=" + tooLong.length());

		check("root() strips slashes and whitespace", "time".equals(AgentCommandRunner.root("   //Time  set day")),
				AgentCommandRunner.root("   //Time  set day"));
		check("root() of empty-ish string is empty", AgentCommandRunner.root("   ").isEmpty(),
				"[" + AgentCommandRunner.root("   ") + "]");
	}

	// ------------------------------------------------------------------- HTTP

	private static ModConfig config(int port, String token) {
		ModConfig config = new ModConfig();
		config.port = port;
		config.bindAddress = "127.0.0.1";
		config.enabled = true;
		config.allowCommands = true;
		config.authToken = token;
		config.botPlayerName = "AgentSteve";
		return config;
	}

	private static void httpTests() throws Exception {
		System.out.println("--- HTTP endpoints (no server started) ---");

		int port = 18765;
		ModConfig config = config(port, "");
		BridgeHttpServer bridge = new BridgeHttpServer(config, new PlayerTracker());
		bridge.start(null);

		check("bridge reports running", bridge.isRunning(), "isRunning=false");
		String base = "http://127.0.0.1:" + port;

		HttpResponse<String> health = send("GET", base + "/health", null, null);
		check("GET /health -> 200", health.statusCode() == 200, "status=" + health.statusCode());
		check("GET /health body", health.body().contains("\"ok\":true")
				&& health.body().contains("\"mod\":\"agent-bridge\"")
				&& health.body().contains("\"version\""), health.body());
		check("GET /health content-type", String.valueOf(health.headers().firstValue("Content-Type").orElse(""))
				.startsWith("application/json"), String.valueOf(health.headers().firstValue("Content-Type").orElse("")));
		check("GET /health is valid JSON", "agent-bridge".equals(Json.getString(Json.parseObject(health.body()), "mod", "")),
				health.body());

		HttpResponse<String> state = send("GET", base + "/state", null, null);
		check("GET /state before server start -> 503", state.statusCode() == 503, "status=" + state.statusCode());
		check("GET /state error message", state.body().contains("server not started"),
				state.body());

		HttpResponse<String> players = send("GET", base + "/players", null, null);
		check("GET /players before server start -> 503", players.statusCode() == 503, "status=" + players.statusCode());

		HttpResponse<String> postState = send("POST", base + "/state", "{}", null);
		check("POST /state -> 405", postState.statusCode() == 405, "status=" + postState.statusCode());
		check("405 sets Allow", "GET".equals(postState.headers().firstValue("Allow").orElse("")),
				String.valueOf(postState.headers().firstValue("Allow").orElse("")));

		HttpResponse<String> getCommand = send("GET", base + "/command", null, null);
		check("GET /command -> 405", getCommand.statusCode() == 405, "status=" + getCommand.statusCode());

		HttpResponse<String> badJson = send("POST", base + "/command", "{not json", null);
		check("POST /command with malformed JSON -> 400", badJson.statusCode() == 400, "status=" + badJson.statusCode());
		check("400 explains the JSON problem", badJson.body().contains("invalid JSON body"), badJson.body());

		HttpResponse<String> missingCommand = send("POST", base + "/command", "{}", null);
		check("POST /command without a command key -> 503 (server down)",
				missingCommand.statusCode() == 503, "status=" + missingCommand.statusCode());

		HttpResponse<String> unknown = send("GET", base + "/nope", null, null);
		check("unknown endpoint -> 404", unknown.statusCode() == 404, "status=" + unknown.statusCode());
		check("404 lists endpoints", unknown.body().contains("/health") && unknown.body().contains("/command"),
				unknown.body());

		HttpResponse<String> root = send("GET", base + "/", null, null);
		check("GET / -> 404", root.statusCode() == 404, "status=" + root.statusCode());

		// allowCommands=false must short-circuit before anything else.
		ModConfig noCommands = config(18767, "");
		noCommands.allowCommands = false;
		BridgeHttpServer noCommandBridge = new BridgeHttpServer(noCommands, new PlayerTracker());
		noCommandBridge.start(null);
		HttpResponse<String> forbidden = send("POST", "http://127.0.0.1:18767/command", "{\"command\":\"time set day\"}", null);
		check("allowCommands=false -> 403", forbidden.statusCode() == 403, "status=" + forbidden.statusCode());
		check("403 mentions the config flag", forbidden.body().contains("allowCommands"), forbidden.body());
		noCommandBridge.stop();

		// disabled bridge must not listen at all
		ModConfig disabled = config(18768, "");
		disabled.enabled = false;
		BridgeHttpServer disabledBridge = new BridgeHttpServer(disabled, new PlayerTracker());
		disabledBridge.start(null);
		check("enabled=false does not start the bridge", !disabledBridge.isRunning(), "isRunning=true");
		boolean refused = false;

		try {
			send("GET", "http://127.0.0.1:18768/health", null, null);
		} catch (Exception e) {
			refused = true;
		}

		check("enabled=false leaves the port closed", refused, "port answered");

		// oversized body
		HttpResponse<String> huge = send("POST", base + "/command",
				"{\"command\":\"" + "a".repeat(9000) + "\"}", null);
		check("oversized body -> 413", huge.statusCode() == 413, "status=" + huge.statusCode());

		bridge.stop();
		check("stop() clears the running flag", !bridge.isRunning(), "isRunning=true");
		check("stop() is idempotent", stopTwice(bridge), "second stop threw");

		// The port must be free again after stop().
		BridgeHttpServer restarted = new BridgeHttpServer(config(port, ""), new PlayerTracker());
		restarted.start(null);
		check("port is reusable after stop()", restarted.isRunning(), "restart failed");
		restarted.stop();
	}

	private static boolean stopTwice(BridgeHttpServer bridge) {
		try {
			bridge.stop();
			bridge.stop();
			return true;
		} catch (RuntimeException e) {
			return false;
		}
	}

	private static void authTests() throws Exception {
		System.out.println("--- auth token ---");

		int port = 18766;
		BridgeHttpServer bridge = new BridgeHttpServer(config(port, "s3cret"), new PlayerTracker());
		bridge.start(null);
		String base = "http://127.0.0.1:" + port;

		HttpResponse<String> noToken = send("GET", base + "/health", null, null);
		check("missing token -> 401", noToken.statusCode() == 401, "status=" + noToken.statusCode());

		HttpResponse<String> wrongToken = send("GET", base + "/health", null, "nope");
		check("wrong token -> 401", wrongToken.statusCode() == 401, "status=" + wrongToken.statusCode());

		HttpResponse<String> goodToken = send("GET", base + "/health", null, "s3cret");
		check("correct header token -> 200", goodToken.statusCode() == 200, "status=" + goodToken.statusCode());

		HttpResponse<String> queryToken = send("GET", base + "/health?token=s3cret", null, null);
		check("correct query token -> 200", queryToken.statusCode() == 200, "status=" + queryToken.statusCode());

		bridge.stop();
	}

	private static void portInUseTest() throws Exception {
		System.out.println("--- port already in use ---");

		// Occupy a port with a plain JDK server, then let the bridge try to take it.
		int port = 18769;
		HttpServer squatter = HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", port), 0);
		squatter.createContext("/", exchange -> {
			exchange.sendResponseHeaders(204, -1);
			exchange.close();
		});
		squatter.start();

		BridgeHttpServer bridge = new BridgeHttpServer(config(port, ""), new PlayerTracker());
		boolean threw = false;

		try {
			bridge.start(null);
		} catch (Throwable t) {
			threw = true;
			System.out.println("      (unexpected throw: " + t + ")");
		}

		check("bind failure does not throw", !threw, "start() threw");
		check("bind failure leaves the bridge down", !bridge.isRunning(), "isRunning=true");
		check("bind failure keeps stop() safe", stopTwice(bridge), "stop() threw after a failed start");

		squatter.stop(0);
	}

	private static Map<String, Object> unused() {
		return new LinkedHashMap<>();
	}
}
