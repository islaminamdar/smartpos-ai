package info.internext.pos.offline;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;
import static org.junit.Assert.*;

/** Real P256 signatures, synthetic SQL fixture and no network/server credentials. */
public class NativeHandoffTest {
    private KeyPair signing;private Map<String,PublicKey> pins;private OfflineBundle bundle;
    private OfflineBundle.Binding binding;private NativeHandoff.Scope scope;
    private String nonce="ab".repeat(32),boot=UUID.randomUUID().toString();
    private long now=1_792_132_200_000L;
    private OfflineClock.Reading before,after;
    @Before public void setup()throws Exception{
        KeyPairGenerator gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));signing=gen.generateKeyPair();pins=Collections.singletonMap("synthetic-server",signing.getPublic());
        JSONObject fixture;try(var in=getClass().getResourceAsStream("/pos-offline-output.json")){assertNotNull(in);fixture=new JSONObject(new String(in.readAllBytes(),StandardCharsets.UTF_8)).getJSONObject("bundle");}
        JSONObject snapshot=fixture.getJSONObject("snapshot"),authority=fixture.getJSONObject("authority");
        authority.put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot)));
        binding=new OfflineBundle.Binding(authority.getString("organizationId"),authority.getString("branchId"),authority.getString("deviceId"),authority.getString("actorId"),authority.getString("shiftId"),authority.getString("keyEpoch"),authority.getString("deviceKeySha256"));
        bundle=OfflineBundle.verify(sign(snapshot),sign(authority),pins,binding);
        scope=new NativeHandoff.Scope(binding.actorId,binding.organizationId,binding.branchId,binding.deviceId);
        before=new OfflineClock.Reading(boot,1000,now);after=new OfflineClock.Reading(boot,1250,now+250);
    }
    private String sign(JSONObject value)throws Exception{return SignedProtocol.sign(value,"synthetic-server",signing.getPrivate(),signing.getPublic());}
    private JSONObject context()throws Exception{return new JSONObject().put("kind","native-offline-context").put("schemaVersion",1).put("challenge",nonce).put("serverTimeMs",now).put("actorId",binding.actorId).put("organizationId",binding.organizationId).put("branchId",binding.branchId).put("deviceId",binding.deviceId).put("shiftId",binding.shiftId);}
    private JSONObject prepared()throws Exception{return context().put("kind","native-offline-prepared").put("keyEpoch",binding.keyEpoch).put("deviceKeySha256",binding.deviceKeySha256).put("authorityId",bundle.authorityId).put("snapshotSha256",bundle.snapshotSha256).put("authoritySha256",bundle.authoritySha256);}
    private NativeHandoff.Context context(JSONObject value)throws Exception{return NativeHandoff.verifyContext(sign(value),pins,nonce,scope,before,after);}
    private NativeHandoff.Prepared prepared(JSONObject value)throws Exception{return NativeHandoff.verifyPrepared(sign(value),pins,nonce,binding,bundle.authorityId,bundle,before,after);}
    private JSONObject recovered()throws Exception{return prepared().put("kind","native-offline-recovered").put("purpose","reconciliation-only");}
    private NativeHandoff.Recovered recovered(JSONObject value)throws Exception{return NativeHandoff.verifyRecovered(sign(value),pins,nonce,binding,bundle.authorityId,bundle,before,after);}

    @Test public void signedContextAddsEntireRoundTripAndKeepsIndependentScope()throws Exception{
        NativeHandoff.Context result=context(context());assertEquals(now+250,result.freshTimeMs);
        assertEquals(binding.actorId,result.actorId);assertEquals(binding.organizationId,result.organizationId);assertEquals(binding.branchId,result.branchId);assertEquals(binding.deviceId,result.deviceId);assertEquals(binding.shiftId,result.shiftId);
        assertNull(context(context().put("shiftId",JSONObject.NULL)).shiftId);
    }
    @Test public void preparedBindsBothVerifiedPayloadHashesAndReservationId()throws Exception{
        NativeHandoff.Prepared result=prepared(prepared());assertEquals(now+250,result.freshTimeMs);assertEquals(bundle.authorityId,result.authorityId);assertEquals(bundle.snapshotSha256,result.snapshotSha256);assertEquals(bundle.authoritySha256,result.authoritySha256);
        String envelope=sign(prepared());assertThrows(Exception.class,()->NativeHandoff.verifyPrepared(envelope,pins,nonce,binding,UUID.randomUUID().toString(),bundle,before,after));
        assertThrows(Exception.class,()->NativeHandoff.verifyPrepared(envelope,pins,nonce,binding,bundle.authorityId,null,before,after));
    }
    @Test public void responseCannotSupplyTrustKeyOrChangeAuthenticatedPayload()throws Exception{
        String envelope=sign(context());assertThrows(Exception.class,()->NativeHandoff.verifyContext(envelope,Collections.emptyMap(),nonce,scope,before,after));
        assertThrows(Exception.class,()->NativeHandoff.verifyContext(envelope,null,nonce,scope,before,after));
        KeyPairGenerator gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));PublicKey other=gen.generateKeyPair().getPublic();
        assertThrows(Exception.class,()->NativeHandoff.verifyContext(envelope,Collections.singletonMap("synthetic-server",other),nonce,scope,before,after));
        JSONObject tampered=new JSONObject(envelope).put("payloadBase64Url",SignedProtocol.encode(CanonicalJson.bytes(context().put("serverTimeMs",now-1000))));
        assertThrows(Exception.class,()->NativeHandoff.verifyContext(tampered.toString(),pins,nonce,scope,before,after));
        assertThrows(Exception.class,()->NativeHandoff.verifyContext(new JSONObject(envelope).put("publicKey",SignedProtocol.encode(other.getEncoded())).toString(),pins,nonce,scope,before,after));
    }
    @Test public void rejectsReplayedOrMalformedChallenges()throws Exception{
        String envelope=sign(context());for(String bad:new String[]{"cd".repeat(32),"AB".repeat(32),"a".repeat(63),"",null})
            assertThrows(Exception.class,()->NativeHandoff.verifyContext(envelope,pins,bad,scope,before,after));
        for(Object bad:new Object[]{"AB".repeat(32),"x".repeat(64),12L,JSONObject.NULL}){
            assertThrows(Exception.class,()->context(context().put("challenge",bad)));
            assertThrows(Exception.class,()->prepared(prepared().put("challenge",bad)));
        }
    }
    @Test public void rejectsUnknownMissingAndCoercedSchemaFields()throws Exception{
        assertThrows(Exception.class,()->context(context().put("extra",true)));
        JSONObject missing=context();missing.remove("shiftId");assertThrows(Exception.class,()->context(missing));
        assertThrows(Exception.class,()->prepared(prepared().put("extra",true)));
        JSONObject noHash=prepared();noHash.remove("authoritySha256");assertThrows(Exception.class,()->prepared(noHash));
        for(Object bad:new Object[]{"1",true,JSONObject.NULL,0L,2L}){
            assertThrows(Exception.class,()->context(context().put("schemaVersion",bad)));
            assertThrows(Exception.class,()->prepared(prepared().put("schemaVersion",bad)));
        }
        assertThrows(Exception.class,()->context(context().put("kind","native-offline-prepared")));
        assertThrows(Exception.class,()->prepared(prepared().put("kind","native-offline-context")));
    }
    @Test public void everyScopeIdentityMustMatchIndependentNativeSession()throws Exception{
        for(String field:new String[]{"actorId","organizationId","branchId","deviceId"}){
            assertThrows(Exception.class,()->context(context().put(field,UUID.randomUUID().toString())));
            assertThrows(Exception.class,()->prepared(prepared().put(field,UUID.randomUUID().toString())));
            assertThrows(Exception.class,()->context(context().put(field,JSONObject.NULL)));
        }
        String envelope=sign(context());assertThrows(Exception.class,()->NativeHandoff.verifyContext(envelope,pins,nonce,null,before,after));
        assertThrows(Exception.class,()->new NativeHandoff.Scope("bad",binding.organizationId,binding.branchId,binding.deviceId));
    }
    @Test public void preparedRejectsEveryChangedShiftEpochHashOrAuthority()throws Exception{
        for(String field:new String[]{"shiftId","keyEpoch","authorityId"})assertThrows(Exception.class,()->prepared(prepared().put(field,UUID.randomUUID().toString())));
        for(String field:new String[]{"deviceKeySha256","snapshotSha256","authoritySha256"}){
            assertThrows(Exception.class,()->prepared(prepared().put(field,"f".repeat(64))));
            assertThrows(Exception.class,()->prepared(prepared().put(field,"A".repeat(64))));
            assertThrows(Exception.class,()->prepared(prepared().put(field,JSONObject.NULL)));
        }
        assertThrows(Exception.class,()->prepared(prepared().put("shiftId",JSONObject.NULL)));
        assertThrows(Exception.class,()->context(context().put("shiftId",true)));
        assertThrows(Exception.class,()->context(context().put("shiftId","bad")));
    }
    @Test public void verifiedBundleCannotBeReboundByMatchingIncomingPreparedScope()throws Exception{
        String otherShift=UUID.randomUUID().toString();OfflineBundle.Binding changed=new OfflineBundle.Binding(binding.organizationId,binding.branchId,binding.deviceId,binding.actorId,otherShift,binding.keyEpoch,binding.deviceKeySha256);
        String envelope=sign(prepared().put("shiftId",otherShift));assertThrows(Exception.class,()->NativeHandoff.verifyPrepared(envelope,pins,nonce,changed,bundle.authorityId,bundle,before,after));
    }
    @Test public void sameBootElapsedAndWallRollbackFailClosed()throws Exception{
        String envelope=sign(context());
        for(OfflineClock.Reading bad:new OfflineClock.Reading[]{new OfflineClock.Reading(UUID.randomUUID().toString(),1250,now+250),new OfflineClock.Reading(boot,999,now+250),new OfflineClock.Reading(boot,1250,now-1)})
            assertThrows(Exception.class,()->NativeHandoff.verifyContext(envelope,pins,nonce,scope,before,bad));
        assertThrows(Exception.class,()->NativeHandoff.verifyContext(envelope,pins,nonce,scope,null,after));
        assertThrows(Exception.class,()->NativeHandoff.verifyContext(envelope,pins,nonce,scope,before,null));
    }
    @Test public void zeroAndThirtySecondRoundTripsAllowedButLongerRejected()throws Exception{
        String envelope=sign(context());assertEquals(now,NativeHandoff.verifyContext(envelope,pins,nonce,scope,before,before).freshTimeMs);
        OfflineClock.Reading limit=new OfflineClock.Reading(boot,31000,now+30000);assertEquals(now+30000,NativeHandoff.verifyContext(envelope,pins,nonce,scope,before,limit).freshTimeMs);
        OfflineClock.Reading tooLate=new OfflineClock.Reading(boot,31001,now+30001);assertThrows(Exception.class,()->NativeHandoff.verifyContext(envelope,pins,nonce,scope,before,tooLate));
        String grant=sign(prepared());assertThrows(Exception.class,()->NativeHandoff.verifyPrepared(grant,pins,nonce,binding,bundle.authorityId,bundle,before,tooLate));
    }
    @Test public void boundedServerTimeCannotCoerceOverflowOrUnderflow()throws Exception{
        assertEquals(250,context(context().put("serverTimeMs",0)).freshTimeMs);
        assertEquals(OfflineClock.MAX_TIME_MS,context(context().put("serverTimeMs",OfflineClock.MAX_TIME_MS-250)).freshTimeMs);
        for(Object bad:new Object[]{-1L,OfflineClock.MAX_TIME_MS+1,OfflineClock.MAX_TIME_MS,"1792132200000",true,JSONObject.NULL}){
            assertThrows(Exception.class,()->context(context().put("serverTimeMs",bad)));
            assertThrows(Exception.class,()->prepared(prepared().put("serverTimeMs",bad)));
        }
    }
    @Test public void unsignedEnvelopeCannotExploitDuplicateKeysOrUnboundedWhitespace()throws Exception{
        String envelope=sign(context());JSONObject parsed=new JSONObject(envelope);
        String duplicate=envelope.substring(0,envelope.length()-1)+",\"keyId\":\""+parsed.getString("keyId")+"\"}";
        assertThrows(Exception.class,()->NativeHandoff.verifyContext(duplicate,pins,nonce,scope,before,after));
        assertThrows(Exception.class,()->NativeHandoff.verifyContext(" ".repeat(16385)+envelope,pins,nonce,scope,before,after));
    }
    @Test public void recoveredHandoffAddsRoundTripAndCannotBeUsedForPreparation()throws Exception{
        NativeHandoff.Recovered result=recovered(recovered());assertEquals(now+250,result.freshTimeMs);
        assertEquals(bundle.authorityId,result.authorityId);assertEquals(bundle.snapshotSha256,result.snapshotSha256);assertEquals(bundle.authoritySha256,result.authoritySha256);
        String terminal=sign(recovered()),sale=sign(prepared());
        assertThrows(Exception.class,()->NativeHandoff.verifyPrepared(terminal,pins,nonce,binding,bundle.authorityId,bundle,before,after));
        assertThrows(Exception.class,()->NativeHandoff.verifyRecovered(sale,pins,nonce,binding,bundle.authorityId,bundle,before,after));
        assertThrows(Exception.class,()->recovered(recovered().put("kind","native-offline-prepared")));
        assertThrows(Exception.class,()->recovered(recovered().put("purpose","checkout")));
        JSONObject missing=recovered();missing.remove("purpose");assertThrows(Exception.class,()->recovered(missing));
        assertThrows(Exception.class,()->recovered(recovered().put("extra",true)));
    }
    @Test public void recoveredHandoffRequiresIndependentAllScopeHashesAuthorityAndPinnedSigner()throws Exception{
        for(String field:new String[]{"actorId","organizationId","branchId","deviceId","shiftId","keyEpoch","authorityId"})
            assertThrows(field,Exception.class,()->recovered(recovered().put(field,UUID.randomUUID().toString())));
        for(String field:new String[]{"deviceKeySha256","snapshotSha256","authoritySha256","challenge"})
            assertThrows(field,Exception.class,()->recovered(recovered().put(field,"f".repeat(64))));
        String envelope=sign(recovered());
        assertThrows(Exception.class,()->NativeHandoff.verifyRecovered(envelope,Collections.emptyMap(),nonce,binding,bundle.authorityId,bundle,before,after));
        assertThrows(Exception.class,()->NativeHandoff.verifyRecovered(envelope,pins,nonce,binding,UUID.randomUUID().toString(),bundle,before,after));
        assertThrows(Exception.class,()->NativeHandoff.verifyRecovered(envelope,pins,nonce,binding,bundle.authorityId,null,before,after));
        String otherShift=UUID.randomUUID().toString();OfflineBundle.Binding changed=new OfflineBundle.Binding(binding.organizationId,binding.branchId,binding.deviceId,binding.actorId,otherShift,binding.keyEpoch,binding.deviceKeySha256);
        String rebound=sign(recovered().put("shiftId",otherShift));assertThrows(Exception.class,()->NativeHandoff.verifyRecovered(rebound,pins,nonce,changed,bundle.authorityId,bundle,before,after));
    }
    @Test public void recoveredHandoffEnforcesFreshnessWithoutExtendingItsTimeBound()throws Exception{
        String envelope=sign(recovered());
        assertEquals(now,NativeHandoff.verifyRecovered(envelope,pins,nonce,binding,bundle.authorityId,bundle,before,before).freshTimeMs);
        assertEquals(now+30000,NativeHandoff.verifyRecovered(envelope,pins,nonce,binding,bundle.authorityId,bundle,before,new OfflineClock.Reading(boot,31000,now+30000)).freshTimeMs);
        for(OfflineClock.Reading bad:new OfflineClock.Reading[]{null,new OfflineClock.Reading(boot,31001,now+30001),new OfflineClock.Reading(boot,999,now),new OfflineClock.Reading(boot,1250,now-1),new OfflineClock.Reading(UUID.randomUUID().toString(),1250,now+250)})
            assertThrows(Exception.class,()->NativeHandoff.verifyRecovered(envelope,pins,nonce,binding,bundle.authorityId,bundle,before,bad));
        for(Object bad:new Object[]{-1L,OfflineClock.MAX_TIME_MS,OfflineClock.MAX_TIME_MS+1,"1792132200000",true,JSONObject.NULL})
            assertThrows(Exception.class,()->recovered(recovered().put("serverTimeMs",bad)));
        assertEquals(OfflineClock.MAX_TIME_MS,recovered(recovered().put("serverTimeMs",OfflineClock.MAX_TIME_MS-250)).freshTimeMs);
    }
}
