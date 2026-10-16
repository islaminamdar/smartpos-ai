package info.internext.pos.access;

import info.internext.pos.offline.CanonicalJson;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.Set;

/** Validates the native access display contract. This never authorizes offline sales. */
public final class AccessContext {
    public static final int MAX_BYTES = 131_072;
    private AccessContext() {}

    public static JSONObject parse(String raw, String expectedActorId) throws Exception {
        JSONObject input = object(CanonicalJson.transport(raw, MAX_BYTES));
        keys(input, "schemaVersion", "status", "actorId", "branches", "device", "canPrepareOffline");
        Object version = input.get("schemaVersion");
        if (!(version instanceof Long) || ((Long)version) != 1L) throw invalid();
        if (input.get("canPrepareOffline") != Boolean.FALSE) throw invalid();
        String status = string(input, "status", 10);
        if (!(input.get("branches") instanceof JSONArray)) throw invalid();
        JSONArray branches = (JSONArray)input.get("branches");
        if (branches.length() > 500) throw invalid();
        if (expectedActorId != null) uuid(expectedActorId);
        if (status.equals("signed_out")) {
            if (input.get("actorId") != JSONObject.NULL || input.get("device") != JSONObject.NULL || branches.length() != 0) throw invalid();
        } else if (status.equals("signed_in")) {
            if (branches.length() == 0) throw invalid();
            String actor = uuid(input.get("actorId"));
            if (expectedActorId != null && !expectedActorId.equals(actor)) throw invalid();
            Set<String> ids = new HashSet<>();
            for (int i = 0; i < branches.length(); i++) {
                JSONObject branch = object(branches.get(i));
                keys(branch, "id", "organizationId", "name", "role");
                if (!ids.add(uuid(branch.get("id")))) throw invalid();
                uuid(branch.get("organizationId"));
                string(branch, "name", 200);
                String role = string(branch, "role", 7);
                if (!role.equals("owner") && !role.equals("manager") && !role.equals("cashier")) throw invalid();
            }
            if (input.get("device") != JSONObject.NULL) {
                JSONObject device = device(object(input.get("device")));
                if (!ids.contains(device.getString("branchId"))) throw invalid();
            }
        } else throw invalid();
        // Parsed fresh on every call: no mutable input or cached object is shared with callers.
        return input;
    }

    public static String sessionActor(String raw) throws Exception {
        JSONObject input = object(CanonicalJson.transport(raw, MAX_BYTES));
        keys(input, "status", "userId");
        if (!string(input, "status", 13).equals("authenticated")) throw invalid();
        return uuid(input.get("userId"));
    }

    public static JSONObject enrollment(String raw, String expectedBranchId) throws Exception {
        uuid(expectedBranchId);
        JSONObject input = object(CanonicalJson.transport(raw, MAX_BYTES));
        keys(input, "status", "device");
        if (!string(input, "status", 8).equals("enrolled")) throw invalid();
        JSONObject device = device(object(input.get("device")));
        if (!device.getString("branchId").equals(expectedBranchId)) throw invalid();
        return device;
    }

    public static JSONObject device(JSONObject input) throws Exception {
        keys(input, "id", "branchId", "name");
        return new JSONObject().put("id", uuid(input.get("id")))
            .put("branchId", uuid(input.get("branchId")))
            .put("name", string(input, "name", 80));
    }

    private static JSONObject object(Object value) {
        if (!(value instanceof JSONObject)) throw invalid();
        return (JSONObject)value;
    }
    private static void keys(JSONObject value, String... names) {
        if (value == null || value.length() != names.length) throw invalid();
        for (String name : names) if (!value.has(name)) throw invalid();
    }
    private static String uuid(Object value) {
        if (!(value instanceof String) || !((String)value).matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw invalid();
        return (String)value;
    }
    private static String string(JSONObject value, String key, int limit) throws Exception {
        Object raw = value.get(key);
        if (!(raw instanceof String)) throw invalid();
        String result = (String)raw;
        if (result.isEmpty() || result.length() > limit || result.trim().isEmpty()) throw invalid();
        for (int i = 0; i < result.length(); i++) {
            char c = result.charAt(i);
            if (Character.isISOControl(c)) throw invalid();
            if (Character.isHighSurrogate(c)) {
                if (++i >= result.length() || !Character.isLowSurrogate(result.charAt(i))) throw invalid();
            } else if (Character.isLowSurrogate(c)) throw invalid();
        }
        return result;
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("invalid_access_context"); }
}
