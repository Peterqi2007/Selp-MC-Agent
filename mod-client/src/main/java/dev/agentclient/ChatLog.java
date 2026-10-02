package dev.agentclient;

import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.ClientChatReceivedEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.eventbus.api.SubscribeEvent;

import java.util.ArrayList;
import java.util.List;

/**
 * Records the last few chat/command feedback lines so the agent (and `/diag/slash`) can
 * observe what the server actually said.
 *
 * Why this is needed: whether `ClientPacketListener.sendCommand` wants a leading slash is
 * not documented, and getting it wrong makes `/login` fail silently. The only reliable way
 * to settle it is to send a probe command and read the server's reply - which means the mod
 * has to capture incoming chat.
 *
 * Bounded on purpose: a long play session must not grow this without limit.
 */
public final class ChatLog {

    private static final int MAX = 50;
    private static final List<String> LINES = new ArrayList<>();

    private ChatLog() {
    }

    /** Register the listener. Called once from the mod constructor. */
    public static void register() {
        MinecraftForge.EVENT_BUS.register(ChatLog.class);
    }

    @SubscribeEvent
    public static void onChat(ClientChatReceivedEvent event) {
        try {
            String text = event.getMessage().getString();
            if (text == null || text.isBlank()) {
                return;
            }
            synchronized (LINES) {
                LINES.add(text);
                while (LINES.size() > MAX) {
                    LINES.remove(0);
                }
            }
        } catch (Exception e) {
            AgentClientMod.LOGGER.debug("chat capture failed: {}", e.getMessage());
        }
    }

    /** Last {@code n} lines, oldest first. */
    public static List<String> recent(int n) {
        synchronized (LINES) {
            int from = Math.max(0, LINES.size() - n);
            return new ArrayList<>(LINES.subList(from, LINES.size()));
        }
    }

    public static void clear() {
        synchronized (LINES) {
            LINES.clear();
        }
    }

    public static int size() {
        synchronized (LINES) {
            return LINES.size();
        }
    }

    /** JSON array of the last n lines. */
    public static String recentJson(int n) {
        List<String> lines = recent(n);
        List<String> rendered = new ArrayList<>(lines.size());
        for (String line : lines) {
            rendered.add(Json.str(line));
        }
        return Json.arr(rendered);
    }
}
