package info.internext.pos.offline;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.ECGenParameterSpec;
import java.util.*;
import static org.junit.Assert.*;
public class NativeClockBootstrapTimeTest {
 private KeyPair key;private JSONObject request;
 @Before public void setup()throws Exception{KeyPairGenerator g=KeyPairGenerator.getInstance("EC");g.initialize(new ECGenParameterSpec("secp256r1"));key=g.generateKeyPair();request=new JSONObject().put("schemaVersion",1).put("installationId",UUID.randomUUID().toString()).put("deviceKeySha256",hash("a")).put("oldClockGeneration",0).put("oldClockSha256",hash("b")).put("challenge",hash("c"));}
 private static String hash(String c){return String.join("",Collections.nCopies(64,c));}
 private JSONObject payload()throws Exception{return new JSONObject(request.toString()).put("kind","native-clock-bootstrap-time").put("serverTimeMs",1792132200000L);}
 private long verify(JSONObject p)throws Exception{return NativeClockBootstrapTime.verify(SignedProtocol.sign(p,"server",key.getPrivate(),key.getPublic()),Collections.singletonMap("server",key.getPublic()),request);}
 @Test public void exactPinnedSignatureWorks()throws Exception{assertEquals(1792132200000L,verify(payload()));}
 @Test public void everyEchoAndDomainMustMatch()throws Exception{for(String k:new String[]{"installationId","deviceKeySha256","oldClockGeneration","oldClockSha256","challenge","kind","schemaVersion"}){JSONObject p=payload().put(k,k.equals("oldClockGeneration")||k.equals("schemaVersion")?2:k.equals("installationId")?UUID.randomUUID().toString():k.equals("kind")?"native-clock-recovery-time":hash("d"));assertThrows(Exception.class,()->verify(p));}}
 @Test public void unknownAndInvalidTimesReject()throws Exception{for(Object t:new Object[]{-1,1.5,253402300800000L,"1792132200000"}){JSONObject p=payload().put("serverTimeMs",t);assertThrows(Exception.class,()->verify(p));}assertThrows(Exception.class,()->verify(payload().put("permissions",true)));}
 @Test public void unsafeGenerationAndMalformedIdentityRejectBeforeRequest()throws Exception{for(Object value:new Object[]{-1,1.5,9007199254740991L,"0"}){JSONObject p=new JSONObject(request.toString()).put("oldClockGeneration",value);assertThrows(Exception.class,()->NativeClockBootstrapTime.request(p));}for(String k:new String[]{"installationId","deviceKeySha256","oldClockSha256","challenge"}){JSONObject p=new JSONObject(request.toString()).put(k,"BAD");assertThrows(Exception.class,()->NativeClockBootstrapTime.request(p));}assertThrows(Exception.class,()->NativeClockBootstrapTime.request(new JSONObject(request.toString()).put("wallTimeMs",0)));}
 @Test public void actualTypeScriptServiceSignatureRoundTripAndMutations()throws Exception{
  byte[] bytes;try(InputStream in=getClass().getClassLoader().getResourceAsStream("native-clock-bootstrap-server-output.json")){assertNotNull(in);ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1)out.write(b,0,n);bytes=out.toByteArray();}
  JSONObject f=new JSONObject(new String(bytes,StandardCharsets.UTF_8));PublicKey publicKey=SignedProtocol.publicKey(SignedProtocol.decode(f.getString("serverPublicKeySpki"),256));JSONObject r=f.getJSONObject("request");String envelope=f.getJSONObject("time").toString();Map<String,PublicKey> pins=Collections.singletonMap("bootstrap-interop",publicKey);
  assertTrue(NativeClockBootstrapTime.verify(envelope,pins,r)>0);
  for(String k:new String[]{"installationId","deviceKeySha256","oldClockSha256","challenge"}){JSONObject changed=new JSONObject(r.toString()).put(k,k.equals("installationId")?UUID.randomUUID().toString():hash("f"));assertThrows(Exception.class,()->NativeClockBootstrapTime.verify(envelope,pins,changed));}
  assertThrows(Exception.class,()->NativeClockBootstrapTime.verify(envelope,Collections.singletonMap("bootstrap-interop",key.getPublic()),r));
 }
}
