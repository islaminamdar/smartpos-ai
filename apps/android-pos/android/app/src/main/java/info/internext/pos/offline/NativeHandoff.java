package info.internext.pos.offline;

import java.security.PublicKey;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;

/** Fresh signed native preparation responses, verified only against bundled trusted keys.
 * Expected scope/challenge and OS readings must come from native state, never the response.
 * Verification does not unlock staff, enable checkout, or permit resetting an existing clock.
 */
public final class NativeHandoff {
    public static final long MAX_ROUND_TRIP_MS = 30_000L;
    private static final int MAX_ENVELOPE_CHARS = 16_384;
    private NativeHandoff() {}

    public static final class Scope {
        public final String actorId,organizationId,branchId,deviceId;
        public Scope(String actorId,String organizationId,String branchId,String deviceId) {
            this.actorId=uuid(actorId);this.organizationId=uuid(organizationId);
            this.branchId=uuid(branchId);this.deviceId=uuid(deviceId);
        }
    }
    public static final class Context {
        public final String actorId,organizationId,branchId,deviceId,shiftId;
        public final long freshTimeMs;
        private Context(Scope scope,String shift,long fresh) {
            actorId=scope.actorId;organizationId=scope.organizationId;branchId=scope.branchId;
            deviceId=scope.deviceId;shiftId=shift;freshTimeMs=fresh;
        }
    }
    public static final class Prepared {
        public final String authorityId,snapshotSha256,authoritySha256;
        public final long freshTimeMs;
        private Prepared(OfflineBundle bundle,long fresh) {
            authorityId=bundle.authorityId;snapshotSha256=bundle.snapshotSha256;
            authoritySha256=bundle.authoritySha256;freshTimeMs=fresh;
        }
    }

    /** Historical handoff is deliberately a different type from an issuance preparation. */
    public static final class Recovered {
        public final String authorityId,snapshotSha256,authoritySha256;
        public final long freshTimeMs;
        private Recovered(OfflineBundle bundle,long fresh) {
            authorityId=bundle.authorityId;snapshotSha256=bundle.snapshotSha256;
            authoritySha256=bundle.authoritySha256;freshTimeMs=fresh;
        }
    }

    public static Context verifyContext(String envelope,Map<String,PublicKey> pinnedKeys,
            String challenge,Scope expected,OfflineClock.Reading before,OfflineClock.Reading after) throws Exception {
        if(expected==null)throw invalid();
        JSONObject value=payload(envelope,pinnedKeys);
        fields(value,"kind","schemaVersion","challenge","serverTimeMs","actorId","organizationId","branchId","deviceId","shiftId");
        literal(value,"kind","native-offline-context");integer(value,"schemaVersion",1,1);
        matchScope(value,expected);
        Object shift=value.get("shiftId");String shiftId=shift==JSONObject.NULL?null:uuid(shift);
        return new Context(expected,shiftId,freshTime(value,challenge,before,after));
    }

    public static Prepared verifyPrepared(String envelope,Map<String,PublicKey> pinnedKeys,
            String challenge,OfflineBundle.Binding expected,String expectedAuthorityId,OfflineBundle bundle,
            OfflineClock.Reading before,OfflineClock.Reading after) throws Exception {
        if(expected==null||bundle==null)throw invalid();uuid(expectedAuthorityId);
        JSONObject value=payload(envelope,pinnedKeys);
        fields(value,"kind","schemaVersion","challenge","serverTimeMs","actorId","organizationId","branchId","deviceId","shiftId","keyEpoch","deviceKeySha256","authorityId","snapshotSha256","authoritySha256");
        literal(value,"kind","native-offline-prepared");integer(value,"schemaVersion",1,1);
        matchBundle(value,expected,expectedAuthorityId,bundle);
        return new Prepared(bundle,freshTime(value,challenge,before,after));
    }

