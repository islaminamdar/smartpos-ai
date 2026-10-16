package info.internext.pos.offline;

import java.security.PublicKey;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import org.json.JSONObject;

/** Original credential-generation replacement only. Never a clock, sale or grant authorization. */
public final class NativePinRecoveryProof {
    private NativePinRecoveryProof(){}
    public static final String[] CORE={"requestId","organizationId","branchId","deviceId","actorId","keyEpoch","deviceKeySha256","oldCredentialSha256","newCredentialSha256"};
    public static JSONObject request(String envelope,Map<String,PublicKey> deviceKeys)throws Exception{
        JSONObject p=decoded(envelope,deviceKeys);fields(p,"kind","schemaVersion","requestId","organizationId","branchId","deviceId","actorId","keyEpoch","deviceKeySha256","oldCredentialSha256","newCredentialSha256","signedAt");
        equal(p.get("kind"),"native-pin-recovery");version(p);core(p);time(p.get("signedAt"));
        if(!new JSONObject(envelope).getString("keyId").equals(p.getString("deviceKeySha256")))throw invalid();return p;
    }
    public static JSONObject approval(String envelope,Map<String,PublicKey> serverKeys,JSONObject request,String proofSha256)throws Exception{
        JSONObject p=decoded(envelope,serverKeys);fields(p,"kind","schemaVersion","requestId","organizationId","branchId","deviceId","actorId","keyEpoch","deviceKeySha256","oldCredentialSha256","newCredentialSha256","proofSha256","approvedAt");
        equal(p.get("kind"),"native-pin-recovery-approval");version(p);core(p);
        for(String field:CORE)equal(p.get(field),request.get(field));equal(hash(p.get("proofSha256")),hash(proofSha256));time(p.get("approvedAt"));return p;
    }
    public static JSONObject core(JSONObject p)throws Exception{
        JSONObject result=new JSONObject();for(String field:CORE){Object value=p.get(field);if(field.endsWith("Sha256"))hash(value);else uuid(value);result.put(field,value);}
        if(result.get("oldCredentialSha256").equals(result.get("newCredentialSha256")))throw invalid();return result;
    }
    public static String payloadHash(String envelope)throws Exception{return SignedProtocol.hash(SignedProtocol.decode(new JSONObject(envelope).getString("payloadBase64Url"),1_048_576));}
    private static JSONObject decoded(String envelope,Map<String,PublicKey> keys)throws Exception{
        if(envelope==null||envelope.length()>16384||keys==null||keys.isEmpty())throw invalid();Object p=SignedProtocol.verify(envelope,keys).payload();if(!(p instanceof JSONObject))throw invalid();return(JSONObject)p;
    }
    private static void version(JSONObject p)throws Exception{Object n=p.get("schemaVersion");if(!(n instanceof Integer)&&!(n instanceof Long)||((Number)n).longValue()!=1)throw invalid();}
    public static long time(Object value)throws Exception{
        if(!(value instanceof String)||!((String)value).matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z"))throw invalid();long n=Instant.parse((String)value).toEpochMilli();
        if(n<0||n>OfflineClock.MAX_TIME_MS||!DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC).format(Instant.ofEpochMilli(n)).equals(value))throw invalid();return n;
    }
    private static void fields(JSONObject p,String...keys){if(p.length()!=keys.length)throw invalid();for(String k:keys)if(!p.has(k))throw invalid();}
    private static String hash(Object o){if(!(o instanceof String)||!((String)o).matches("[a-f0-9]{64}"))throw invalid();return(String)o;}
    private static void uuid(Object o){if(!(o instanceof String)||!((String)o).matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw invalid();}
    private static void equal(Object a,Object b){if(a==null||!a.equals(b))throw invalid();}
    private static IllegalStateException invalid(){return new IllegalStateException("pin_recovery_invalid");}
}
