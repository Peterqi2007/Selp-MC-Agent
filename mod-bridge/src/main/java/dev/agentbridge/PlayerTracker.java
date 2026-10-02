package dev.agentbridge;

import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Keeps track of who is online, where they were last seen and what they carry.
 *
 * <p>Join/leave is driven by Fabric's connection events. The richer per-player data (health, food,
 * inventory) is read straight from the live {@link ServerPlayerEntity} — but only from the server
 * thread, which is why {@link #buildState(MinecraftServer)} must be invoked through
 * {@code MinecraftServer#execute} (see {@link BridgeHttpServer#submitToServer}).
 */
public final class PlayerTracker {
	private final Map<UUID, TrackedPlayer> tracked = new ConcurrentHashMap<>();

	/** Record of a player the bridge has seen since the server started. */
	public static final class TrackedPlayer {
		public final UUID uuid;
		public final String name;
		public final long firstSeenMs;
		public volatile long lastSeenMs;
		public volatile int sessions;
		public volatile boolean online;
		public volatile double x;
		public volatile double y;
		public volatile double z;
		public volatile String dimension = "unknown";

		TrackedPlayer(UUID uuid, String name, long now) {
			this.uuid = uuid;
			this.name = name;
			this.firstSeenMs = now;
			this.lastSeenMs = now;
		}
	}

	/** Registers the join/leave listeners. Called once during mod initialisation. */
	public void register() {
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
			ServerPlayerEntity player = handler.player;

			if (player == null) {
				return;
			}

			recordJoin(player);
		});

		ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
			ServerPlayerEntity player = handler.player;

			if (player == null) {
				return;
			}

			recordLeave(player);
		});
	}

	private void recordJoin(ServerPlayerEntity player) {
		long now = System.currentTimeMillis();
		UUID uuid = player.getUuid();
		String name = player.getGameProfile().getName();
		TrackedPlayer entry = tracked.computeIfAbsent(uuid, id -> new TrackedPlayer(id, name, now));

		entry.online = true;
		entry.sessions++;
		entry.lastSeenMs = now;
		updatePosition(entry, player);
		AgentBridgeMod.LOGGER.info("[agent-bridge] {} joined ({} tracked player(s))", name, tracked.size());
	}

	private void recordLeave(ServerPlayerEntity player) {
		TrackedPlayer entry = tracked.get(player.getUuid());

		if (entry != null) {
			updatePosition(entry, player);
			entry.online = false;
			entry.lastSeenMs = System.currentTimeMillis();
		}

		AgentBridgeMod.LOGGER.info("[agent-bridge] {} left", player.getGameProfile().getName());
	}

	private static void updatePosition(TrackedPlayer entry, ServerPlayerEntity player) {
		Vec3d pos = player.getPos();
		entry.x = pos.x;
		entry.y = pos.y;
		entry.z = pos.z;
		entry.dimension = player.getWorld().getRegistryKey().getValue().toString();
	}

	public int trackedCount() {
		return tracked.size();
	}

	/** Everyone the bridge has seen since the server started. Safe to call from any thread. */
	public List<Map<String, Object>> knownPlayers() {
		List<Map<String, Object>> out = new ArrayList<>();

		for (TrackedPlayer entry : tracked.values()) {
			out.add(Json.obj(
					"uuid", entry.uuid.toString(),
					"name", entry.name,
					"online", entry.online,
					"sessions", entry.sessions,
					"firstSeenMs", entry.firstSeenMs,
					"lastSeenMs", entry.lastSeenMs,
					"position", Json.obj("x", entry.x, "y", entry.y, "z", entry.z),
					"dimension", entry.dimension));
		}

		return out;
	}

	// ------------------------------------------------------------ server thread

	/** Compact player list used by {@code GET /players}. Must run on the server thread. */
	public List<Map<String, Object>> onlinePlayers(MinecraftServer server) {
		List<Map<String, Object>> out = new ArrayList<>();

		for (ServerPlayerEntity player : server.getPlayerManager().getPlayerList()) {
			out.add(Json.obj(
					"name", player.getGameProfile().getName(),
					"uuid", player.getUuid().toString(),
					"dimension", player.getWorld().getRegistryKey().getValue().toString(),
					"position", position(player),
					"blockPosition", blockPosition(player),
					"health", player.getHealth(),
					"maxHealth", player.getMaxHealth(),
					"food", player.getHungerManager().getFoodLevel(),
					"gamemode", player.interactionManager.getGameMode().getName(),
					"pingMs", player.pingMilliseconds));
		}

		return out;
	}

	/** Full world + player snapshot used by {@code GET /state}. Must run on the server thread. */
	public Map<String, Object> buildState(MinecraftServer server) {
		Map<String, Object> root = new LinkedHashMap<>();
		root.put("ok", true);
		root.put("mod", AgentBridgeMod.MOD_ID);
		root.put("version", AgentBridgeMod.version());
		root.put("tick", server.getTicks());
		root.put("serverPort", server.getServerPort());
		root.put("minecraftVersion", server.getVersion());
		root.put("hardcore", server.isHardcore());
		root.put("maxPlayers", server.getMaxPlayerCount());
		root.put("playerCount", server.getCurrentPlayerCount());

		var overworld = server.getOverworld();
		root.put("difficulty", server.getSaveProperties().getDifficulty().getName());
		root.put("dayTime", overworld.getTimeOfDay());
		root.put("worldTime", overworld.getTime());
		root.put("isDay", overworld.isDay());
		root.put("raining", overworld.isRaining());
		root.put("thundering", overworld.isThundering());
		root.put("rainGradient", (double) overworld.getRainGradient(1.0F));
		root.put("overworldDimension", overworld.getRegistryKey().getValue().toString());

		List<String> names = new ArrayList<>();
		List<Map<String, Object>> players = new ArrayList<>();

		for (ServerPlayerEntity player : server.getPlayerManager().getPlayerList()) {
			names.add(player.getGameProfile().getName());

			TrackedPlayer entry = tracked.get(player.getUuid());
			Map<String, Object> playerJson = new LinkedHashMap<>();
			playerJson.put("name", player.getGameProfile().getName());
			playerJson.put("uuid", player.getUuid().toString());
			playerJson.put("dimension", player.getWorld().getRegistryKey().getValue().toString());
			playerJson.put("position", position(player));
			playerJson.put("blockPosition", blockPosition(player));
			playerJson.put("health", player.getHealth());
			playerJson.put("maxHealth", player.getMaxHealth());
			playerJson.put("absorption", player.getAbsorptionAmount());
			playerJson.put("food", player.getHungerManager().getFoodLevel());
			playerJson.put("saturation", (double) player.getHungerManager().getSaturationLevel());
			playerJson.put("xpLevel", player.experienceLevel);
			playerJson.put("gamemode", player.interactionManager.getGameMode().getName());
			playerJson.put("onGround", player.isOnGround());
			playerJson.put("pingMs", player.pingMilliseconds);
			playerJson.put("inventory", inventorySummary(player));
			playerJson.put("heldItem", itemId(player.getMainHandStack()));
			playerJson.put("offhandItem", itemId(player.getOffHandStack()));
			playerJson.put("tracked", entry != null);
			playerJson.put("trackedFirstSeenMs", entry == null ? 0L : entry.firstSeenMs);
			players.add(playerJson);
		}

		root.put("onlinePlayerNames", names);
		root.put("players", players);
		root.put("trackedPlayers", knownPlayers());
		return root;
	}

	private static Map<String, Object> position(ServerPlayerEntity player) {
		Vec3d pos = player.getPos();
		return Json.obj("x", pos.x, "y", pos.y, "z", pos.z);
	}

	private static Map<String, Object> blockPosition(ServerPlayerEntity player) {
		BlockPos pos = player.getBlockPos();
		return Json.obj("x", pos.getX(), "y", pos.getY(), "z", pos.getZ());
	}

	/** Aggregate of the player's inventory: item id -&gt; total count. */
	private static Map<String, Object> inventorySummary(ServerPlayerEntity player) {
		Map<String, Integer> counts = new TreeMap<>();
		PlayerInventory inventory = player.getInventory();

		for (int slot = 0; slot < inventory.size(); slot++) {
			accumulate(counts, inventory.getStack(slot));
		}

		for (ItemStack stack : inventory.armor) {
			accumulate(counts, stack);
		}

		for (ItemStack stack : inventory.offHand) {
			accumulate(counts, stack);
		}

		Map<String, Object> out = new LinkedHashMap<>();
		counts.forEach(out::put);
		return out;
	}

	private static void accumulate(Map<String, Integer> counts, ItemStack stack) {
		if (stack == null || stack.isEmpty()) {
			return;
		}

		counts.merge(itemId(stack), stack.getCount(), Integer::sum);
	}

	private static String itemId(ItemStack stack) {
		if (stack == null || stack.isEmpty()) {
			return "";
		}

		return Registries.ITEM.getId(stack.getItem()).toString();
	}
}