    public static Recovered verifyRecovered(String envelope,Map<String,PublicKey> pinnedKeys,
            String challenge,OfflineBundle.Binding expected,String expectedAuthorityId,OfflineBundle bundle,
            OfflineClock.Reading before,OfflineClock.Reading after) throws Exception {
        if(expected==null||bundle==null)throw invalid();uuid(expectedAuthorityId);
        JSONObject value=payload(envelope,pinnedKeys);
        fields(value,"kind","schemaVersion","purpose","challenge","serverTimeMs","actorId","organizationId","branchId","deviceId","shiftId","keyEpoch","deviceKeySha256","authorityId","snapshotSha256","authoritySha256");
        literal(value,"kind","native-offline-recovered");literal(value,"purpose","reconciliation-only");integer(value,"schemaVersion",1,1);
        matchBundle(value,expected,expectedAuthorityId,bundle);
        return new Recovered(bundle,freshTime(value,challenge,before,after));
    }
    private static void matchBundle(JSONObject value,OfflineBundle.Binding expected,String expectedAuthorityId,OfflineBundle bundle)throws Exception {
        Scope scope=new Scope(expected.actorId,expected.organizationId,expected.branchId,expected.deviceId);
        matchScope(value,scope);
        equal(uuid(value.get("shiftId")),expected.shiftId);equal(uuid(value.get("keyEpoch")),expected.keyEpoch);
        equal(hash(value.get("deviceKeySha256")),expected.deviceKeySha256);
        equal(uuid(value.get("authorityId")),expectedAuthorityId);equal(bundle.authorityId,expectedAuthorityId);
        equal(bundle.actorId,expected.actorId);equal(bundle.organizationId,expected.organizationId);
        equal(bundle.branchId,expected.branchId);equal(bundle.deviceId,expected.deviceId);
        equal(bundle.shiftId,expected.shiftId);equal(bundle.keyEpoch,expected.keyEpoch);equal(bundle.deviceKeySha256,expected.deviceKeySha256);
        equal(hash(value.get("snapshotSha256")),bundle.snapshotSha256);
        equal(hash(value.get("authoritySha256")),bundle.authoritySha256);
    }

    private static JSONObject payload(String envelope,Map<String,PublicKey> pinnedKeys) throws Exception {
        if(envelope==null||envelope.length()>MAX_ENVELOPE_CHARS||pinnedKeys==null||pinnedKeys.isEmpty())throw invalid();
        // No key from an envelope or network response is ever added to this trust set.
        Map<String,PublicKey> keys=Collections.unmodifiableMap(new HashMap<>(pinnedKeys));
        Object value=SignedProtocol.verify(envelope,keys).payload();
        if(!(value instanceof JSONObject))throw invalid();return (JSONObject)value;
    }
    private static long freshTime(JSONObject value,String expectedChallenge,OfflineClock.Reading before,OfflineClock.Reading after) throws Exception {
        equal(hash(value.get("challenge")),hash(expectedChallenge));
        if(before==null||after==null||!before.bootId.equals(after.bootId)||after.elapsedRealtimeMs<before.elapsedRealtimeMs||after.wallTimeMs<before.wallTimeMs)throw invalid();
        long elapsed=after.elapsedRealtimeMs-before.elapsedRealtimeMs;
        if(elapsed>MAX_ROUND_TRIP_MS)throw invalid();
        long server=integer(value,"serverTimeMs",0,OfflineClock.MAX_TIME_MS);
        if(server>OfflineClock.MAX_TIME_MS-elapsed)throw invalid();
        // Add the entire request round trip. Network asymmetry may overestimate, never
        // subtract elapsed time from a fresh server observation or extend grant validity.
        return server+elapsed;
    }
    private static void matchScope(JSONObject value,Scope expected) throws Exception {
        equal(uuid(value.get("actorId")),expected.actorId);equal(uuid(value.get("organizationId")),expected.organizationId);
        equal(uuid(value.get("branchId")),expected.branchId);equal(uuid(value.get("deviceId")),expected.deviceId);
    }
    private static void fields(JSONObject value,String... names) {
        if(value.length()!=names.length)throw invalid();for(String name:names)if(!value.has(name))throw invalid();
    }
    private static void literal(JSONObject value,String key,String expected) throws Exception {equal(value.get(key),expected);}
    private static void equal(Object actual,Object expected) {if(expected==null||!expected.equals(actual))throw invalid();}
    private static String uuid(Object value) {
        if(!(value instanceof String)||!((String)value).matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();return (String)value;
    }
    private static String hash(Object value) {if(!(value instanceof String)||!((String)value).matches("[0-9a-f]{64}"))throw invalid();return (String)value;}
    private static long integer(JSONObject value,String key,long min,long max) throws Exception {
        Object n=value.get(key);if(!(n instanceof Long)||((Long)n)<min||((Long)n)>max)throw invalid();return (Long)n;
    }
    private static IllegalArgumentException invalid(){return new IllegalArgumentException("invalid_native_handoff");}
}
