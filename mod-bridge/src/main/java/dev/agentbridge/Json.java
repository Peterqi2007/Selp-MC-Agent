package dev.agentbridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Dependency-free JSON reader/writer.
 *
 * <p>The mod deliberately pulls in no JSON library: everything it has to emit is built here, and
 * the only documents it has to read are its own config file and the small
 * {@code {"command":"..."}} request bodies posted to {@code /command}.
 *
 * <p>Values map to plain Java types:
 * <ul>
 *   <li>object -&gt; {@link LinkedHashMap}&lt;String, Object&gt; (insertion ordered)</li>
 *   <li>array -&gt; {@link ArrayList}&lt;Object&gt;</li>
 *   <li>string -&gt; {@link String}</li>
 *   <li>number -&gt; {@link Long} when integral, otherwise {@link Double}</li>
 *   <li>true/false -&gt; {@link Boolean}, null -&gt; {@code null}</li>
 * </ul>
 */
public final class Json {
	private Json() {
	}

	// ------------------------------------------------------------------ helpers

	/** Builds an insertion-ordered JSON object from alternating key/value arguments. */
	public static Map<String, Object> obj(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();

		for (int i = 0; i + 1 < keyValues.length; i += 2) {
			map.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
		}

		return map;
	}

	// -------------------------------------------------------------------- write

	/** Serialises maps, iterables, arrays, strings, numbers, booleans and nulls. */
	public static String write(Object value) {
		StringBuilder sb = new StringBuilder(256);
		writeValue(sb, value);
		return sb.toString();
	}

	private static void writeValue(StringBuilder sb, Object value) {
		if (value == null) {
			sb.append("null");
		} else if (value instanceof String string) {
			writeString(sb, string);
		} else if (value instanceof Boolean bool) {
			sb.append(bool.booleanValue());
		} else if (value instanceof Double || value instanceof Float) {
			double d = ((Number) value).doubleValue();

			if (Double.isNaN(d) || Double.isInfinite(d)) {
				sb.append("null");
			} else {
				sb.append(trimNumber(d));
			}
		} else if (value instanceof Number number) {
			sb.append(number.toString());
		} else if (value instanceof Map<?, ?> map) {
			sb.append('{');
			boolean first = true;

			for (Map.Entry<?, ?> entry : map.entrySet()) {
				if (!first) {
					sb.append(',');
				}

				first = false;
				writeString(sb, String.valueOf(entry.getKey()));
				sb.append(':');
				writeValue(sb, entry.getValue());
			}

			sb.append('}');
		} else if (value instanceof Iterable<?> iterable) {
			sb.append('[');
			boolean first = true;

			for (Object element : iterable) {
				if (!first) {
					sb.append(',');
				}

				first = false;
				writeValue(sb, element);
			}

			sb.append(']');
		} else if (value instanceof Object[] array) {
			sb.append('[');

			for (int i = 0; i < array.length; i++) {
				if (i > 0) {
					sb.append(',');
				}

				writeValue(sb, array[i]);
			}

			sb.append(']');
		} else {
			writeString(sb, String.valueOf(value));
		}
	}

	private static String trimNumber(double d) {
		if (d == Math.rint(d) && Math.abs(d) < 1.0e15) {
			return Long.toString((long) d);
		}

		return Double.toString(d);
	}

