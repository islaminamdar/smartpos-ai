package info.internext.pos.offline;

import java.security.PublicKey;
import java.util.Map;
import org.json.JSONObject;

/** A replacement OS-clock baseline, never authorization to reuse a selling allocation. */
public final class NativeClockRecoveryProof {
    private NativeClockRecoveryProof(){}
    public static final String[] CORE={"requestId","installationId","organizationId","branchId","deviceId","actorId","keyEpoch","deviceKeySha256","oldClockGeneration","oldClockSha256","retirementSha256"};
    public static JSONObject request(String envelope,Map<String,PublicKey> deviceKeys)throws Exception{
        JSONObject p=decoded(envelope,deviceKeys);fields(p,CORE,"kind","schemaVersion");kind(p,"native-clock-recovery");core(p);
        equal(new JSONObject(envelope).get("keyId"),p.get("deviceKeySha256"));return p;
    }
    public static JSONObject approval(String envelope,Map<String,PublicKey> serverKeys,JSONObject request,String proofHash)throws Exception{
        JSONObject p=decoded(envelope,serverKeys);fields(p,CORE,"kind","schemaVersion","proofSha256","approvedAt");kind(p,"native-clock-recovery-approval");core(p);
        for(String k:CORE)if(k.equals("oldClockGeneration")){if(p.getLong(k)!=request.getLong(k))throw invalid();}else equal(p.get(k),request.get(k));equal(hash(p.get("proofSha256")),hash(proofHash));NativePinRecoveryProof.time(p.get("approvedAt"));return p;
    }
    public static long time(String envelope,Map<String,PublicKey> keys,JSONObject request,String approvalHash,String challenge)throws Exception{
        JSONObject p=decoded(envelope,keys);fields(p,new String[]{"kind","schemaVersion","requestId","approvalSha256","retirementSha256","oldClockGeneration","challenge","serverTimeMs"});kind(p,"native-clock-recovery-time");
        for(String k:new String[]{"requestId","retirementSha256"})equal(p.get(k),request.get(k));if(integer(p.get("oldClockGeneration"),9_007_199_254_740_991L)!=request.getLong("oldClockGeneration"))throw invalid();
        equal(hash(p.get("approvalSha256")),hash(approvalHash));equal(hash(p.get("challenge")),hash(challenge));return integer(p.get("serverTimeMs"),OfflineClock.MAX_TIME_MS);
    }
    public static JSONObject core(JSONObject p)throws Exception{
        JSONObject result=new JSONObject();for(String k:CORE){Object v=p.get(k);if(k.equals("oldClockGeneration"))integer(v,9_007_199_254_740_991L);else if(k.endsWith("Sha256"))hash(v);else uuid(v);result.put(k,v);}return result;
    }
    public static String payloadHash(String envelope)throws Exception{return NativePinRecoveryProof.payloadHash(envelope);}
    private static JSONObject decoded(String envelope,Map<String,PublicKey> keys)throws Exception{
        if(envelope==null||envelope.length()>16384||keys==null||keys.isEmpty())throw invalid();Object p=SignedProtocol.verify(envelope,keys).payload();if(!(p instanceof JSONObject))throw invalid();return(JSONObject)p;
    }
    private static void kind(JSONObject p,String kind)throws Exception{equal(p.get("kind"),kind);if(integer(p.get("schemaVersion"),1)!=1)throw invalid();}
    private static void fields(JSONObject p,String[] first,String...rest){if(p.length()!=first.length+rest.length)throw invalid();for(String k:first)if(!p.has(k))throw invalid();for(String k:rest)if(!p.has(k))throw invalid();}
    private static long integer(Object n,long max){if(!(n instanceof Integer)&&!(n instanceof Long))throw invalid();long v=((Number)n).longValue();if(v<0||v>max)throw invalid();return v;}
    private static String hash(Object v){if(!(v instanceof String)||!((String)v).matches("[a-f0-9]{64}"))throw invalid();return(String)v;}
    private static void uuid(Object v){if(!(v instanceof String)||!((String)v).matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw invalid();}
    private static void equal(Object a,Object b){if(a==null||!a.equals(b))throw invalid();}
    private static IllegalStateException invalid(){return new IllegalStateException("clock_recovery_invalid");}
}
