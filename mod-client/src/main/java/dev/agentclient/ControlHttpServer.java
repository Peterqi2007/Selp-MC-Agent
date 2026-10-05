package dev.agentclient;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.client.Minecraft;

import java.io.IOException;
import java.io.OutputStream;
import java.net.BindException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The local control API.
 *
 * HTTP rather than WebSocket on purpose: the 1.20.1 Forge classpath ships Netty 4.1.82
 * WITHOUT {@code netty-codec-http}, so {@code WebSocketServerHandshaker} simply does not
 * exist here, while {@code com.sun.net.httpserver.HttpServer} is part of the JDK. The
 * agent polls {@code /state} anyway, so a request/response API fits the usage better than
 * a push channel would.
 *
 * Endpoints
 *   GET  /health   liveness + mod version
 *   GET  /state    full snapshot (player, inventory, nearby blocks, entities, time)
 *   GET  /progress progress of the current continuous action
 *   GET  /diag/slash  EMPIRICAL check of whether sendCommand needs a leading slash
 *   POST /command  {"command":"..."} -> perform an action
 *
 * Bound to 127.0.0.1 only. A control channel that can move a player must never be
 * reachable from the network.
 */
public final class ControlHttpServer {

    private final ClientActions actions;
    private final ClientModConfig config;
    private HttpServer server;
    private final AtomicLong requests = new AtomicLong();

    public ControlHttpServer(ClientActions actions, ClientModConfig config) {
        this.actions = actions;
        this.config = config;
    }

    /** @return true when the server is listening */
    public synchronized boolean start() {
        if (server != null) {
            return true;
        }
        if (!config.enabled) {
            AgentClientMod.LOGGER.info("agent-client HTTP API disabled in config");
            return false;
        }
        try {
            server = HttpServer.create(new InetSocketAddress(config.bindAddress, config.port), 0);
        } catch (BindException e) {
            // Never fatal: another instance may own the port. The game must keep running.
            AgentClientMod.LOGGER.warn(
                    "port {} is already in use ({}); continuing WITHOUT the control API - the game is unaffected",
                    config.port, e.getMessage());
            server = null;
            return false;
        } catch (IOException e) {
            AgentClientMod.LOGGER.warn("could not start the control API: {}", e.getMessage());
            server = null;
            return false;
        }

        server.createContext("/health", this::handleHealth);
        server.createContext("/state", this::handleState);
        server.createContext("/progress", this::handleProgress);
        server.createContext("/diag/slash", this::handleSlashDiag);
        server.createContext("/command", this::handleCommand);
        server.createContext("/chatlog", this::handleChatLog);
        server.createContext("/chatlog/clear", this::handleChatLogClear);
        server.setExecutor(Executors.newFixedThreadPool(2, r -> {
            Thread t = new Thread(r, "agent-client-http");
            t.setDaemon(true); // never keep the JVM alive
            return t;
        }));
        server.start();
        AgentClientMod.LOGGER.info("agent-client control API listening on http://{}:{}", config.bindAddress, config.port);
        return true;
    }

