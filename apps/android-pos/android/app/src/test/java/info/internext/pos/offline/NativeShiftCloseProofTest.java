package info.internext.pos.offline;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import static org.junit.Assert.*;

/** Genuine ephemeral P256 keys; no server secrets or real drawer data. */
public class NativeShiftCloseProofTest {
    private KeyPair key;private Map<String,PublicKey> keys;private JSONObject scope,command;
    private final String nonce="ab".repeat(32),boot=UUID.randomUUID().toString();private final long now=1_792_132_200_000L;
    private OfflineClock.Reading before,after;
    private static String id(){return UUID.randomUUID().toString();}
    @Before public void setup()throws Exception{
        KeyPairGenerator gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));key=gen.generateKeyPair();keys=Collections.singletonMap("test-server",key.getPublic());
        scope=new JSONObject().put("actorId",id()).put("organizationId",id()).put("branchId",id()).put("deviceId",id()).put("shiftId",id());
        command=new JSONObject().put("id",id()).put("type","shift.close").put("branchId",scope.get("branchId")).put("deviceId",scope.get("deviceId")).put("shiftId",scope.get("shiftId")).put("countedCashFils",1000);
        before=new OfflineClock.Reading(boot,1000,now);after=new OfflineClock.Reading(boot,1250,now+250);
    }
    private JSONObject base(String kind)throws Exception{return new JSONObject(scope.toString()).put("kind",kind).put("purpose","close-shift").put("schemaVersion",1).put("challenge",nonce).put("serverTimeMs",now);}
    private JSONObject context()throws Exception{return base("native-shift-close-context").put("status","open").put("canClose",true).put("reasonCode",JSONObject.NULL);}
    private JSONObject result(String status)throws Exception{
        JSONObject p=base("native-shift-close-result").put("commandId",command.get("id")).put("requestSha256",SignedProtocol.hash(CanonicalJson.bytes(command))).put("countedCashFils",1000).put("status",status).put("result",JSONObject.NULL);
        if(status.equals("applied"))p.put("result",new JSONObject().put("commandId",command.get("id")).put("shiftId",command.get("shiftId")).put("countedCashFils",1000).put("expectedCashFils",1200).put("cashDifferenceFils",-200).put("closedAt","2026-10-16T06:29:59.000Z"));return p;
    }
    private String sign(JSONObject p)throws Exception{return SignedProtocol.sign(p,"test-server",key.getPrivate(),key.getPublic());}
    private JSONObject context(JSONObject p)throws Exception{return NativeShiftCloseProof.context(sign(p),keys,nonce,scope,before,after);}
    private JSONObject result(JSONObject p)throws Exception{return NativeShiftCloseProof.result(sign(p),keys,nonce,scope,command,before,after);}
    @Test public void acceptsScopedContextsAndExactFinancialOutcomeWithSignedDifference()throws Exception{
        assertTrue(context(context()).getBoolean("canClose"));assertFalse(context(context().put("status","closed").put("canClose",false).put("reasonCode","shift_already_closed")).getBoolean("canClose"));
        assertEquals(-200,result(result("applied")).getJSONObject("result").getLong("cashDifferenceFils"));assertTrue(result(result("not_found")).isNull("result"));assertTrue(result(result("cancelled")).isNull("result"));
    }
    @Test public void unknownFieldPurposeAndStatusCannotAuthorizeClosure()throws Exception{
        assertThrows(Exception.class,()->context(context().put("extra",true)));assertThrows(Exception.class,()->context(context().put("canClose",false)));assertThrows(Exception.class,()->context(context().put("status","closed")));assertThrows(Exception.class,()->context(context().put("reasonCode","unsafe-raw-server-error")));
        assertThrows(Exception.class,()->result(result("applied").put("purpose","prepare-next")));assertThrows(Exception.class,()->result(result("not_found").put("status","synced")));
        JSONObject missing=result("applied");missing.remove("requestSha256");assertThrows(Exception.class,()->result(missing));
    }
    @Test public void everyIdentityRequestHashAndCountBindsOriginalRequest()throws Exception{
        for(String field:new String[]{"actorId","organizationId","branchId","deviceId","shiftId","commandId"})assertThrows(field,Exception.class,()->result(result("applied").put(field,id())));
        assertThrows(Exception.class,()->result(result("applied").put("requestSha256","cd".repeat(32))));assertThrows(Exception.class,()->result(result("applied").put("countedCashFils",1001)));
        JSONObject changed=new JSONObject(command.toString()).put("countedCashFils",1001);String signed=sign(result("applied"));assertThrows(Exception.class,()->NativeShiftCloseProof.result(signed,keys,nonce,scope,changed,before,after));
    }
    @Test public void resultRequiresExactIntegerTotalsArithmeticAndStrictDate()throws Exception{
        for(Object bad:new Object[]{1.5,"1000",true,JSONObject.NULL,9007199254740992L}){JSONObject p=result("applied");p.getJSONObject("result").put("expectedCashFils",bad);assertThrows(Exception.class,()->result(p));}
        for(String field:new String[]{"commandId","shiftId"}){JSONObject p=result("applied");p.getJSONObject("result").put(field,id());assertThrows(Exception.class,()->result(p));}
        JSONObject wrong=result("applied");wrong.getJSONObject("result").put("cashDifferenceFils",200);assertThrows(Exception.class,()->result(wrong));
        for(String date:new String[]{"2026-02-30T00:00:00.000Z","2026-10-16T06:29:59Z","9999-12-31T23:59:59.999Z","2026-10-16T06:29:59.000+00:00"}){JSONObject p=result("applied");p.getJSONObject("result").put("closedAt",date);assertThrows(Exception.class,()->result(p));}
        JSONObject notFound=result("not_found").put("result",result("applied").get("result"));assertThrows(Exception.class,()->result(notFound));
    }
    @Test public void rejectsUnknownPinsAlteredPayloadAndResponseSuppliedKeys()throws Exception{
        String raw=sign(result("applied"));assertThrows(Exception.class,()->NativeShiftCloseProof.result(raw,Collections.emptyMap(),nonce,scope,command,before,after));
        JSONObject altered=new JSONObject(raw).put("payloadBase64Url",SignedProtocol.encode(CanonicalJson.bytes(result("cancelled"))));assertThrows(Exception.class,()->NativeShiftCloseProof.result(altered.toString(),keys,nonce,scope,command,before,after));
        assertThrows(Exception.class,()->NativeShiftCloseProof.result(new JSONObject(raw).put("publicKey","not-a-pin").toString(),keys,nonce,scope,command,before,after));
    }
    @Test public void rejectsReplayedNonceRebootRollbackAndResponseDelay()throws Exception{
        String raw=sign(result("applied"));assertThrows(Exception.class,()->NativeShiftCloseProof.result(raw,keys,"ef".repeat(32),scope,command,before,after));
        for(OfflineClock.Reading bad:new OfflineClock.Reading[]{new OfflineClock.Reading(id(),1250,now+250),new OfflineClock.Reading(boot,999,now+250),new OfflineClock.Reading(boot,1250,now-1),new OfflineClock.Reading(boot,31001,now+30001)})assertThrows(Exception.class,()->NativeShiftCloseProof.result(raw,keys,nonce,scope,command,before,bad));
        assertThrows(Exception.class,()->result(result("applied").put("serverTimeMs",OfflineClock.MAX_TIME_MS)));
    }
}