	private static void writeString(StringBuilder sb, String value) {
		sb.append('"');

		for (int i = 0; i < value.length(); i++) {
			char c = value.charAt(i);

			switch (c) {
			case '"' -> sb.append("\\\"");
			case '\\' -> sb.append("\\\\");
			case '\n' -> sb.append("\\n");
			case '\r' -> sb.append("\\r");
			case '\t' -> sb.append("\\t");
			case '\b' -> sb.append("\\b");
			case '\f' -> sb.append("\\f");
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
	}

	// -------------------------------------------------------------------- parse

	public static Object parse(String text) {
		Parser parser = new Parser(text);
		parser.skipWhitespace();
		Object value = parser.parseValue();
		parser.skipWhitespace();

		if (!parser.atEnd()) {
			throw new IllegalArgumentException("trailing content at offset " + parser.position);
		}

		return value;
	}

	/** Parses a document that must be a JSON object. */
	public static Map<String, Object> parseObject(String text) {
		Object value = parse(text);

		if (value instanceof Map<?, ?> map) {
			Map<String, Object> result = new LinkedHashMap<>();

			for (Map.Entry<?, ?> entry : map.entrySet()) {
				result.put(String.valueOf(entry.getKey()), entry.getValue());
			}

			return result;
		}

		throw new IllegalArgumentException("expected a JSON object");
	}

	public static String getString(Map<String, Object> object, String key, String fallback) {
		Object value = object.get(key);
		return value instanceof String string ? string : fallback;
	}

	public static int getInt(Map<String, Object> object, String key, int fallback) {
		Object value = object.get(key);

		if (value instanceof Number number) {
			return number.intValue();
		}

		if (value instanceof String string) {
			try {
				return Integer.parseInt(string.trim());
			} catch (NumberFormatException ignored) {
				return fallback;
			}
		}

		return fallback;
	}

	public static boolean getBoolean(Map<String, Object> object, String key, boolean fallback) {
		Object value = object.get(key);

		if (value instanceof Boolean bool) {
			return bool.booleanValue();
		}

		if (value instanceof String string) {
			return Boolean.parseBoolean(string.trim());
		}

		return fallback;
	}

	// ------------------------------------------------------------------- parser

	private static final class Parser {
		private final String text;
		private int position;

		Parser(String text) {
			this.text = text;
		}

		boolean atEnd() {
			return position >= text.length();
		}

		void skipWhitespace() {
			while (position < text.length() && Character.isWhitespace(text.charAt(position))) {
				position++;
			}
		}

		private IllegalArgumentException error(String message) {
			return new IllegalArgumentException(message + " at offset " + position);
		}

		private char peek() {
			if (atEnd()) {
				throw error("unexpected end of input");
			}

			return text.charAt(position);
		}

		private void expectLiteral(String literal) {
			if (!text.startsWith(literal, position)) {
				throw error("expected '" + literal + "'");
			}

			position += literal.length();
		}

		Object parseValue() {
			skipWhitespace();

			if (atEnd()) {
				throw error("unexpected end of input");
			}

			char c = peek();

			return switch (c) {
			case '{' -> parseObjectValue();
			case '[' -> parseArrayValue();
			case '"' -> parseStringValue();
			case 't' -> {
				expectLiteral("true");
				yield Boolean.TRUE;
			}
			case 'f' -> {
				expectLiteral("false");
				yield Boolean.FALSE;
			}
			case 'n' -> {
				expectLiteral("null");
				yield null;
			}
			default -> parseNumberValue();
			};
		}

		private Map<String, Object> parseObjectValue() {
			Map<String, Object> map = new LinkedHashMap<>();
			position++; // consume '{'
			skipWhitespace();

			if (!atEnd() && peek() == '}') {
				position++;
				return map;
			}

			while (true) {
				skipWhitespace();

				if (atEnd() || peek() != '"') {
					throw error("expected an object key");
				}

				String key = parseStringValue();
				skipWhitespace();

				if (atEnd() || peek() != ':') {
					throw error("expected ':'");
				}

				position++;
				map.put(key, parseValue());
				skipWhitespace();

				if (atEnd()) {
					throw error("unterminated object");
				}

				char c = peek();
				position++;

				if (c == '}') {
					return map;
				}

				if (c != ',') {
					throw error("expected ',' or '}'");
				}
			}
		}

		private List<Object> parseArrayValue() {
			List<Object> list = new ArrayList<>();
			position++; // consume '['
			skipWhitespace();

			if (!atEnd() && peek() == ']') {
				position++;
				return list;
			}

			while (true) {
				list.add(parseValue());
				skipWhitespace();

				if (atEnd()) {
					throw error("unterminated array");
				}

				char c = peek();
				position++;

				if (c == ']') {
					return list;
				}

				if (c != ',') {
					throw error("expected ',' or ']'");
				}
			}
		}

		private String parseStringValue() {
			position++; // consume opening quote
			StringBuilder sb = new StringBuilder();

			while (true) {
				if (atEnd()) {
					throw error("unterminated string");
				}

				char c = text.charAt(position++);

				if (c == '"') {
					return sb.toString();
				}

				if (c != '\\') {
					sb.append(c);
					continue;
				}

				if (atEnd()) {
					throw error("unterminated escape sequence");
				}

				char escaped = text.charAt(position++);

				switch (escaped) {
				case '"' -> sb.append('"');
				case '\\' -> sb.append('\\');
				case '/' -> sb.append('/');
				case 'b' -> sb.append('\b');
				case 'f' -> sb.append('\f');
				case 'n' -> sb.append('\n');
				case 'r' -> sb.append('\r');
				case 't' -> sb.append('\t');
				case 'u' -> {
					if (position + 4 > text.length()) {
						throw error("truncated unicode escape");
					}

					String hex = text.substring(position, position + 4);
					position += 4;

					try {
						sb.append((char) Integer.parseInt(hex, 16));
					} catch (NumberFormatException e) {
						throw error("invalid unicode escape '" + hex + "'");
					}
				}
				default -> throw error("invalid escape '\\" + escaped + "'");
				}
			}
		}

		private Object parseNumberValue() {
			int start = position;

			if (!atEnd() && (peek() == '-' || peek() == '+')) {
				position++;
			}

			boolean floating = false;

			while (!atEnd()) {
				char c = text.charAt(position);

				if (c >= '0' && c <= '9') {
					position++;
				} else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
					floating = floating || c == '.' || c == 'e' || c == 'E';
					position++;
				} else {
					break;
				}
			}

			String literal = text.substring(start, position);

			if (literal.isEmpty()) {
				throw error("expected a value");
			}

			try {
				return floating ? (Object) Double.valueOf(literal) : (Object) Long.valueOf(literal);
			} catch (NumberFormatException e) {
				throw error("invalid number '" + literal + "'");
			}
		}
	}
}
