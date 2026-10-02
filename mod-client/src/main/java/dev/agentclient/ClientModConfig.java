package dev.agentclient;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraftforge.fml.loading.FMLPaths;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Mod configuration, read from {@code config/agent-client.json} in the *client's* game
 * directory.
 *
 * Gson is available because Forge itself ships it on the 1.20.1 classpath, so using it
 * here adds no new dependency.
 */
public final class ClientModConfig {

    /** Where the agent connects. Bound to loopback only - never expose this. */
    public String bindAddress = "127.0.0.1";
    public int port = 8899;

    /** Master switch. When false the HTTP server never starts. */
    public boolean enabled = true;

    /**
     * Bearer token. Empty means "no auth", which is acceptable because we only listen
     * on loopback; set it if other local processes are untrusted.
     */
    public String authToken = "";

    /**
     * Auto-answer an AuthMe style login prompt.
     *
     * The client mod does the sending (it owns the chat connection), but the decision to
     * log in belongs to the agent. Keeping the password out of the mod's config is
     * deliberate: it lives in the agent's config, which is the component that already
     * holds credentials.
     */
    public boolean allowCommands = true;

    /** Print every request to the log. Useful when first wiring the agent up. */
    public boolean verbose = false;

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static Path configPath;
    private static ClientModConfig instance;

    public static ClientModConfig get() {
        if (instance == null) {
            instance = load();
        }
        return instance;
    }

    public static Path path() {
        if (configPath == null) {
            configPath = FMLPaths.CONFIGDIR.get().resolve("agent-client.json");
        }
        return configPath;
    }

    private static ClientModConfig load() {
        Path file = path();
        try {
            if (Files.exists(file)) {
                String text = Files.readString(file, StandardCharsets.UTF_8);
                JsonObject obj = JsonParser.parseString(text).getAsJsonObject();
                ClientModConfig cfg = new ClientModConfig();
                if (obj.has("bindAddress")) cfg.bindAddress = obj.get("bindAddress").getAsString();
                if (obj.has("port")) cfg.port = obj.get("port").getAsInt();
                if (obj.has("enabled")) cfg.enabled = obj.get("enabled").getAsBoolean();
                if (obj.has("authToken")) cfg.authToken = obj.get("authToken").getAsString();
                if (obj.has("allowCommands")) cfg.allowCommands = obj.get("allowCommands").getAsBoolean();
                if (obj.has("verbose")) cfg.verbose = obj.get("verbose").getAsBoolean();
                return cfg;
            }
        } catch (Exception e) {
            AgentClientMod.LOGGER.warn("could not read {}: {} - using defaults", file, e.getMessage());
            return new ClientModConfig();
        }
        // First run: write the defaults so the file is discoverable.
        ClientModConfig cfg = new ClientModConfig();
        cfg.save();
        return cfg;
    }

    public void save() {
        try {
            Files.createDirectories(path().getParent());
            Files.writeString(path(), GSON.toJson(this), StandardCharsets.UTF_8);
        } catch (IOException e) {
            AgentClientMod.LOGGER.warn("could not write {}: {}", path(), e.getMessage());
        }
    }
}
