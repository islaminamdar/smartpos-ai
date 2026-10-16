package info.internext.pos.offline;
import java.security.*;
import java.security.spec.ECGenParameterSpec;
import java.util.*;
import org.json.JSONObject;
import org.junit.*;
import static org.junit.Assert.*;

public class NativePinRecoveryProofTest {
    private KeyPair device,server;private JSONObject request;private String fingerprint,proof,hash;private Map<String,PublicKey> pins;
    @Before public void setup()throws Exception{
        KeyPairGenerator g=KeyPairGenerator.getInstance("EC");g.initialize(new ECGenParameterSpec("secp256r1"));device=g.generateKeyPair();server=g.generateKeyPair();fingerprint=SignedProtocol.fingerprint(device.getPublic());pins=Collections.singletonMap("server",server.getPublic());
        request=new JSONObject().put("kind","native-pin-recovery").put("schemaVersion",1).put("signedAt","2026-10-16T10:20:30.000Z");
        for(String k:NativePinRecoveryProof.CORE)request.put(k,k.endsWith("Sha256")?(k.equals("deviceKeySha256")?fingerprint:k.equals("oldCredentialSha256")?"ab".repeat(32):"cd".repeat(32)):UUID.randomUUID().toString());
        proof=device(request);hash=NativePinRecoveryProof.payloadHash(proof);
    }
    private String device(JSONObject p)throws Exception{return SignedProtocol.sign(p,fingerprint,device.getPrivate(),device.getPublic());}
    private JSONObject approval()throws Exception{return NativePinRecoveryProof.core(request).put("kind","native-pin-recovery-approval").put("schemaVersion",1).put("proofSha256",hash).put("approvedAt","2026-10-16T10:20:31.000Z");}
    private String server(JSONObject p)throws Exception{return SignedProtocol.sign(p,"server",server.getPrivate(),server.getPublic());}
    private JSONObject verify(JSONObject p)throws Exception{return NativePinRecoveryProof.approval(server(p),pins,request,hash);}
    @Test public void verifiesDeviceAndPinnedExactApprovalWithoutGrantExpiry()throws Exception{
        assertEquals(new String(CanonicalJson.bytes(request),java.nio.charset.StandardCharsets.UTF_8),new String(CanonicalJson.bytes(NativePinRecoveryProof.request(proof,Collections.singletonMap(fingerprint,device.getPublic()))),java.nio.charset.StandardCharsets.UTF_8));
        assertEquals(request.get("requestId"),verify(approval()).get("requestId"));assertEquals("1970-01-01T00:00:00.000Z",verify(approval().put("approvedAt","1970-01-01T00:00:00.000Z")).getString("approvedAt"));
    }
    @Test public void everyOriginalIdentityAndGenerationIsBound()throws Exception{
        for(String k:NativePinRecoveryProof.CORE){JSONObject p=approval().put(k,k.endsWith("Sha256")?"ef".repeat(32):UUID.randomUUID().toString());assertThrows(k,Exception.class,()->verify(p));}
        assertThrows(Exception.class,()->verify(approval().put("proofSha256","ff".repeat(32))));
    }
    @Test public void refusesUnknownKeysPayloadTamperingAndEnvelopeKeyInjection()throws Exception{
        String good=server(approval());assertThrows(Exception.class,()->NativePinRecoveryProof.approval(good,Collections.emptyMap(),request,hash));
        JSONObject changed=new JSONObject(good).put("payloadBase64Url",SignedProtocol.encode(CanonicalJson.bytes(approval().put("requestId",UUID.randomUUID().toString()))));assertThrows(Exception.class,()->NativePinRecoveryProof.approval(changed.toString(),pins,request,hash));
        assertThrows(Exception.class,()->NativePinRecoveryProof.approval(new JSONObject(good).put("publicKey",SignedProtocol.encode(server.getPublic().getEncoded())).toString(),pins,request,hash));
    }
    @Test public void schemaKindTypesAndUnknownFieldsCannotBecomeApproval()throws Exception{
        assertThrows(Exception.class,()->verify(approval().put("purpose","grant")));assertThrows(Exception.class,()->verify(approval().put("kind","native-offline-prepared")));assertThrows(Exception.class,()->verify(approval().put("schemaVersion","1")));
        JSONObject p=approval();p.remove("oldCredentialSha256");assertThrows(Exception.class,()->verify(p));
    }
    @Test public void enforcesStrictUtcMillisRealDatesAndBoundedEpoch()throws Exception{
        for(String stamp:new String[]{"2026-02-30T00:00:00.000Z","2026-10-16T10:20:30Z","2026-10-16T10:20:30.000+00:00","1969-12-31T23:59:59.999Z","10000-01-01T00:00:00.000Z"})assertThrows(stamp,Exception.class,()->verify(approval().put("approvedAt",stamp)));
    }
    @Test public void deviceEnvelopeKeyIdMustMatchEnrolledFingerprint()throws Exception{
        JSONObject changed=new JSONObject(request.toString()).put("deviceKeySha256","ef".repeat(32));String signed=device(changed);assertThrows(Exception.class,()->NativePinRecoveryProof.request(signed,Collections.singletonMap(fingerprint,device.getPublic())));
        assertThrows(Exception.class,()->NativePinRecoveryProof.request(device(new JSONObject(request.toString()).put("newCredentialSha256",request.get("oldCredentialSha256"))),Collections.singletonMap(fingerprint,device.getPublic())));
    }
    @Test public void newSignedAtPreservesCoreButApprovalBindsAcceptedProofVersion()throws Exception{
        JSONObject newer=new JSONObject(request.toString()).put("signedAt","2026-10-16T10:25:30.000Z");String next=device(newer);assertEquals(new String(CanonicalJson.bytes(NativePinRecoveryProof.core(request)),java.nio.charset.StandardCharsets.UTF_8),new String(CanonicalJson.bytes(NativePinRecoveryProof.core(newer)),java.nio.charset.StandardCharsets.UTF_8));assertNotEquals(hash,NativePinRecoveryProof.payloadHash(next));
        assertThrows(Exception.class,()->NativePinRecoveryProof.approval(server(approval()),pins,newer,NativePinRecoveryProof.payloadHash(next)));
        assertEquals(hash,NativePinRecoveryProof.approval(server(approval()),pins,request,hash).getString("proofSha256"));
    }
}
