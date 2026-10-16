package info.internext.pos.offline;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.UUID;
import static org.junit.Assert.*;

public class OfflineBundleTest {
    private interface Change { void apply(Fixture f) throws Exception; }
    private static class Fixture {
        JSONObject snapshot,authority;
        final KeyPair keys;
        Fixture() throws Exception {
            try(var stream=OfflineBundleTest.class.getResourceAsStream("/pos-offline-output.json")) {
                assertNotNull(stream);
                JSONObject b=new JSONObject(new String(stream.readAllBytes(),StandardCharsets.UTF_8)).getJSONObject("bundle");
                snapshot=b.getJSONObject("snapshot");authority=b.getJSONObject("authority");
            }
            KeyPairGenerator g=KeyPairGenerator.getInstance("EC");g.initialize(new ECGenParameterSpec("secp256r1"));keys=g.generateKeyPair();
        }
        OfflineBundle.Binding binding() throws Exception {
            return new OfflineBundle.Binding(authority.getString("organizationId"),authority.getString("branchId"),authority.getString("deviceId"),authority.getString("actorId"),authority.getString("shiftId"),authority.getString("keyEpoch"),authority.getString("deviceKeySha256"));
        }
        String sign(JSONObject p) throws Exception { return SignedProtocol.sign(p,"synthetic-server",keys.getPrivate(),keys.getPublic()); }
        String signedSnapshot() throws Exception { return sign(snapshot); }
        String signedAuthority() throws Exception { authority.put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot)));return sign(authority); }
        OfflineBundle verify() throws Exception { return OfflineBundle.verify(signedSnapshot(),signedAuthority(),Collections.singletonMap("synthetic-server",keys.getPublic()),binding()); }
    }
    private void reject(Change change) throws Exception { Fixture f=new Fixture();change.apply(f);assertThrows(Exception.class,f::verify); }

    @Test public void actualSqlBundleSignedByEphemeralKeyPreservesImmutableValuesAndCalculatorInputs() throws Exception {
        Fixture f=new Fixture();String s=f.signedSnapshot(),a=f.signedAuthority();
        OfflineBundle b=OfflineBundle.verify(s,a,Collections.singletonMap("synthetic-server",f.keys.getPublic()),f.binding());
        assertEquals(f.snapshot.getString("id"),b.snapshotId);assertEquals(f.authority.getString("id"),b.authorityId);
        assertEquals(SignedProtocol.hash(CanonicalJson.bytes(f.snapshot)),b.snapshotSha256);assertEquals(SignedProtocol.hash(CanonicalJson.bytes(f.authority)),b.authoritySha256);
        assertEquals(s,b.snapshotEnvelope());assertEquals(a,b.authorityEnvelope());
        assertEquals(1,b.firstInvoice);assertEquals(3,b.lastInvoice);assertEquals("TEST",b.invoicePrefix);
        assertTrue(b.cashAllowed);assertTrue(b.recordedCardAllowed);assertTrue(b.mixedTenderAllowed);assertEquals(3_600_000,b.expiresAtMs-b.issuedAtMs);
        for(OfflineBundle.Product p:b.products()) {var i=p.calculatorInput(1000);assertEquals(p.id,i.productId);assertEquals(p.unitPriceFils,i.unitPriceFils);assertSame(p,b.product(p.id));}
        b.snapshot().put("id","changed");b.authority().put("maxGrossFils",1);b.profile().put("trn","changed");b.snapshotBytes()[0]=0;b.authorityBytes()[0]=0;
        assertArrayEquals(CanonicalJson.bytes(f.snapshot),b.snapshotBytes());assertArrayEquals(CanonicalJson.bytes(f.authority),b.authorityBytes());
        assertEquals(f.snapshot.getJSONObject("profile").getString("trn"),b.profile().getString("trn"));
        assertThrows(UnsupportedOperationException.class,()->b.products().clear());assertThrows(IllegalArgumentException.class,()->b.product(UUID.randomUUID().toString()));
    }

    @Test public void verifiesBothSignaturesAgainstIndependentTrustAndRequiresControlledBinding() throws Exception {
        Fixture f=new Fixture();String s=f.signedSnapshot(),a=f.signedAuthority();
        assertThrows(Exception.class,()->OfflineBundle.verify(s,a,Collections.emptyMap(),f.binding()));
        assertThrows(Exception.class,()->OfflineBundle.verify(s,a,Collections.singletonMap("synthetic-server",new Fixture().keys.getPublic()),f.binding()));
        assertThrows(Exception.class,()->OfflineBundle.verify(s,a,Collections.singletonMap("synthetic-server",f.keys.getPublic()),null));
        JSONObject bs=new JSONObject(s).put("payloadBase64Url",SignedProtocol.encode(CanonicalJson.bytes(new JSONObject(f.snapshot.toString()).put("id",UUID.randomUUID().toString()))));
        assertThrows(Exception.class,()->OfflineBundle.verify(bs.toString(),a,Collections.singletonMap("synthetic-server",f.keys.getPublic()),f.binding()));
        JSONObject ba=new JSONObject(a).put("payloadBase64Url",SignedProtocol.encode(CanonicalJson.bytes(new JSONObject(f.authority.toString()).put("maxGrossFils",1))));
        assertThrows(Exception.class,()->OfflineBundle.verify(s,ba.toString(),Collections.singletonMap("synthetic-server",f.keys.getPublic()),f.binding()));
    }

    @Test public void rejectsUnknownOrMissingFieldsAtEveryFinancialNestingLevel() throws Exception {
        reject(f->f.snapshot.put("remoteKeys",new JSONObject()));reject(f->f.snapshot.getJSONObject("profile").put("extra",true));
        reject(f->f.snapshot.getJSONArray("products").getJSONObject(0).put("discount",100));reject(f->f.authority.put("extra",true));
        reject(f->f.authority.getJSONObject("invoiceRange").put("recycle",true));reject(f->f.authority.getJSONObject("permissions").put("refunds",true));
        reject(f->f.authority.getJSONObject("policy").put("extra",true));reject(f->f.snapshot.remove("offers"));reject(f->f.authority.remove("permissions"));
    }

    @Test public void refusesStringNumberBooleanAndNullCoercion() throws Exception {
        reject(f->f.snapshot.getJSONArray("products").getJSONObject(0).put("unitPriceFils","1000"));reject(f->f.authority.put("schemaVersion","1"));
        reject(f->f.authority.getJSONObject("permissions").put("cash","true"));reject(f->f.snapshot.put("profile",JSONObject.NULL));
        reject(f->f.snapshot.put("products",new JSONObject()));reject(f->f.authority.put("maxGrossFils",JSONObject.NULL));
    }

    @Test public void bindsOrganizationBranchDeviceActorShiftEpochFingerprintSnapshotAndHash() throws Exception {
        Fixture f=new Fixture();String s=f.signedSnapshot(),a=f.signedAuthority();var b=f.binding();
        String[] ids={b.organizationId,b.branchId,b.deviceId,b.actorId,b.shiftId,b.keyEpoch,b.deviceKeySha256};
        for(int i=0;i<ids.length;i++) {
            String[] v=ids.clone();v[i]=i==6?"f".repeat(64):UUID.randomUUID().toString();
            var changed=new OfflineBundle.Binding(v[0],v[1],v[2],v[3],v[4],v[5],v[6]);
            assertThrows(Exception.class,()->OfflineBundle.verify(s,a,Collections.singletonMap("synthetic-server",f.keys.getPublic()),changed));
        }
        reject(x->x.snapshot.getJSONObject("profile").put("branchId",UUID.randomUUID().toString()));reject(x->x.authority.put("snapshotId",UUID.randomUUID().toString()));
        Fixture h=new Fixture();String hs=h.signedSnapshot();h.authority.put("snapshotSha256","f".repeat(64));String ha=h.sign(h.authority);
        assertThrows(Exception.class,()->OfflineBundle.verify(hs,ha,Collections.singletonMap("synthetic-server",h.keys.getPublic()),h.binding()));
    }

    @Test public void enforcesLowercaseIdsHashesAndEcmaWhitespaceWithoutTrimmingAuthenticatedText() throws Exception {
        reject(f->f.authority.put("deviceId",f.authority.getString("deviceId").toUpperCase(java.util.Locale.ROOT)));
        reject(f->f.authority.put("keyEpoch","not-a-uuid"));reject(f->f.authority.put("deviceKeySha256","A".repeat(64)));
        for(String w:new String[]{" ","\u00a0","\u2003","\ufeff","\n"}) {
            reject(f->f.snapshot.getJSONArray("products").getJSONObject(0).put("name",w+"Synthetic"));reject(f->f.snapshot.getJSONObject("profile").put("legalName","Synthetic"+w));
        }
        Fixture valid=new Fixture();valid.snapshot.getJSONArray("products").getJSONObject(0).put("name","مثال 🍮");assertNotNull(valid.verify());
        reject(f->f.snapshot.getJSONArray("products").getJSONObject(0).put("category","x".repeat(121)));
    }

    @Test public void boundsProductCountsDuplicatesUnitsPricesTaxAndRevision() throws Exception {
        reject(f->f.snapshot.put("products",new JSONArray()));reject(f->f.snapshot.getJSONArray("products").put(f.snapshot.getJSONArray("products").getJSONObject(0)));
        reject(f->f.snapshot.getJSONArray("products").getJSONObject(0).put("unit","litre"));reject(f->f.snapshot.getJSONArray("products").getJSONObject(0).put("unitPriceFils",100_000_001L));
        reject(f->f.snapshot.getJSONArray("products").getJSONObject(0).put("taxRateBps",10_001));reject(f->f.snapshot.getJSONArray("products").getJSONObject(0).put("revision",0));
        Fixture max=new Fixture();JSONArray products=new JSONArray();JSONObject p=max.snapshot.getJSONArray("products").getJSONObject(0);
        for(int i=0;i<2000;i++)products.put(new JSONObject(p.toString()).put("id",UUID.randomUUID().toString()));
        max.snapshot.put("products",products);assertEquals(2000,max.verify().products().size());
        products.put(new JSONObject(p.toString()).put("id",UUID.randomUUID().toString()));assertThrows(Exception.class,max::verify);
    }

    @Test public void boundsNumberRangeBudgetsTendersAndUnsupportedPolicies() throws Exception {
        reject(f->f.authority.getJSONObject("invoiceRange").put("prefix","bad-prefix"));reject(f->f.authority.getJSONObject("invoiceRange").put("first",0));
        reject(f->f.authority.getJSONObject("invoiceRange").put("last",1001));reject(f->f.authority.getJSONObject("invoiceRange").put("last",0));
        reject(f->f.authority.put("maxInvoiceTotalFils",100_000_001));reject(f->f.authority.put("maxGrossFils",300_001));
        reject(f->f.authority.getJSONObject("permissions").put("cash",false));
        reject(f->f.authority.getJSONObject("permissions").put("cash",false).put("recordedCard",false).put("mixedTender",false));
        reject(f->f.authority.getJSONObject("policy").put("offers","offline"));reject(f->f.snapshot.getJSONArray("offers").put(new JSONObject()));
        reject(f->f.snapshot.getJSONObject("profile").put("taxInclusive",false));reject(f->f.snapshot.getJSONObject("profile").put("currency","USD"));
        reject(f->f.snapshot.getJSONObject("profile").put("trn","10000000000000"));
    }

    @Test public void usesStrictProlepticGregorianUtcMillisAndBoundedAuthorityWindow() throws Exception {
        for(String at:new String[]{"2026-02-30T01:00:00.000Z","1900-02-29T01:00:00.000Z","2026-10-16T24:00:00.000Z","2026-10-16T10:00:60.000Z","2026-10-16T10:00:00Z","2026-10-16T10:00:00.000+00:00"})reject(f->f.snapshot.put("createdAt",at));
        Fixture ancient=new Fixture();ancient.snapshot.put("createdAt","0000-01-01T00:00:00.000Z");ancient.authority.put("issuedAt","0000-01-01T00:00:00.000Z").put("notBefore","0000-01-01T00:00:00.000Z").put("expiresAt","0000-01-02T00:00:00.000Z");
        assertEquals(-62_167_219_200_000L,ancient.verify().issuedAtMs);
        Fixture leap=new Fixture();leap.snapshot.put("createdAt","2000-02-29T00:00:00.000Z");leap.authority.put("issuedAt","2000-02-29T00:00:00.000Z").put("notBefore","2000-02-29T00:00:00.000Z").put("expiresAt","2000-03-01T00:00:00.000Z");
        assertEquals(86_400_000,leap.verify().expiresAtMs-leap.verify().issuedAtMs);
        leap.authority.put("expiresAt","2000-03-01T00:00:00.001Z");assertThrows(Exception.class,leap::verify);
        reject(f->f.authority.put("notBefore",f.authority.getString("expiresAt")));reject(f->f.snapshot.put("createdAt",f.authority.getString("expiresAt")));
        reject(f->f.snapshot.getJSONObject("profile").put("confirmedAt","2026-02-30T10:00:00.000+00:00"));
    }

    @Test public void oldBundlesRemainVerifiableForHistoricalCustodyAndSqlMicrosecondsStayExact() throws Exception {
        Fixture f=new Fixture();f.snapshot.put("createdAt","2000-01-01T00:00:00.000Z");f.authority.put("issuedAt","2000-01-01T00:00:00.000Z").put("notBefore","2000-01-01T00:00:00.000Z").put("expiresAt","2000-01-01T08:00:00.000Z");
        assertTrue(f.verify().expiresAtMs<System.currentTimeMillis());
        f.snapshot.getJSONObject("profile").put("confirmedAt","2000-01-01T00:00:00.123456+04:00");
        assertEquals("2000-01-01T00:00:00.123456+04:00",f.verify().profile().getString("confirmedAt"));
    }
}
