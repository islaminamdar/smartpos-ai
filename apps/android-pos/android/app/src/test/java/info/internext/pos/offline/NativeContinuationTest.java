package info.internext.pos.offline;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;
import static org.junit.Assert.*;

/** Fresh signed transition evidence grants no invoice authority and never resets a clock. */
public class NativeContinuationTest {
    private KeyPair key;private Map<String,PublicKey> pins;private OfflineBundle.Binding binding;
    private final String nonce="ab".repeat(32),seal="cd".repeat(32),authority=UUID.randomUUID().toString(),boot=UUID.randomUUID().toString();
    private final long now=1_792_132_200_000L;
    private OfflineClock.Reading before,after;
    @Before public void setup()throws Exception{
        KeyPairGenerator g=KeyPairGenerator.getInstance("EC");g.initialize(new ECGenParameterSpec("secp256r1"));key=g.generateKeyPair();pins=Collections.singletonMap("server-test",key.getPublic());
        binding=new OfflineBundle.Binding(id(),id(),id(),id(),id(),id(),"ef".repeat(32));before=new OfflineClock.Reading(boot,1000,now);after=new OfflineClock.Reading(boot,1250,now+250);
    }
    private static String id(){return UUID.randomUUID().toString();}
    private JSONObject payload()throws Exception{return new JSONObject().put("kind","native-offline-continuation").put("schemaVersion",1).put("purpose","prepare-next").put("challenge",nonce).put("serverTimeMs",now).put("organizationId",binding.organizationId).put("branchId",binding.branchId).put("deviceId",binding.deviceId).put("actorId",binding.actorId).put("shiftId",binding.shiftId).put("keyEpoch",binding.keyEpoch).put("deviceKeySha256",binding.deviceKeySha256).put("priorAuthorityId",authority).put("sealSha256",seal).put("nextShiftId",binding.shiftId);}
    private String sign(JSONObject p)throws Exception{return SignedProtocol.sign(p,"server-test",key.getPrivate(),key.getPublic());}
    private NativeContinuation.Verified verify(JSONObject p)throws Exception{return NativeContinuation.verify(sign(p),pins,nonce,binding,authority,seal,before,after);}
    @Test public void permitsOnlySameShiftOrExplicitClosedShift()throws Exception{
        JSONObject p=payload();assertEquals(binding.shiftId,verify(p).nextShiftId);assertEquals(SignedProtocol.hash(CanonicalJson.bytes(p)),verify(p).payloadSha256);
        assertNull(verify(payload().put("nextShiftId",JSONObject.NULL)).nextShiftId);assertThrows(Exception.class,()->verify(payload().put("nextShiftId",id())));
    }
    @Test public void bindsEveryOriginalScopeAndSealIdentity()throws Exception{
        for(String name:new String[]{"organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","priorAuthorityId"})assertThrows(name,Exception.class,()->verify(payload().put(name,id())));
        for(String name:new String[]{"challenge","sealSha256","deviceKeySha256"})assertThrows(name,Exception.class,()->verify(payload().put(name,"01".repeat(32))));
    }
    @Test public void rejectsSignatureTamperingAndUnpinnedKeys()throws Exception{
        String raw=sign(payload());assertThrows(Exception.class,()->NativeContinuation.verify(raw,Collections.emptyMap(),nonce,binding,authority,seal,before,after));
        JSONObject changed=new JSONObject(raw).put("payloadBase64Url",SignedProtocol.encode(CanonicalJson.bytes(payload().put("nextShiftId",JSONObject.NULL))));assertThrows(Exception.class,()->NativeContinuation.verify(changed.toString(),pins,nonce,binding,authority,seal,before,after));
        assertThrows(Exception.class,()->NativeContinuation.verify(new JSONObject(raw).put("publicKey","untrusted").toString(),pins,nonce,binding,authority,seal,before,after));
    }
    @Test public void rejectsUnknownMissingCoercedAndOtherPurposePayloads()throws Exception{
        assertThrows(Exception.class,()->verify(payload().put("extra",true)));JSONObject missing=payload();missing.remove("nextShiftId");assertThrows(Exception.class,()->verify(missing));
        for(Object n:new Object[]{"1",2,JSONObject.NULL,true})assertThrows(Exception.class,()->verify(payload().put("schemaVersion",n)));
        assertThrows(Exception.class,()->verify(payload().put("kind","native-offline-prepared")));assertThrows(Exception.class,()->verify(payload().put("purpose","reconciliation-only")));
        assertThrows(Exception.class,()->verify(payload().put("challenge",nonce.toUpperCase(java.util.Locale.ROOT))));
    }
    @Test public void rejectsRebootRollbackAndOverlongRoundTrip()throws Exception{
        String raw=sign(payload());for(OfflineClock.Reading bad:new OfflineClock.Reading[]{new OfflineClock.Reading(id(),1250,now+250),new OfflineClock.Reading(boot,999,now+250),new OfflineClock.Reading(boot,1250,now-1),new OfflineClock.Reading(boot,31001,now+30001)})assertThrows(Exception.class,()->NativeContinuation.verify(raw,pins,nonce,binding,authority,seal,before,bad));
    }
    @Test public void boundsServerTimestampWithoutIssuanceClockReanchor()throws Exception{
        assertThrows(Exception.class,()->verify(payload().put("serverTimeMs",OfflineClock.MAX_TIME_MS)));assertThrows(Exception.class,()->verify(payload().put("serverTimeMs",-1)));assertThrows(Exception.class,()->verify(payload().put("serverTimeMs","1000")));
        assertNotNull(verify(payload().put("serverTimeMs",OfflineClock.MAX_TIME_MS-250)));assertEquals(now,before.wallTimeMs);assertEquals(1000,before.elapsedRealtimeMs);
    }
}
