package info.internext.pos.offline;

import java.security.PublicKey;
import java.util.Map;
import org.json.JSONObject;

/** Signed time only. The native caller must independently prove pristine custody. */
public final class NativeClockBootstrapTime {
    private NativeClockBootstrapTime() {}
    private static final String[] FIELDS={"schemaVersion","installationId","deviceKeySha256","oldClockGeneration","oldClockSha256","challenge"};
    public static void request(JSONObject p)throws Exception {
        if(p==null||p.length()!=FIELDS.length)throw invalid();
        for(String k:FIELDS)if(!p.has(k))throw invalid();
        if(integer(p.get("schemaVersion"),1)!=1)throw invalid();
        if(!(p.get("installationId") instanceof String)||!p.getString("installationId").matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw invalid();
        integer(p.get("oldClockGeneration"),9_007_199_254_740_990L);
        for(String k:new String[]{"deviceKeySha256","oldClockSha256","challenge"})if(!(p.get(k) instanceof String)||!p.getString(k).matches("[a-f0-9]{64}"))throw invalid();
    }
    public static long verify(String envelope,Map<String,PublicKey> keys,JSONObject request)throws Exception {
        request(request);if(envelope==null||envelope.length()>16384||keys==null||keys.isEmpty())throw invalid();
        Object decoded=SignedProtocol.verify(envelope,keys).payload();if(!(decoded instanceof JSONObject))throw invalid();JSONObject p=(JSONObject)decoded;
        if(p.length()!=FIELDS.length+2||!"native-clock-bootstrap-time".equals(p.opt("kind")))throw invalid();
        JSONObject echo=new JSONObject();for(String k:FIELDS){echo.put(k,p.get(k));if(k.equals("schemaVersion")||k.equals("oldClockGeneration")){if(integer(p.get(k),9_007_199_254_740_990L)!=request.getLong(k))throw invalid();}else if(!p.get(k).equals(request.get(k)))throw invalid();}
        request(echo);return integer(p.get("serverTimeMs"),OfflineClock.MAX_TIME_MS);
    }
    private static long integer(Object value,long max){if(!(value instanceof Integer)&&!(value instanceof Long))throw invalid();long n=((Number)value).longValue();if(n<0||n>max)throw invalid();return n;}
    private static IllegalStateException invalid(){return new IllegalStateException("clock_bootstrap_uncertain");}
}
