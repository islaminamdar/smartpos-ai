package info.internext.pos.offline;

import org.json.JSONObject;
import java.security.PublicKey;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/** Historical reconciliation only. No result is an invoice, ACK, clock anchor or sale permission.
 * The caller must first verify the original device freeze and recalculate its immutable request. */
public final class PaymentResolution {
    private PaymentResolution() {}
    public static final class Verified {
        public final String state, resolutionSha256;
        private final byte[] resolution;
        private Verified(String state,String hash,JSONObject result)throws Exception {
            this.state=state;this.resolutionSha256=hash;
            this.resolution=result==null?null:CanonicalJson.bytes(result);
        }
        public JSONObject resolution()throws Exception {
            return resolution==null?null:(JSONObject)CanonicalJson.parse(resolution.clone());
        }
    }
    public static Verified verify(JSONObject response,String challenge,JSONObject freeze,String freezeSha256,
                                  Map<String,PublicKey> serverKeys)throws Exception {
        fields(response,"handoff","resolutionEnvelope","receipt","acknowledgement");hash(challenge);hash(freezeSha256);
        SignedProtocol.Verified status=SignedProtocol.verify(object(response.get("handoff")).toString(),serverKeys);
        JSONObject h=object(status.payload());
        fields(h,"kind","schemaVersion","purpose","challenge","serverTimeMs","authorityId","keyEpoch","deviceId","freezeId","freezeSha256","state","resolutionSha256","issuanceSha256");
        equal(h,"kind","native-payment-resolution-status");equal(h,"purpose","reconciliation-only");integer(h,"schemaVersion",1,1);
        integer(h,"serverTimeMs",0,253402300799999L);equal(h,"challenge",challenge);
        for(String key:new String[]{"authorityId","keyEpoch","deviceId","freezeId"}){uuid(string(h,key));equal(h,key,string(freeze,key));}
        equal(h,"freezeSha256",freezeSha256);
        String state=string(h,"state");
        if("resolved".equals(state)){
            hash(string(h,"resolutionSha256"));nil(h,"issuanceSha256");nil(response,"receipt");nil(response,"acknowledgement");
            SignedProtocol.Verified signed=SignedProtocol.verify(object(response.get("resolutionEnvelope")).toString(),serverKeys);
            if(!signed.payloadSha256.equals(h.getString("resolutionSha256")))throw invalid();
            JSONObject r=object(signed.payload());
            fields(r,"kind","schemaVersion","purpose","resolutionId","requestId","freezeId","freezeSha256","paymentIntentId","requestSha256","orderId","documentId","organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","authorityId","authoritySha256","snapshotSha256","managerActorId","decision","evidenceSha256","resolvedAt","replacement");
            equal(r,"kind","offline-payment-resolution");equal(r,"purpose","reconciliation-only");integer(r,"schemaVersion",1,1);nil(r,"replacement");
            for(String key:new String[]{"resolutionId","requestId","managerActorId"})uuid(string(r,key));
            for(String key:new String[]{"freezeId","paymentIntentId","orderId","documentId","organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","authorityId"}){uuid(string(r,key));equal(r,key,string(freeze,key));}
            for(String key:new String[]{"requestSha256","authoritySha256","snapshotSha256"}){hash(string(r,key));equal(r,key,string(freeze,key));}
            equal(r,"freezeSha256",freezeSha256);hash(string(r,"evidenceSha256"));long resolvedAt=timestamp(string(r,"resolvedAt"));
            if(resolvedAt>h.getLong("serverTimeMs"))throw invalid();
            String decision=string(r,"decision");
            if(!"funds_returned".equals(decision)&&!"payment_voided".equals(decision))throw invalid();
            JSONObject request=freeze.getJSONObject("request");
            if(!request.isNull("customer")){
                JSONObject buyer=request.getJSONObject("customer");
                if(buyer.getString("name").indexOf('\0')>=0||buyer.getString("address").indexOf('\0')>=0)throw invalid();
            }
            if("payment_voided".equals(decision)&&request.getLong("recordedCardFils")!=request.getLong("presentedTotalFils"))throw invalid();
            return new Verified(state,signed.payloadSha256,r);
        }
        nil(response,"resolutionEnvelope");nil(h,"resolutionSha256");
        if("pending".equals(state)||"conflict".equals(state)){
            nil(h,"issuanceSha256");nil(response,"receipt");nil(response,"acknowledgement");
        }else if("already_issued".equals(state)){
            hash(string(h,"issuanceSha256"));JSONObject receipt=object(response.get("receipt"));
            // This is contradictory custody, never an instruction to create a receipt or ACK locally.
            equal(receipt,"id",string(freeze,"documentId"));equal(receipt,"orderId",string(freeze,"orderId"));
            for(String key:new String[]{"branchId","deviceId","actorId","shiftId"})equal(receipt,key,string(freeze,key));
            JSONObject ack=object(SignedProtocol.verify(object(response.get("acknowledgement")).toString(),serverKeys).payload());
            fields(ack,"kind","schemaVersion","id","issuanceId","payloadSha256","authorityId","keyEpoch","deviceSequence","receivedAt");
            equal(ack,"kind","offline-ack");integer(ack,"schemaVersion",1,1);uuid(string(ack,"id"));
            equal(ack,"issuanceId",string(freeze,"orderId"));equal(ack,"payloadSha256",string(h,"issuanceSha256"));
            equal(ack,"authorityId",string(freeze,"authorityId"));equal(ack,"keyEpoch",string(freeze,"keyEpoch"));
            integer(ack,"deviceSequence",1,9007199254740991L);timestamp(string(ack,"receivedAt"));
        }else throw invalid();
        return new Verified(state,null,null);
    }
    private static long timestamp(String text)throws Exception {
        if(!text.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z"))throw invalid();
        SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.ROOT);f.setTimeZone(TimeZone.getTimeZone("UTC"));f.setLenient(false);
        long time=f.parse(text).getTime();if(time<0||time>253402300799999L||!f.format(new java.util.Date(time)).equals(text))throw invalid();return time;
    }
    private static JSONObject object(Object v){if(!(v instanceof JSONObject))throw invalid();return (JSONObject)v;}
    private static void fields(JSONObject o,String...keys){if(o.length()!=keys.length)throw invalid();for(String key:keys)if(!o.has(key))throw invalid();}
    private static String string(JSONObject o,String key)throws Exception{Object v=o.get(key);if(!(v instanceof String))throw invalid();return (String)v;}
    private static void equal(JSONObject o,String key,String expected)throws Exception{if(!expected.equals(string(o,key)))throw invalid();}
    private static void nil(JSONObject o,String key)throws Exception{if(o.get(key)!=JSONObject.NULL)throw invalid();}
    private static long integer(JSONObject o,String key,long min,long max)throws Exception{Object n=o.get(key);if(!(n instanceof Long)&&!(n instanceof Integer))throw invalid();long v=((Number)n).longValue();if(v<min||v>max)throw invalid();return v;}
    private static void hash(String value){if(value==null||!value.matches("[a-f0-9]{64}"))throw invalid();}
    private static void uuid(String value){if(!value.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw invalid();}
    private static IllegalStateException invalid(){return new IllegalStateException("payment_resolution_invalid");}
}
