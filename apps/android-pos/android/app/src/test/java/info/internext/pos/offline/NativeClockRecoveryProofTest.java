package info.internext.pos.offline;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.UUID;
import static org.junit.Assert.*;

/** Independent JVM P-256 verification; no Android clock or storage mocked as cryptographic truth. */
public class NativeClockRecoveryProofTest {
    private KeyPair device,server;private JSONObject core;private String request,approval;
    private final String hash=String.join("",Collections.nCopies(64,"a"));
    @Before public void setup()throws Exception{
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC");generator.initialize(new ECGenParameterSpec("secp256r1"));device=generator.generateKeyPair();server=generator.generateKeyPair();core=new JSONObject();
        for(String key:NativeClockRecoveryProof.CORE)core.put(key,key.equals("oldClockGeneration")?0:key.equals("deviceKeySha256")?SignedProtocol.fingerprint(device.getPublic()):key.endsWith("Sha256")?hash:UUID.randomUUID().toString());
        request=sign(new JSONObject(core.toString()).put("kind","native-clock-recovery").put("schemaVersion",1),device,SignedProtocol.fingerprint(device.getPublic()));approval=sign(approvalPayload(),server,"server");
    }
    private JSONObject approvalPayload()throws Exception{return new JSONObject(core.toString()).put("kind","native-clock-recovery-approval").put("schemaVersion",1).put("proofSha256",NativeClockRecoveryProof.payloadHash(request)).put("approvedAt","2026-10-16T10:30:00.000Z");}
    private static String sign(JSONObject p,KeyPair pair,String id)throws Exception{return SignedProtocol.sign(p,id,pair.getPrivate(),pair.getPublic());}
    private JSONObject readApproval(String envelope)throws Exception{return NativeClockRecoveryProof.approval(envelope,Collections.singletonMap("server",server.getPublic()),core,NativeClockRecoveryProof.payloadHash(request));}
    @Test public void realSignaturesAndLongIntegerGenerationMatch()throws Exception{assertEquals(core.get("requestId"),NativeClockRecoveryProof.request(request,Collections.singletonMap(SignedProtocol.fingerprint(device.getPublic()),device.getPublic())).get("requestId"));core.put("oldClockGeneration",0L);assertEquals("native-clock-recovery-approval",readApproval(approval).getString("kind"));}
    @Test public void everyScopeAndHashChangeRejectsEvenAuthenticallyServerSigned()throws Exception{for(String field:NativeClockRecoveryProof.CORE){JSONObject p=approvalPayload();p.put(field,field.equals("oldClockGeneration")?1:field.endsWith("Sha256")?String.join("",Collections.nCopies(64,"b")):UUID.randomUUID().toString());String candidate=sign(p,server,"server");assertThrows(Exception.class,()->readApproval(candidate));}}
    @Test public void unknownFieldsAndWrongProofDigestReject()throws Exception{String extra=sign(approvalPayload().put("enableSales",true),server,"server");assertThrows(Exception.class,()->readApproval(extra));String wrong=sign(approvalPayload().put("proofSha256",hash),server,"server");assertThrows(Exception.class,()->readApproval(wrong));}
    @Test public void envelopeCannotProvideItsOwnTrustKey()throws Exception{String wrong=sign(approvalPayload(),device,"server");assertThrows(Exception.class,()->readApproval(wrong));assertThrows(Exception.class,()->NativeClockRecoveryProof.request(request,Collections.singletonMap("server",server.getPublic())));}
    @Test public void approvalTimestampMustBeExactBoundedUtcMilliseconds()throws Exception{for(String t:new String[]{"2026-10-16T10:30:00Z","2026-10-16T10:30:00.000+00:00","2026-02-30T10:30:00.000Z","1969-12-31T23:59:59.999Z"}){String bad=sign(approvalPayload().put("approvedAt",t),server,"server");assertThrows(Exception.class,()->readApproval(bad));}}
    private JSONObject timePayload()throws Exception{return new JSONObject().put("kind","native-clock-recovery-time").put("schemaVersion",1).put("requestId",core.get("requestId")).put("approvalSha256",NativeClockRecoveryProof.payloadHash(approval)).put("retirementSha256",hash).put("oldClockGeneration",0).put("challenge",hash).put("serverTimeMs",1_792_132_200_000L);}
    private long verifyTime(JSONObject p)throws Exception{return NativeClockRecoveryProof.time(sign(p,server,"server"),Collections.singletonMap("server",server.getPublic()),core,NativeClockRecoveryProof.payloadHash(approval),hash);}
    @Test public void timeBindsEveryRecoveryIdentityAndNonce()throws Exception{assertEquals(1_792_132_200_000L,verifyTime(timePayload()));for(String k:new String[]{"requestId","approvalSha256","retirementSha256","oldClockGeneration","challenge"}){JSONObject p=timePayload().put(k,k.equals("oldClockGeneration")?1:k.equals("requestId")?UUID.randomUUID().toString():String.join("",Collections.nCopies(64,"c")));assertThrows(Exception.class,()->verifyTime(p));}}
    @Test public void timeRejectsFractionalNegativeOverflowAndUnknownFields()throws Exception{for(Object n:new Object[]{-1,1.5,253402300800000L}){JSONObject p=timePayload().put("serverTimeMs",n);assertThrows(Exception.class,()->verifyTime(p));}assertThrows(Exception.class,()->verifyTime(timePayload().put("expiryExtended",true)));}
    @Test public void proofHasNoCallerClockTimestampOrPermissionFields()throws Exception{JSONObject payload=new JSONObject(core.toString()).put("kind","native-clock-recovery").put("schemaVersion",1).put("signedAt","2026-10-16T10:30:00.000Z");String bad=sign(payload,device,SignedProtocol.fingerprint(device.getPublic()));assertThrows(Exception.class,()->NativeClockRecoveryProof.request(bad,Collections.singletonMap(SignedProtocol.fingerprint(device.getPublic()),device.getPublic())));}
}
