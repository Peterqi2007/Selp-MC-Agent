package dev.agentclient;

import java.util.Collection;
import java.util.Map;

/**
 * Hand-rolled JSON writer.
 *
 * The mod deliberately has zero third-party dependencies: a control mod that ships
 * inside someone else's 151-mod pack must not introduce classes that can collide. The
 * payloads here are small and flat, so a minimal writer is plenty.
 */
final class Json {

    private Json() {
    }

    /** Quote and escape a string. */
    static String str(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder(value.length() + 2);
        sb.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    static String num(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            return "0";
        }
        // Two decimals is plenty for coordinates and avoids very long payloads.
        return String.format(java.util.Locale.ROOT, "%.2f", value);
    }

    static String num(long value) {
        return Long.toString(value);
    }

    static String bool(boolean value) {
        return value ? "true" : "false";
    }

    /** {"k":v,...} with values already rendered. */
    static String obj(Map<String, String> entries) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, String> e : entries.entrySet()) {
            if (!first) {
                sb.append(',');
            }
            first = false;
            sb.append(str(e.getKey())).append(':').append(e.getValue());
        }
        return sb.append('}').toString();
    }

    /** [v,...] with values already rendered. */
    static String arr(Collection<String> rendered) {
        return "[" + String.join(",", rendered) + "]";
    }

    static String point(double x, double y, double z) {
        return "{\"x\":" + num(x) + ",\"y\":" + num(y) + ",\"z\":" + num(z) + "}";
    }

    /** Extract a flat string field from a small JSON body: {"command":"say hi"}. */
    static String field(String body, String key) {
        if (body == null) {
            return null;
        }
        String needle = "\"" + key + "\"";
        int at = body.indexOf(needle);
        if (at < 0) {
            return null;
        }
        int colon = body.indexOf(':', at + needle.length());
        if (colon < 0) {
            return null;
        }
        int i = colon + 1;
        while (i < body.length() && Character.isWhitespace(body.charAt(i))) {
            i++;
        }
        if (i >= body.length() || body.charAt(i) != '"') {
            return null;
        }
        StringBuilder out = new StringBuilder();
        for (int p = i + 1; p < body.length(); p++) {
            char c = body.charAt(p);
            if (c == '\\' && p + 1 < body.length()) {
                char next = body.charAt(++p);
                switch (next) {
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    default -> out.append(next);
                }
                continue;
            }
            if (c == '"') {
                return out.toString();
            }
            out.append(c);
        }
        return null;
    }
}
