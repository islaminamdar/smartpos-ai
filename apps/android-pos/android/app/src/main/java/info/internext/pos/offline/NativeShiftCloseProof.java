package info.internext.pos.offline;

import java.security.PublicKey;
import java.util.Arrays;
import java.util.Map;
import org.json.JSONObject;

/** Pinned-server drawer attestations; no sale, grant, cancellation or PIN authorization. */
public final class NativeShiftCloseProof {
    private NativeShiftCloseProof(){}
    public static JSONObject context(String envelope,Map<String,PublicKey> keys,String nonce,JSONObject scope,OfflineClock.Reading before,OfflineClock.Reading after)throws Exception{
        JSONObject p=base(envelope,keys,nonce,scope,before,after);
        fields(p,"kind","purpose","schemaVersion","challenge","serverTimeMs","actorId","organizationId","branchId","deviceId","shiftId","status","canClose","reasonCode");
        equal(p.get("kind"),"native-shift-close-context");String status=string(p,"status");if(!(p.get("canClose") instanceof Boolean))throw invalid();
        Object reason=p.get("reasonCode");if(reason!=JSONObject.NULL&&(!(reason instanceof String)||!Arrays.asList("offline_allocation_active","payment_reconciliation_required","offline_upload_required","shift_close_unavailable","shift_already_closed").contains(reason)))throw invalid();
        if("closed".equals(status)){if(p.getBoolean("canClose")||!"shift_already_closed".equals(reason))throw invalid();}
        else if(!"open".equals(status)||(p.getBoolean("canClose")!=(reason==JSONObject.NULL)))throw invalid();
        return p;
    }
    public static JSONObject result(String envelope,Map<String,PublicKey> keys,String nonce,JSONObject scope,JSONObject command,OfflineClock.Reading before,OfflineClock.Reading after)throws Exception{
        command(command);JSONObject p=base(envelope,keys,nonce,scope,before,after);
        fields(p,"kind","purpose","schemaVersion","challenge","serverTimeMs","actorId","organizationId","branchId","deviceId","shiftId","commandId","requestSha256","countedCashFils","status","result");
        equal(p.get("kind"),"native-shift-close-result");equal(uuid(p.get("commandId")),command.get("id"));equal(hash(p.get("requestSha256")),SignedProtocol.hash(CanonicalJson.bytes(command)));equal(uuid(p.get("shiftId")),command.get("shiftId"));
        long counted=integer(p,"countedCashFils",0,100000000);if(counted!=integer(command,"countedCashFils",0,100000000))throw invalid();
        String status=string(p,"status");if(!Arrays.asList("applied","not_found","cancelled").contains(status))throw invalid();
        if(!"applied".equals(status)){if(p.get("result")!=JSONObject.NULL)throw invalid();return p;}
        if(!(p.get("result") instanceof JSONObject))throw invalid();JSONObject r=p.getJSONObject("result");fields(r,"commandId","shiftId","countedCashFils","expectedCashFils","cashDifferenceFils","closedAt");
        equal(uuid(r.get("commandId")),command.get("id"));equal(uuid(r.get("shiftId")),command.get("shiftId"));if(integer(r,"countedCashFils",0,100000000)!=counted)throw invalid();
        long expected=integer(r,"expectedCashFils",-9007199254740991L,9007199254740991L),difference=integer(r,"cashDifferenceFils",-9007199254740991L,9007199254740991L);
        if(Math.subtractExact(counted,expected)!=difference)throw invalid();String closed=string(r,"closedAt");
        if(!closed.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z"))throw invalid();
        long stamp=java.time.Instant.parse(closed).toEpochMilli();if(stamp<0||stamp>integer(p,"serverTimeMs",0,OfflineClock.MAX_TIME_MS)||!java.time.Instant.ofEpochMilli(stamp).toString().equals(closed)&&!java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC).format(java.time.Instant.ofEpochMilli(stamp)).equals(closed))throw invalid();
        return p;
    }
    public static void command(JSONObject c)throws Exception{
        fields(c,"id","type","branchId","deviceId","shiftId","countedCashFils");equal(c.get("type"),"shift.close");for(String key:new String[]{"id","branchId","deviceId","shiftId"})uuid(c.get(key));integer(c,"countedCashFils",0,100000000);
    }
    private static JSONObject base(String envelope,Map<String,PublicKey> keys,String nonce,JSONObject scope,OfflineClock.Reading before,OfflineClock.Reading after)throws Exception{
        if(envelope==null||envelope.length()>16384||keys==null||keys.isEmpty())throw invalid();Object decoded=SignedProtocol.verify(envelope,keys).payload();if(!(decoded instanceof JSONObject))throw invalid();JSONObject p=(JSONObject)decoded;
        equal(p.get("purpose"),"close-shift");integer(p,"schemaVersion",1,1);equal(hash(p.get("challenge")),hash(nonce));
        for(String name:new String[]{"actorId","organizationId","branchId","deviceId","shiftId"})equal(uuid(p.get(name)),uuid(scope.get(name)));
        if(before==null||after==null||!before.bootId.equals(after.bootId)||after.wallTimeMs<before.wallTimeMs||after.elapsedRealtimeMs<before.elapsedRealtimeMs||after.elapsedRealtimeMs-before.elapsedRealtimeMs>30000)throw invalid();
        long server=integer(p,"serverTimeMs",0,OfflineClock.MAX_TIME_MS);if(server>OfflineClock.MAX_TIME_MS-(after.elapsedRealtimeMs-before.elapsedRealtimeMs))throw invalid();return p;
    }
    public static long integer(JSONObject o,String k,long min,long max)throws Exception{Object n=o.get(k);if(!(n instanceof Integer)&&!(n instanceof Long))throw invalid();long v=((Number)n).longValue();if(v<min||v>max)throw invalid();return v;}
    private static String string(JSONObject o,String key)throws Exception{Object v=o.get(key);if(!(v instanceof String))throw invalid();return (String)v;}
    private static String uuid(Object o){if(!(o instanceof String)||!((String)o).matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();return (String)o;}
    private static String hash(Object o){if(!(o instanceof String)||!((String)o).matches("[0-9a-f]{64}"))throw invalid();return (String)o;}
    private static void fields(JSONObject o,String...keys){if(o.length()!=keys.length)throw invalid();for(String k:keys)if(!o.has(k))throw invalid();}
    private static void equal(Object a,Object b){if(a==null||!a.equals(b))throw invalid();}
    private static IllegalStateException invalid(){return new IllegalStateException("offline_context_changed");}
}
