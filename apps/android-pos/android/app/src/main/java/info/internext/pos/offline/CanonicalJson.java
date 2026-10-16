package info.internext.pos.offline;

import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

/** Exact private protocol encoding shared with lib/pos/offline/canonical.ts. */
public final class CanonicalJson {
    public static final int MAX_BYTES = 1_048_576;
    private static final long MAX_INTEGER = 9_007_199_254_740_991L;
    private CanonicalJson() {}

    public static byte[] bytes(Object value) throws Exception {
        StringBuilder out = new StringBuilder();
        encode(value, out, 0, Collections.newSetFromMap(new IdentityHashMap<>()));
        byte[] result = out.toString().getBytes(StandardCharsets.UTF_8);
        if (result.length > MAX_BYTES) throw invalid();
        return result;
    }

    public static Object parse(byte[] bytes) throws Exception {
        if (bytes.length == 0 || bytes.length > MAX_BYTES) throw invalid();
        String text = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString();
        Object value = transport(text, MAX_BYTES);
        if (!java.util.Arrays.equals(bytes, bytes(value))) throw invalid();
        return value;
    }

    /** Strict, bounded JSON grammar before constructing Android JSON objects. No JSONTokener
     * leniency (comments, single quotes, duplicate keys, implicit nulls or unquoted tokens). */
    public static Object transport(String text, int maxBytes) throws Exception {
        if (text == null || text.length() > maxBytes || text.getBytes(StandardCharsets.UTF_8).length > maxBytes) throw invalid();
        Parser parser = new Parser(text); Object value = parser.value(0); parser.space();
        if (parser.offset != text.length()) throw invalid();
        return value;
    }

    private static final class Parser {
        final String text; int offset;
        Parser(String text) { this.text = text; }
        void space() { while (offset < text.length() && " \t\r\n".indexOf(text.charAt(offset)) >= 0) offset++; }
        char next() { if (offset >= text.length()) throw invalid(); return text.charAt(offset++); }
        boolean take(char expected) { if (offset < text.length() && text.charAt(offset) == expected) { offset++; return true; } return false; }
        Object value(int depth) throws Exception {
            if (depth > 32) throw invalid(); space(); if (offset >= text.length()) throw invalid();
            char c = text.charAt(offset);
            if (c == '"') return string();
            if (take('{')) {
                JSONObject object = new JSONObject(); space(); if (take('}')) return object;
                do {
                    space(); if (offset >= text.length() || text.charAt(offset) != '"') throw invalid();
                    String key = string(); if (object.has(key)) throw invalid();
                    space(); if (!take(':')) throw invalid();
                    object.put(key, value(depth + 1)); space(); if (take('}')) return object;
                } while (take(','));
                throw invalid();
            }
            if (take('[')) {
                JSONArray array = new JSONArray(); space(); if (take(']')) return array;
                do { array.put(value(depth + 1)); space(); if (take(']')) return array; } while (take(','));
                throw invalid();
            }
            if (text.startsWith("null", offset)) { offset += 4; return JSONObject.NULL; }
            if (text.startsWith("true", offset)) { offset += 4; return true; }
            if (text.startsWith("false", offset)) { offset += 5; return false; }
            int start = offset; take('-');
            if (!take('0')) {
                if (offset >= text.length() || text.charAt(offset) < '1' || text.charAt(offset) > '9') throw invalid();
                while (offset < text.length() && text.charAt(offset) >= '0' && text.charAt(offset) <= '9') {
                    offset++; if (offset - start > 17) throw invalid();
                }
            }
            long number;
            try { number = Long.parseLong(text.substring(start, offset)); } catch (NumberFormatException e) { throw invalid(); }
            if (number < -MAX_INTEGER || number > MAX_INTEGER || (number == 0 && text.charAt(start) == '-')) throw invalid();
            return number;
        }
        String string() {
            if (next() != '"') throw invalid(); StringBuilder result = new StringBuilder();
            while (true) {
                char c = next();
                if (c == '"') {
                    for (int i = 0; i < result.length(); i++) {
                        char u = result.charAt(i);
                        if (Character.isHighSurrogate(u)) { if (++i >= result.length() || !Character.isLowSurrogate(result.charAt(i))) throw invalid(); }
                        else if (Character.isLowSurrogate(u)) throw invalid();
                    }
                    return result.toString();
                }
                if (c < 32) throw invalid();
                if (c != '\\') { result.append(c); continue; }
                c = next();
                switch (c) {
                    case '"': case '\\': case '/': result.append(c); break;
                    case 'b': result.append('\b'); break;
                    case 'f': result.append('\f'); break;
                    case 'n': result.append('\n'); break;
                    case 'r': result.append('\r'); break;
                    case 't': result.append('\t'); break;
                    case 'u':
                        int code = 0;
                        for (int i = 0; i < 4; i++) { int digit = "0123456789abcdef".indexOf(Character.toLowerCase(next())); if (digit < 0) throw invalid(); code = code * 16 + digit; }
                        result.append((char)code); break;
                    default: throw invalid();
                }
            }
        }
    }

    private static void encode(Object value, StringBuilder out, int depth, Set<Object> seen) throws Exception {
        if (depth > 32 || out.length() > MAX_BYTES) throw invalid();
        if (value == null || value == JSONObject.NULL) { out.append("null"); return; }
        if (value instanceof Boolean) { out.append(value); return; }
        if (value instanceof String) { quote((String)value, out); return; }
        if (value instanceof Number) {
            // Floating representations are never allowed, including -0 and integral doubles.
            if (!(value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long)) throw invalid();
            long number = ((Number)value).longValue();
            if (number < -MAX_INTEGER || number > MAX_INTEGER) throw invalid();
            out.append(number); return;
        }
        if (!seen.add(value)) throw invalid();
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray)value; out.append('[');
            for (int i = 0; i < array.length(); i++) {
                if (i != 0) out.append(',');
                encode(array.get(i), out, depth + 1, seen);
            }
            out.append(']');
        } else if (value instanceof JSONObject) {
            JSONObject object = (JSONObject)value;
            ArrayList<String> keys = new ArrayList<>(); object.keys().forEachRemaining(keys::add);
            Collections.sort(keys); out.append('{');
            for (int i = 0; i < keys.size(); i++) {
                if (i != 0) out.append(',');
                String key = keys.get(i); quote(key, out); out.append(':');
                encode(object.get(key), out, depth + 1, seen);
            }
            out.append('}');
        } else throw invalid();
        seen.remove(value);
    }

    private static void quote(String text, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (++i >= text.length() || !Character.isLowSurrogate(text.charAt(i))) throw invalid();
                out.append(c).append(text.charAt(i));
            } else if (Character.isLowSurrogate(c)) throw invalid();
            else if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c == '\b') out.append("\\b");
            else if (c == '\f') out.append("\\f");
            else if (c == '\n') out.append("\\n");
            else if (c == '\r') out.append("\\r");
            else if (c == '\t') out.append("\\t");
            else if (c < 32) {
                out.append("\\u00").append("0123456789abcdef".charAt(c >> 4)).append("0123456789abcdef".charAt(c & 15));
            } else out.append(c);
            if (out.length() > MAX_BYTES) throw invalid();
        }
        out.append('"');
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("invalid_canonical_json"); }
}