    public synchronized void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
            AgentClientMod.LOGGER.info("agent-client control API stopped");
        }
    }

    public boolean isRunning() {
        return server != null;
    }

    // ------------------------------------------------------------------ handlers

    private void handleHealth(HttpExchange exchange) throws IOException {
        Map<String, String> map = new LinkedHashMap<>();
        map.put("ok", Json.bool(true));
        map.put("mod", Json.str("agent-client"));
        map.put("version", Json.str(AgentClientMod.version()));
        map.put("inWorld", Json.bool(actions.isInWorld()));
        map.put("requests", Json.num(requests.get()));
        respond(exchange, 200, Json.obj(map));
    }

    private void handleState(HttpExchange exchange) throws IOException {
        if (!authorised(exchange)) {
            respond(exchange, 401, "{\"ok\":false,\"error\":\"unauthorised\"}");
            return;
        }
        // The snapshot is built on the client thread; everything else here is just I/O.
        String state = onClientThread(ClientStateSnapshot::build);
        respond(exchange, 200, state == null ? "{\"ready\":false,\"reason\":\"client thread busy\"}" : state);
    }

    private void handleProgress(HttpExchange exchange) throws IOException {
        if (!authorised(exchange)) {
            respond(exchange, 401, "{\"ok\":false,\"error\":\"unauthorised\"}");
            return;
        }
        respond(exchange, 200, actions.progressJson());
    }

    /**
     * Empirically answer: does {@code ClientPacketListener.sendCommand} want a leading
     * slash?
     *
     * Getting this wrong makes AuthMe `/login` fail silently, so the mod settles it on
     * demand instead of guessing: it sends an intentionally bogus command and reports what
     * the server said.
     *
     * Reading the result:
     *   - server replies "Unknown or incomplete command" -> the command ARRIVED and was
     *     parsed, so the normalisation is right (the command name was simply nonsense)
     *   - server replies "Unknown command" / nothing at all -> the slash handling is wrong
     *
     * Both forms are sent, and the captured chat for each is returned, so the answer is
     * visible rather than inferred.
     */
    private void handleSlashDiag(HttpExchange exchange) throws IOException {
        if (!authorised(exchange)) {
            respond(exchange, 401, "{\"ok\":false,\"error\":\"unauthorised\"}");
            return;
        }
        String query = exchange.getRequestURI().getQuery();
        String bogus = "agentclientdiagprobe";
        if (query != null && query.contains("cmd=")) {
            bogus = query.replaceAll(".*cmd=", "");
        }

        // Form 1: pass it through the normalising path (what the agent uses).
        ChatLog.clear();
        boolean sentNormalised = actions.command(bogus);
        sleep(1200);
        var afterNormalised = ChatLog.recent(6);

        // Form 2: deliberately hand sendCommand a string that already has a slash, which
        // is the mistake we are checking for.
        ChatLog.clear();
        boolean sentRaw = actions.rawCommandWithSlash("/" + bogus);
        sleep(1200);
        var afterRaw = ChatLog.recent(6);

        Map<String, String> map = new LinkedHashMap<>();
        map.put("ok", Json.bool(true));
        map.put("probe", Json.str(bogus));
        map.put("note", Json.str(
                "sendCommand() supplies the leading slash itself. Passing '/cmd' therefore sends '//cmd'. "
                        + "A normalised probe should produce server feedback; a raw one should not."));
        map.put("normalisedAccepted", Json.bool(sentNormalised));
        map.put("normalisedFeedback", Json.arr(afterNormalised.stream().map(Json::str).toList()));
        map.put("rawWithSlashAccepted", Json.bool(sentRaw));
        map.put("rawWithSlashFeedback", Json.arr(afterRaw.stream().map(Json::str).toList()));
        map.put("verdict", Json.str(verdict(afterNormalised, afterRaw)));
        respond(exchange, 200, Json.obj(map));
    }

    /** Drop the captured chat, so a caller can look only at what happens next. */
    private void handleChatLogClear(HttpExchange exchange) throws IOException {
        if (!authorised(exchange)) {
            respond(exchange, 401, "{\"ok\":false,\"error\":\"unauthorised\"}");
            return;
        }
        ChatLog.clear();
        respond(exchange, 200, "{\"ok\":true,\"cleared\":true}");
    }

    /** What the last n chat lines were - so the agent can read /login replies. */
    private void handleChatLog(HttpExchange exchange) throws IOException {
        if (!authorised(exchange)) {
            respond(exchange, 401, "{\"ok\":false,\"error\":\"unauthorised\"}");
            return;
        }
        String query = exchange.getRequestURI().getQuery();
        int n = 20;
        if (query != null && query.contains("n=")) {
            try {
                n = Integer.parseInt(query.replaceAll(".*n=", "").replaceAll("[^0-9].*", ""));
            } catch (NumberFormatException ignored) {
                /* keep default */
            }
        }
        Map<String, String> map = new LinkedHashMap<>();
        map.put("ok", Json.bool(true));
        map.put("count", Json.num(ChatLog.size()));
        map.put("lines", ChatLog.recentJson(Math.max(1, Math.min(n, 50))));
        respond(exchange, 200, Json.obj(map));
    }

    /** Compare the two probes and say plainly which form works. */
    private static String verdict(java.util.List<String> normalised, java.util.List<String> raw) {
        // The server echoes the offending token back, so the two replies differ in exactly
        // the way that answers the question: whichever form shows a LEADING SLASH in the
        // echoed token is the form that sent one literally.
        boolean normalisedEchoesSlash = anyEchoesLeadingSlash(normalised);
        boolean rawEchoesSlash = anyEchoesLeadingSlash(raw);
        boolean normalisedAnswered = mentionsCommandError(normalised);
        boolean rawAnswered = mentionsCommandError(raw);

        if (normalisedAnswered && rawAnswered && rawEchoesSlash && !normalisedEchoesSlash) {
            return "CONFIRMED: sendCommand() does NOT add a leading slash. "
                    + "The raw form sent the slash literally; the normalised form did not. "
                    + "ClientActions.command() MUST keep stripping leading slashes, and the agent should pass "
                    + "'login <pw>' or '/login <pw>' - both end up correct.";
        }
        if (normalisedEchoesSlash && !rawEchoesSlash) {
            return "UNEXPECTED: the normalised form still sent a slash. Fix ClientActions.command().";
        }
        if (normalisedAnswered && !rawAnswered) {
            return "SUGGESTIVE: only the normalised form was understood; keep stripping slashes.";
        }
        if (!normalisedAnswered && !rawAnswered) {
            return "INCONCLUSIVE: no command feedback captured (not connected to a server, or chat is suppressed).";
        }
        return "INCONCLUSIVE: both forms produced feedback; compare the echoed tokens by hand.";
    }

    /** Does any reply echo a token that starts with '/'? That is the literal-slash tell. */
    private static boolean anyEchoesLeadingSlash(java.util.List<String> lines) {
        for (String line : lines) {
            // The server echoes the bad token before its "<--[HERE]" marker.
            int marker = line.indexOf("<--");
            String head = marker > 0 ? line.substring(0, marker) : line;
            for (String token : head.split("\\s+")) {
                if (token.startsWith("/") && token.length() > 1) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Command errors, in the client's language.
     *
     * The client ran with a Chinese locale, so matching only English strings made an
     * earlier version of this report a false "neither form worked". Match both.
     */
    private static boolean mentionsCommandError(java.util.List<String> lines) {
        for (String line : lines) {
            String lower = line.toLowerCase(java.util.Locale.ROOT);
            if (lower.contains("unknown or incomplete command")
                    || lower.contains("unknown command")
                    || lower.contains("incorrect argument")
                    || lower.contains("usage:")
                    // zh_CN
                    || line.contains("未知或不完整的命令")
                    || line.contains("未知的命令")
                    || line.contains("参数不正确")
                    || line.contains("用法")) {
                return true;
            }
        }
        return false;
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void handleCommand(HttpExchange exchange) throws IOException {
        if (!authorised(exchange)) {
            respond(exchange, 401, "{\"ok\":false,\"error\":\"unauthorised\"}");
            return;
        }
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"ok\":false,\"error\":\"use POST\"}");
            return;
        }
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        String command = Json.field(body, "command");
        if (command == null || command.isBlank()) {
            respond(exchange, 400, "{\"ok\":false,\"error\":\"missing \\\"command\\\"\"}");
            return;
        }
        respond(exchange, 200, execute(command));
    }

    // ------------------------------------------------------------------ dispatch

    /**
     * Server commands this mod refuses to forward, whatever the caller asks.
     *
     * `/register` is here because on the target server registering an already-existing
     * character WIPES its saved data - experience and inventory are reset to a fresh
     * player. That is a data-loss footgun, not an authentication step, so the control
     * surface must not be able to reach it at all. Authentication is `/login` only.
     *
     * A first attempt gated only the top-level verb, and `cmd /register x` walked straight
     * past it (the server confirmed it received the command). The check now also unwraps
     * the `cmd`/`command` escape hatch, and ClientActions.command() refuses independently.
     */
    private static final java.util.List<String> FORBIDDEN_COMMANDS = java.util.List.of(
            "register",
            "reg"
    );

    /**
     * @return the forbidden command name, or null when the command is allowed.
     */
    private static String forbiddenCommand(String command) {
        String current = command == null ? "" : command.trim();
        // Peel every layer, not just the first: "cmd cmd /register x" must be caught too.
        for (int depth = 0; depth < 5; depth += 1) {
            while (current.startsWith("/")) {
                current = current.substring(1).trim();
            }
            String verb = current.split("\\s+", 2)[0].toLowerCase(java.util.Locale.ROOT);
            if (verb.equals("cmd") || verb.equals("command")) {
                String[] parts = current.split("\\s+", 2);
                if (parts.length < 2) {
                    return null;
                }
                current = parts[1].trim();
                continue;
            }
            for (String forbidden : FORBIDDEN_COMMANDS) {
                if (verb.equals(forbidden)) {
                    return forbidden;
                }
            }
            return null;
        }
        return null;
    }

    /** Route a command string to an action. */
    String execute(String command) {
        // Strip leading slashes BEFORE splitting the verb.
        //
        // The agent may legitimately send either "login pw" or "/login pw" (its chat()
        // routes any slash-prefixed string straight through). Splitting first made the verb
        // "/login", which matched no case and came back as "unknown command: /login" - a
        // confusing failure that looked like an AuthMe problem.
        String normalised = command == null ? "" : command.trim();
        while (normalised.startsWith("/")) {
            normalised = normalised.substring(1).trim();
        }

        String[] parts = normalised.split("\\s+", 2);
        String verb = parts[0].toLowerCase(java.util.Locale.ROOT);
        String rest = parts.length > 1 ? parts[1].trim() : "";

        Map<String, String> out = new LinkedHashMap<>();
        out.put("command", Json.str(command));

        // Safety gate, checked before ANY dispatch - including the `cmd` escape hatch.
        String forbidden = forbiddenCommand(normalised);
        if (forbidden != null) {
            AgentClientMod.LOGGER.warn("refused forbidden command '{}' (it destroys player data)", forbidden);
            out.put("ok", Json.bool(false));
            out.put("refused", Json.bool(true));
            out.put("error", Json.str(
                    "'" + forbidden + "' is blocked: registering an existing character wipes its "
                            + "experience and inventory. Authentication is /login only."));
            return Json.obj(out);
        }

        try {
            switch (verb) {
                case "chat" -> out.put("ok", Json.bool(actions.chat(rest)));
                case "login" -> {
                    // Convenience so the agent does not need to know about the AuthMe
                    // command name: "login hunter2" becomes "/login hunter2".
                    out.put("ok", Json.bool(config.allowCommands && actions.command("login " + rest)));
                }
                case "register" -> {
                    // Unreachable: the safety gate above refuses "register" before dispatch.
                    // Kept as a second line of defence so a future refactor cannot silently
                    // re-enable the command that wipes player data.
                    out.put("ok", Json.bool(false));
                    out.put("refused", Json.bool(true));
                    out.put("error", Json.str("register is disabled - it wipes experience and inventory"));
                }
                case "cmd", "command" -> {
                    // Direct escape hatch: forward the rest verbatim as a server command.
                    // The leading slash (if any) is stripped by actions.command(), so
                    // 'cmd say hi' and 'cmd /say hi' both work.
                    out.put("ok", Json.bool(config.allowCommands && actions.command(rest)));
                }
                case "say" -> out.put("ok", Json.bool(config.allowCommands && actions.command("say " + rest)));
                case "look" -> {
                    // yaw + pitch: two numbers, not three. (Requiring three silently turned
                    // every look into a usage error.)
                    double[] yawPitch = numbers(rest, 2);
                    out.put("ok", Json.bool(yawPitch != null && actions.look(yawPitch[0], yawPitch[1])));
                }
                case "lookat" -> {
                    double[] xyz = numbers(rest, 3);
                    out.put("ok", Json.bool(xyz != null && actions.lookAt(xyz[0], xyz[1], xyz[2])));
                }
                case "moveto", "goto" -> {
                    double[] xyz = numbers(rest, 3);
                    double range = numbers(rest, 4) != null ? numbers(rest, 4)[3] : 1.5D;
                    out.put("ok", Json.bool(xyz != null && actions.moveTo(xyz[0], xyz[1], xyz[2], range)));
                    out.put("note", Json.str("continuous - poll /progress or /state"));
                }
                case "dig", "mine" -> {
                    int[] xyz = ints(rest, 3);
                    out.put("ok", Json.bool(xyz != null && actions.dig(xyz[0], xyz[1], xyz[2])));
                    out.put("note", Json.str("continuous - poll /progress"));
                }
                /**
                 * Dig-while-walking: a planned list of feet cells, "x y z [x y z ...]".
                 * The controller holds forward, clears what blocks the tunnel and jumps only
                 * real one-block steps; poll /progress for the verdict and the cells dug.
                 */
                case "tunnel" -> {
                    String[] tokens = rest.isEmpty() ? new String[0] : rest.split("\\s+");
                    boolean ok = tokens.length >= 3 && tokens.length % 3 == 0;
                    java.util.List<int[]> points = new java.util.ArrayList<>();
                    for (int i = 0; ok && i < tokens.length; i += 3) {
                        try {
                            points.add(new int[] {
                                    (int) Math.floor(Double.parseDouble(tokens[i])),
                                    (int) Math.floor(Double.parseDouble(tokens[i + 1])),
                                    (int) Math.floor(Double.parseDouble(tokens[i + 2]))
                            });
                        } catch (NumberFormatException e) {
                            ok = false;
                        }
                    }
                    if (!ok) {
                        out.put("ok", Json.bool(false));
                        out.put("error", Json.str("usage: tunnel x y z [x y z ...]"));
                    } else {
                        out.put("ok", Json.bool(actions.tunnel(points)));
                        out.put("note", Json.str("continuous - poll /progress"));
                    }
                }
                case "place" -> {
                    int[] xyz = ints(rest, 3);
                    // "place x y z [face] [item]" - tokens 3 and 4, not 4 and 5.
                    String face = nth(rest, 3);
                    String item = nth(rest, 4);
                    out.put("ok", Json.bool(xyz != null && actions.place(xyz[0], xyz[1], xyz[2], face, item)));
                }
                case "useon", "interact" -> {
                    // Right-click a block face with whatever is held: hoes, buckets, bonemeal,
                    // buttons, and "open this chest / crafting table / furnace".
                    int[] xyz = ints(rest, 3);
                    String face = nth(rest, 3);
                    out.put("ok", Json.bool(xyz != null && actions.place(xyz[0], xyz[1], xyz[2], face, "")));
                    out.put("note", Json.str("continuous - poll /progress or /state"));
                }
                case "target" -> {
                    // What the crosshair points at right now: aim, then mine what you see.
                    String target = actions.targetJson();
                    out.put("ok", Json.bool(target != null && !"null".equals(target)));
                    out.put("target", target == null ? "null" : target);
                }
                case "menu", "slots" -> {
                    String menu = actions.menuJson();
                    out.put("ok", Json.bool(menu != null));
                    out.put("menu", menu == null ? "{\"open\":false,\"reason\":\"client thread busy\"}" : menu);
                }
                case "click" -> {
                    // "click <slot> [button] [pickup|quickmove|swap]"
                    //
                    // The mode is not a number, so the generic numbers() helper can never
                    // parse this: it saw "click 3 0 pickup", failed on "pickup" and returned
                    // "usage" for every single slot click. Crafting and smelting were dead
                    // on the real client while permissive fake-mod tests stayed green.
                    String[] tokens = rest.isEmpty() ? new String[0] : rest.split("\\s+");
                    Integer slot = tokens.length > 0 ? tryInt(tokens[0]) : null;
                    if (slot == null) {
                        out.put("ok", Json.bool(false));
                        out.put("error", Json.str("usage: click <slot> [button] [pickup|quickmove|swap]"));
                    } else {
                        int button = 0;
                        String mode = "pickup";
                        int next = 1;
                        Integer maybeButton = tokens.length > 1 ? tryInt(tokens[1]) : null;
                        if (maybeButton != null) {
                            button = maybeButton;
                            next = 2;
                        }
                        if (tokens.length > next) {
                            mode = tokens[next];
                        }
                        out.put("ok", Json.bool(actions.clickSlot(slot, button, mode)));
                    }
                }
                case "close" -> out.put("ok", Json.bool(actions.closeMenu()));
                case "use", "useitem" -> {
                    // "use [holdMs]": no argument = one instant use (place, throw, milk);
                    // with a duration the key is held, which is what eating and bow-drawing
                    // need (food is only consumed after ~1.6 s of holding).
                    Integer holdMs = tryInt(rest.split("\\s+")[0]);
                    out.put("ok", Json.bool(holdMs == null ? actions.useItem() : actions.holdUse(holdMs)));
                }
                case "select" -> out.put("ok", Json.bool(actions.selectItem(rest)));
                case "drop" -> out.put("ok", Json.bool(actions.dropHeld(!"1".equals(rest))));
                case "attack" -> {
                    double[] all = numbers(rest, 2);
                    if (all == null) {
                        out.put("ok", Json.bool(false));
                        out.put("error", Json.str("usage: attack <entityId> [timeoutMs]"));
                    } else {
                        long timeout = all.length > 1 ? (long) all[1] : 10_000L;
                        out.put("ok", Json.bool(actions.attack((int) all[0], timeout)));
                    }
                }
                case "stop" -> out.put("ok", Json.bool(actions.stop()));
                case "resync" -> {
                    actions.resyncPosition();
                    out.put("ok", Json.bool(true));
                }
                default -> {
                    out.put("ok", Json.bool(false));
                    out.put("error", Json.str("unknown command: " + verb));
                    out.put("known", Json.str(
                            "chat login register cmd look lookat moveto dig place useon menu click close "
                                    + "use select drop attack stop resync"));
                }
            }
        } catch (Exception e) {
            out.put("ok", Json.bool(false));
            out.put("error", Json.str(e.toString()));
        }
        return Json.obj(out);
    }

    // ------------------------------------------------------------------ helpers

    private boolean authorised(HttpExchange exchange) {
        if (config.authToken == null || config.authToken.isEmpty()) {
            return true;
        }
        String header = exchange.getRequestHeaders().getFirst("X-Agent-Token");
        if (config.authToken.equals(header)) {
            return true;
        }
        String query = exchange.getRequestURI().getQuery();
        return query != null && query.contains("token=" + config.authToken);
    }

    private void respond(HttpExchange exchange, int status, String body) throws IOException {
        requests.incrementAndGet();
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
        if (config.verbose) {
            AgentClientMod.LOGGER.info("{} {} -> {}", exchange.getRequestMethod(), exchange.getRequestURI(), status);
        }
    }

    /** Run on the client thread, returning null if the client cannot answer in time. */
    private String onClientThread(java.util.function.Supplier<String> work) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.isSameThread()) {
            return work.get();
        }
        java.util.concurrent.CompletableFuture<String> future = new java.util.concurrent.CompletableFuture<>();
        mc.execute(() -> {
            try {
                future.complete(work.get());
            } catch (Throwable t) {
                future.complete(null);
            }
        });
        try {
            return future.get(5, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception e) {
            return null;
        }
    }

    private static double[] numbers(String rest, int count) {
        String[] tokens = rest.isEmpty() ? new String[0] : rest.split("\\s+");
        if (tokens.length < count) {
            return null;
        }
        try {
            double[] out = new double[Math.min(count, tokens.length)];
            for (int i = 0; i < out.length; i++) {
                out[i] = Double.parseDouble(tokens[i]);
            }
            return out;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** Parse one token as an int, or null when it is missing / not a number. */
    private static Integer tryInt(String token) {
        if (token == null || token.isEmpty()) {
            return null;
        }
        try {
            return (int) Math.floor(Double.parseDouble(token));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static int[] ints(String rest, int count) {
        String[] tokens = rest.isEmpty() ? new String[0] : rest.split("\\s+");
        if (tokens.length < count) {
            return null;
        }
        try {
            int[] out = new int[count];
            for (int i = 0; i < count; i++) {
                out[i] = (int) Math.floor(Double.parseDouble(tokens[i]));
            }
            return out;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String nth(String rest, int index) {
        String[] tokens = rest.isEmpty() ? new String[0] : rest.split("\\s+");
        return index < tokens.length ? tokens[index] : "";
    }
}
