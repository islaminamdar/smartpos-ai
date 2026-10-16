package info.internext.pos.offline;

import org.json.JSONArray;
import org.json.JSONObject;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.GregorianCalendar;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.regex.Pattern;

/** A verified, immutable offline catalogue and bounded authority. This validates the
 * signed contract, never present-day permission to issue: the native transaction must
 * additionally enforce local staff unlock, clock trust, sequence, number and budgets.
 * Old bundles remain verifiable for historical custody and receipt recovery. */
public final class OfflineBundle {
    private static final Pattern UUID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern HASH = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern UTC_MILLIS = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z");
    // Existing immutable merchantProfileSchema permits offset timestamps and arbitrary
    // subsecond precision, including PostgreSQL's microseconds. Preserve exact text.
    private static final Pattern PROFILE_TIME = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})");

    /** Comes from controlled device enrollment and an authenticated native staff/shift
     * session, not from copying identities out of the incoming signed bundle. */
    public static final class Binding {
        public final String organizationId, branchId, deviceId, actorId, shiftId, keyEpoch, deviceKeySha256;
        public Binding(String organizationId, String branchId, String deviceId, String actorId,
                       String shiftId, String keyEpoch, String deviceKeySha256) {
            for (String id : new String[]{organizationId, branchId, deviceId, actorId, shiftId, keyEpoch}) requireUuid(id);
            requireHash(deviceKeySha256);
            this.organizationId=organizationId;this.branchId=branchId;this.deviceId=deviceId;
            this.actorId=actorId;this.shiftId=shiftId;this.keyEpoch=keyEpoch;this.deviceKeySha256=deviceKeySha256;
        }
    }

    /** Product values are sourced exclusively from the authenticated frozen snapshot. */
    public static final class Product {
        public final String id, name, category;
        public final OfflineCalculator.Unit unit;
        public final long unitPriceFils, taxRateBps, revision;
        private Product(JSONObject value) throws Exception {
            fields(value,"id","name","category","unit","unitPriceFils","taxRateBps","revision");
            id=uuid(value,"id");name=text(value,"name",240);category=text(value,"category",120);
            try { unit=OfflineCalculator.Unit.valueOf(string(value,"unit")); }
            catch (IllegalArgumentException error) { throw invalid(); }
            unitPriceFils=integer(value,"unitPriceFils",0,100_000_000);
            taxRateBps=integer(value,"taxRateBps",0,10_000);
            revision=integer(value,"revision",1,2_147_483_647);
        }
        public OfflineCalculator.InputLine calculatorInput(long quantityMilli) {
            // Quantity and invoice arithmetic are checked by OfflineCalculator.calculate.
            return new OfflineCalculator.InputLine(id,name,unit,quantityMilli,unitPriceFils,taxRateBps);
        }
    }

    public final String authorityId, snapshotId, organizationId, branchId, deviceId, actorId,
        shiftId, keyEpoch, deviceKeySha256, snapshotSha256, authoritySha256, invoicePrefix;
    public final long firstInvoice,lastInvoice,maxInvoiceTotalFils,maxGrossFils,issuedAtMs,notBeforeMs,expiresAtMs;
    public final boolean cashAllowed,recordedCardAllowed,mixedTenderAllowed;
    private final byte[] frozenSnapshot,frozenAuthority,frozenProfile;
    private final String originalSnapshotEnvelope,originalAuthorityEnvelope;
    private final Map<String,Product> productMap;
    private final List<Product> productList;

    private OfflineBundle(SignedProtocol.Verified snapshotProof, SignedProtocol.Verified authorityProof,
                          String snapshotEnvelope, String authorityEnvelope, Binding expected) throws Exception {
        JSONObject s=object(snapshotProof.payload()),a=object(authorityProof.payload());
        fields(s,"kind","schemaVersion","id","organizationId","branchId","createdAt","profile","products","calculationVersion","offers");
        literal(s,"kind","offline-snapshot");integer(s,"schemaVersion",1,1);literal(s,"calculationVersion","offline-line-v1");
        snapshotId=uuid(s,"id");organizationId=uuid(s,"organizationId");branchId=uuid(s,"branchId");
        long created=utcMillis(string(s,"createdAt"));
        JSONObject profile=object(s.get("profile"));validateProfile(profile);
        equal(organizationId,string(profile,"organizationId"));equal(branchId,string(profile,"branchId"));
        JSONArray offers=array(s.get("offers"));if(offers.length()!=0)throw invalid();
        JSONArray rows=array(s.get("products"));if(rows.length()<1||rows.length()>2000)throw invalid();
        LinkedHashMap<String,Product> products=new LinkedHashMap<>();
        for(int i=0;i<rows.length();i++) {
            Product p=new Product(object(rows.get(i)));
            if(products.put(p.id,p)!=null)throw invalid();
        }
        fields(a,"kind","schemaVersion","id","organizationId","branchId","deviceId","actorId","deviceKeySha256","keyEpoch","shiftId","snapshotId","snapshotSha256","issuedAt","notBefore","expiresAt","invoiceRange","maxInvoiceTotalFils","maxGrossFils","permissions","policy");
        literal(a,"kind","offline-authority");integer(a,"schemaVersion",1,1);
        authorityId=uuid(a,"id");equal(organizationId,uuid(a,"organizationId"));equal(branchId,uuid(a,"branchId"));
        deviceId=uuid(a,"deviceId");actorId=uuid(a,"actorId");shiftId=uuid(a,"shiftId");keyEpoch=uuid(a,"keyEpoch");
        deviceKeySha256=hash(a,"deviceKeySha256");equal(snapshotId,uuid(a,"snapshotId"));
        snapshotSha256=snapshotProof.payloadSha256;authoritySha256=authorityProof.payloadSha256;
        equal(snapshotSha256,hash(a,"snapshotSha256"));
        issuedAtMs=utcMillis(string(a,"issuedAt"));notBeforeMs=utcMillis(string(a,"notBefore"));expiresAtMs=utcMillis(string(a,"expiresAt"));
        if(created>issuedAtMs||notBeforeMs<issuedAtMs||expiresAtMs<=notBeforeMs||expiresAtMs-issuedAtMs>86_400_000)throw invalid();
        JSONObject range=object(a.get("invoiceRange"));fields(range,"prefix","first","last");
        invoicePrefix=string(range,"prefix");if(!invoicePrefix.matches("[A-Z0-9]{2,16}"))throw invalid();
        firstInvoice=integer(range,"first",1,9_999_999_999L);lastInvoice=integer(range,"last",1,9_999_999_999L);
        long count=lastInvoice-firstInvoice+1;if(count<1||count>1000)throw invalid();
        maxInvoiceTotalFils=integer(a,"maxInvoiceTotalFils",1,100_000_000);
        maxGrossFils=integer(a,"maxGrossFils",1,100_000_000_000L);
        if(maxGrossFils>count*maxInvoiceTotalFils)throw invalid();
        JSONObject tenders=object(a.get("permissions"));fields(tenders,"cash","recordedCard","mixedTender");
        cashAllowed=bool(tenders,"cash");recordedCardAllowed=bool(tenders,"recordedCard");mixedTenderAllowed=bool(tenders,"mixedTender");
        if((!cashAllowed&&!recordedCardAllowed)||(mixedTenderAllowed&&(!cashAllowed||!recordedCardAllowed)))throw invalid();
        JSONObject policy=object(a.get("policy"));fields(policy,"refunds","sharedTabs","offers");
        for(String name:new String[]{"refunds","sharedTabs","offers"})literal(policy,name,"online-only");
        equal(organizationId,expected.organizationId);equal(branchId,expected.branchId);equal(deviceId,expected.deviceId);
        equal(actorId,expected.actorId);equal(shiftId,expected.shiftId);equal(keyEpoch,expected.keyEpoch);equal(deviceKeySha256,expected.deviceKeySha256);
        frozenSnapshot=snapshotProof.bytes();frozenAuthority=authorityProof.bytes();frozenProfile=CanonicalJson.bytes(profile);
        originalSnapshotEnvelope=snapshotEnvelope;originalAuthorityEnvelope=authorityEnvelope;
        productMap=Collections.unmodifiableMap(products);productList=Collections.unmodifiableList(new ArrayList<>(products.values()));
    }

    public static OfflineBundle verify(String snapshotEnvelope,String authorityEnvelope,
                                       Map<String,PublicKey> trustedServerKeys,Binding expected) throws Exception {
        if(expected==null||trustedServerKeys==null||trustedServerKeys.isEmpty())throw invalid();
        Map<String,PublicKey> keys=Collections.unmodifiableMap(new HashMap<>(trustedServerKeys));
        SignedProtocol.Verified snapshot=SignedProtocol.verify(snapshotEnvelope,keys);
        SignedProtocol.Verified authority=SignedProtocol.verify(authorityEnvelope,keys);
        return new OfflineBundle(snapshot,authority,snapshotEnvelope,authorityEnvelope,expected);
    }

    public JSONObject snapshot() throws Exception { return object(CanonicalJson.parse(frozenSnapshot)); }
    public JSONObject authority() throws Exception { return object(CanonicalJson.parse(frozenAuthority)); }
    public JSONObject profile() throws Exception { return object(CanonicalJson.parse(frozenProfile)); }
    public byte[] snapshotBytes() { return frozenSnapshot.clone(); }
    public byte[] authorityBytes() { return frozenAuthority.clone(); }
    public String snapshotEnvelope() { return originalSnapshotEnvelope; }
    public String authorityEnvelope() { return originalAuthorityEnvelope; }
    public List<Product> products() { return productList; }
    public Product product(String id) { Product p=productMap.get(id);if(p==null)throw invalid();return p; }

    private static void validateProfile(JSONObject p) throws Exception {
        fields(p,"id","organizationId","branchId","legalName","branchName","address","phone","trn","taxRegistered","currency","timezone","taxInclusive","calculationVersion","confirmedBy","confirmedAt");
        for(String name:new String[]{"id","organizationId","branchId","confirmedBy"})uuid(p,name);
        text(p,"legalName",200);text(p,"branchName",120);text(p,"address",400);text(p,"phone",30);
        if(!string(p,"trn").matches("[0-9]{15}")||!bool(p,"taxRegistered")||!bool(p,"taxInclusive"))throw invalid();
        literal(p,"currency","AED");literal(p,"timezone","Asia/Dubai");literal(p,"calculationVersion","line-v2");
        String confirmed=string(p,"confirmedAt");if(!PROFILE_TIME.matcher(confirmed).matches())throw invalid();
        dateParts(confirmed);timeParts(confirmed);
    }
    private static JSONObject object(Object value) { if(!(value instanceof JSONObject))throw invalid();return (JSONObject)value; }
    private static JSONArray array(Object value) { if(!(value instanceof JSONArray))throw invalid();return (JSONArray)value; }
    private static void fields(JSONObject o,String... names) { if(o.length()!=names.length)throw invalid();for(String name:names)if(!o.has(name))throw invalid(); }
    private static String string(JSONObject o,String name) throws Exception { Object v=o.get(name);if(!(v instanceof String))throw invalid();return (String)v; }
    private static void literal(JSONObject o,String name,String expected) throws Exception { equal(expected,string(o,name)); }
    private static boolean bool(JSONObject o,String name) throws Exception { Object v=o.get(name);if(!(v instanceof Boolean))throw invalid();return (Boolean)v; }
    private static long integer(JSONObject o,String name,long min,long max) throws Exception {
        Object v=o.get(name);if(!(v instanceof Byte||v instanceof Short||v instanceof Integer||v instanceof Long))throw invalid();
        long n=((Number)v).longValue();if(n<min||n>max)throw invalid();return n;
    }
    private static String uuid(JSONObject o,String name) throws Exception { String v=string(o,name);requireUuid(v);return v; }
    private static String hash(JSONObject o,String name) throws Exception { String v=string(o,name);requireHash(v);return v; }
    private static void requireUuid(String v) { if(v==null||!UUID.matcher(v).matches())throw invalid(); }
    private static void requireHash(String v) { if(v==null||!HASH.matcher(v).matches())throw invalid(); }
    private static void equal(String left,String right) { if(!left.equals(right))throw invalid(); }
    private static String text(JSONObject o,String name,int max) throws Exception {
        String v=string(o,name);if(v.isEmpty()||v.length()>max||trimChar(v.charAt(0))||trimChar(v.charAt(v.length()-1)))throw invalid();return v;
    }
    /** ECMAScript String.trim whitespace, not Java's smaller ASCII trim set. */
    private static boolean trimChar(char c) {
        return (c>=9&&c<=13)||c==32||c==0xA0||c==0x1680||(c>=0x2000&&c<=0x200A)||c==0x2028||c==0x2029||c==0x202F||c==0x205F||c==0x3000||c==0xFEFF;
    }
    private static int number(String s,int start,int end) { return Integer.parseInt(s.substring(start,end)); }
    private static int[] dateParts(String s) {
        int y=number(s,0,4),m=number(s,5,7),d=number(s,8,10);
        boolean leap=y%4==0&&(y%100!=0||y%400==0);
        int[] days={31,leap?29:28,31,30,31,30,31,31,30,31,30,31};
        if(m<1||m>12||d<1||d>days[m-1])throw invalid();return new int[]{y,m,d};
    }
    private static int[] timeParts(String s) {
        int h=number(s,11,13),m=number(s,14,16),second=s.charAt(16)==':'?number(s,17,19):0;
        if(h>23||m>59||second>59)throw invalid();return new int[]{h,m,second};
    }
    private static long utcMillis(String s) {
        if(!UTC_MILLIS.matcher(s).matches())throw invalid();int[] date=dateParts(s),time=timeParts(s);
        // java.time needs API26 without desugaring; the app supports API24. A strictly
        // proleptic Gregorian calendar also handles protocol year0000 as 1 BCE.
        GregorianCalendar c=new GregorianCalendar(TimeZone.getTimeZone("UTC"),Locale.ROOT);
        c.setGregorianChange(new Date(Long.MIN_VALUE));c.setLenient(false);c.clear();
        c.set(GregorianCalendar.ERA,date[0]==0?GregorianCalendar.BC:GregorianCalendar.AD);
        c.set(GregorianCalendar.YEAR,date[0]==0?1:date[0]);c.set(GregorianCalendar.MONTH,date[1]-1);c.set(GregorianCalendar.DAY_OF_MONTH,date[2]);
        c.set(GregorianCalendar.HOUR_OF_DAY,time[0]);c.set(GregorianCalendar.MINUTE,time[1]);c.set(GregorianCalendar.SECOND,time[2]);c.set(GregorianCalendar.MILLISECOND,number(s,20,23));
        return c.getTimeInMillis();
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("Invalid offline authority bundle."); }
}
