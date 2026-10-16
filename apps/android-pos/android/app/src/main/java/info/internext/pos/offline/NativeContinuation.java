package info.internext.pos.offline;

import java.security.PublicKey;
import java.util.Map;
import org.json.JSONObject;

/** A scoped preparation transition, never a selling grant or a clock-reset authorization. */
public final class NativeContinuation {
    private NativeContinuation() {}
    public static final class Verified {
        public final String nextShiftId,payloadSha256;
        private Verified(String shift,String hash){nextShiftId=shift;payloadSha256=hash;}
    }
    public static Verified verify(String envelope,Map<String,PublicKey> keys,String challenge,
            OfflineBundle.Binding expected,String priorAuthorityId,String sealSha256,
            OfflineClock.Reading before,OfflineClock.Reading after)throws Exception {
        if(envelope==null||envelope.length()>16384||expected==null||keys==null||keys.isEmpty())throw invalid();
        SignedProtocol.Verified signed=SignedProtocol.verify(envelope,keys);JSONObject v=(JSONObject)signed.payload();
        fields(v,"kind","schemaVersion","purpose","challenge","serverTimeMs","organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","deviceKeySha256","priorAuthorityId","sealSha256","nextShiftId");
        equal(v.get("kind"),"native-offline-continuation");equal(v.get("purpose"),"prepare-next");number(v,"schemaVersion",1,1);
        equal(hash(v.get("challenge")),hash(challenge));equal(uuid(v.get("priorAuthorityId")),uuid(priorAuthorityId));equal(hash(v.get("sealSha256")),hash(sealSha256));
        equal(uuid(v.get("organizationId")),expected.organizationId);equal(uuid(v.get("branchId")),expected.branchId);equal(uuid(v.get("deviceId")),expected.deviceId);
        equal(uuid(v.get("actorId")),expected.actorId);equal(uuid(v.get("shiftId")),expected.shiftId);equal(uuid(v.get("keyEpoch")),expected.keyEpoch);equal(hash(v.get("deviceKeySha256")),expected.deviceKeySha256);
        String next=v.get("nextShiftId")==JSONObject.NULL?null:uuid(v.get("nextShiftId"));if(next!=null&&!next.equals(expected.shiftId))throw invalid();
        if(before==null||after==null||!before.bootId.equals(after.bootId)||after.elapsedRealtimeMs<before.elapsedRealtimeMs||after.wallTimeMs<before.wallTimeMs)throw invalid();
        long elapsed=after.elapsedRealtimeMs-before.elapsedRealtimeMs;if(elapsed>NativeHandoff.MAX_ROUND_TRIP_MS)throw invalid();
        long server=number(v,"serverTimeMs",0,OfflineClock.MAX_TIME_MS);if(server>OfflineClock.MAX_TIME_MS-elapsed)throw invalid();
        return new Verified(next,signed.payloadSha256);
    }
    private static void fields(JSONObject v,String...names){if(v.length()!=names.length)throw invalid();for(String name:names)if(!v.has(name))throw invalid();}
    private static void equal(Object actual,Object expected){if(expected==null||!expected.equals(actual))throw invalid();}
    private static String uuid(Object v){if(!(v instanceof String)||!((String)v).matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();return (String)v;}
    private static String hash(Object v){if(!(v instanceof String)||!((String)v).matches("[0-9a-f]{64}"))throw invalid();return (String)v;}
    private static long number(JSONObject v,String key,long min,long max)throws Exception{Object n=v.get(key);if(!(n instanceof Long)||((Long)n)<min||((Long)n)>max)throw invalid();return (Long)n;}
    private static IllegalStateException invalid(){return new IllegalStateException("offline_context_changed");}
}
