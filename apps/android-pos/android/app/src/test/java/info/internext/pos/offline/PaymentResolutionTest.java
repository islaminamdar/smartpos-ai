package info.internext.pos.offline;

import org.json.JSONObject;
import org.junit.Test;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.UUID;
import static org.junit.Assert.*;

/** Independent protocol tests: signed synthetic outcomes cannot become fiscal documents. */
public class PaymentResolutionTest {
    private static final String CHALLENGE="c".repeat(64), FREEZE_HASH="f".repeat(64);
    private static class Fixture {
        final KeyPair key;
        final JSONObject freeze=new JSONObject(), result=new JSONObject();
        Fixture()throws Exception{
            KeyPairGenerator gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));key=gen.generateKeyPair();
            for(String name:new String[]{"freezeId","paymentIntentId","orderId","documentId","organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","authorityId"})freeze.put(name,UUID.randomUUID().toString());
            for(String name:new String[]{"requestSha256","authoritySha256","snapshotSha256"})freeze.put(name,"a".repeat(64));
            freeze.put("request",new JSONObject().put("cashTenderedFils",0).put("recordedCardFils",1000).put("presentedTotalFils",1000).put("customer",JSONObject.NULL));
            java.util.Iterator<String> names=freeze.keys();while(names.hasNext()){String name=names.next();if(!name.equals("request"))result.put(name,freeze.get(name));}
            result.put("kind","offline-payment-resolution").put("schemaVersion",1).put("purpose","reconciliation-only")
                .put("resolutionId",UUID.randomUUID().toString()).put("requestId",UUID.randomUUID().toString())
                .put("managerActorId",UUID.randomUUID().toString()).put("freezeSha256",FREEZE_HASH)
                .put("decision","funds_returned").put("evidenceSha256","b".repeat(64))
                .put("resolvedAt","2026-10-16T10:00:00.000Z").put("replacement",JSONObject.NULL);
        }
        JSONObject signed(JSONObject value)throws Exception{return new JSONObject(SignedProtocol.sign(value,"server",key.getPrivate(),key.getPublic()));}
        JSONObject response()throws Exception{
            JSONObject h=new JSONObject().put("kind","native-payment-resolution-status").put("schemaVersion",1).put("purpose","reconciliation-only")
                .put("challenge",CHALLENGE).put("serverTimeMs",1792144800000L).put("freezeSha256",FREEZE_HASH)
                .put("state","resolved").put("resolutionSha256",SignedProtocol.hash(CanonicalJson.bytes(result))).put("issuanceSha256",JSONObject.NULL);
            for(String name:new String[]{"authorityId","keyEpoch","deviceId","freezeId"})h.put(name,freeze.get(name));
            return new JSONObject().put("handoff",signed(h)).put("resolutionEnvelope",signed(result)).put("receipt",JSONObject.NULL).put("acknowledgement",JSONObject.NULL);
        }
        PaymentResolution.Verified verify()throws Exception{return PaymentResolution.verify(response(),CHALLENGE,freeze,FREEZE_HASH,Collections.singletonMap("server",key.getPublic()));}
    }
    @Test public void immutableReturnedAttestationAndCardVoidDoNotExposeMutableVerifiedState()throws Exception{
        Fixture f=new Fixture();PaymentResolution.Verified v=f.verify();assertEquals("resolved",v.state);
        String original=v.resolution().getString("decision");v.resolution().put("decision","changed");assertEquals(original,v.resolution().getString("decision"));
        f.result.put("decision","payment_voided");assertEquals("payment_voided",f.verify().resolution().getString("decision"));
        // Protocol-only net-card binding. The engine calculator separately rejects this
        // unsupported positive-cash/all-change request before any proof can be accepted.
        f.freeze.getJSONObject("request").put("cashTenderedFils",2000);assertEquals("payment_voided",f.verify().resolution().getString("decision"));
    }
    @Test public void everyScopeAndOriginalHashIsBoundIndependently()throws Exception{
        for(String field:new String[]{"freezeId","paymentIntentId","orderId","documentId","organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","authorityId"}){
            Fixture f=new Fixture();f.result.put(field,UUID.randomUUID().toString());assertThrows(field,Exception.class,f::verify);
        }
        for(String field:new String[]{"requestSha256","authoritySha256","snapshotSha256","freezeSha256"}){
            Fixture f=new Fixture();f.result.put(field,"d".repeat(64));assertThrows(field,Exception.class,f::verify);
        }
    }
    @Test public void newChallengeAndIndependentPinAreRequiredEvenForSignedTerminalResult()throws Exception{
        Fixture f=new Fixture();JSONObject response=f.response();
        assertThrows(Exception.class,()->PaymentResolution.verify(response,"e".repeat(64),f.freeze,FREEZE_HASH,Collections.singletonMap("server",f.key.getPublic())));
        assertThrows(Exception.class,()->PaymentResolution.verify(response,CHALLENGE,f.freeze,FREEZE_HASH,Collections.singletonMap("server",new Fixture().key.getPublic())));
        response.getJSONObject("resolutionEnvelope").put("payloadBase64Url",SignedProtocol.encode(CanonicalJson.bytes(new JSONObject(f.result.toString()).put("decision","payment_voided"))));
        assertThrows(Exception.class,()->PaymentResolution.verify(response,CHALLENGE,f.freeze,FREEZE_HASH,Collections.singletonMap("server",f.key.getPublic())));
    }
    @Test public void strictSignedSchemaRejectsReplacementUnknownsCoercionAndInvalidTimes()throws Exception{
        for(String field:new String[]{"extra","replacement","schemaVersion","resolvedAt","evidenceSha256","decision"}){
            Fixture f=new Fixture();Object changed=field.equals("replacement")?new JSONObject():field.equals("schemaVersion")?"1":field.equals("resolvedAt")?"2026-02-30T10:00:00.000Z":field.equals("evidenceSha256")?"A".repeat(64):"current_time_invoice";
            f.result.put(field,changed);assertThrows(field,Exception.class,f::verify);
        }
        Fixture future=new Fixture();future.result.put("resolvedAt","9999-12-31T23:59:59.999Z");assertThrows(Exception.class,future::verify);
    }
    @Test public void voidCannotDisposeCashMixedOrLegacyUnstorableBuyerEvidence()throws Exception{
        Fixture cash=new Fixture();cash.result.put("decision","payment_voided");cash.freeze.getJSONObject("request").put("cashTenderedFils",1000).put("recordedCardFils",0);assertThrows(Exception.class,cash::verify);
        Fixture mixed=new Fixture();mixed.result.put("decision","payment_voided");mixed.freeze.getJSONObject("request").put("cashTenderedFils",500).put("recordedCardFils",500);assertThrows(Exception.class,mixed::verify);
        Fixture nul=new Fixture();nul.freeze.getJSONObject("request").put("customer",new JSONObject().put("name","Old\u0000Name").put("address","Synthetic"));assertThrows(Exception.class,nul::verify);
    }
}
