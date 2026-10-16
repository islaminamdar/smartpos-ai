package info.internext.pos.access;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class AccessContextTest {
    private static final String ACTOR = "11111111-1111-4111-8111-111111111111";
    private static final String BRANCH = "22222222-2222-4222-8222-222222222222";
    private static final String OTHER = "33333333-3333-4333-8333-333333333333";
    private static final String DEVICE = "44444444-4444-4444-8444-444444444444";
    private JSONObject device() throws Exception {
        return new JSONObject().put("id",DEVICE).put("branchId",BRANCH).put("name","Counter 1");
    }
    private JSONObject valid() throws Exception {
        JSONObject branch = new JSONObject().put("id",BRANCH).put("organizationId",OTHER)
            .put("name","Burdubai — محل").put("role","manager");
        return new JSONObject().put("schemaVersion",1).put("status","signed_in").put("actorId",ACTOR)
            .put("branches",new JSONArray().put(branch)).put("device",device()).put("canPrepareOffline",false);
    }
    private void bad(String raw) throws Exception {
        try { AccessContext.parse(raw,ACTOR); fail("Accepted invalid access response"); }
        catch (IllegalArgumentException expected) { }
    }
    @Test public void permitsOrdinaryHttpJsonWhitespaceAndReturnsFreshObject() throws Exception {
        JSONObject original = valid(); String raw = original.toString(2);
        JSONObject parsed = AccessContext.parse(" \n" + raw + "\t",ACTOR);
        assertEquals(ACTOR,parsed.getString("actorId"));
        parsed.getJSONArray("branches").getJSONObject(0).put("name","changed");
        assertEquals("Burdubai — محل",AccessContext.parse(raw,ACTOR).getJSONArray("branches").getJSONObject(0).getString("name"));
    }
    @Test public void signedOutHasNoRetainedIdentity() throws Exception {
        JSONObject input = valid().put("status","signed_out").put("actorId",JSONObject.NULL)
            .put("device",JSONObject.NULL).put("branches",new JSONArray());
        assertEquals("signed_out",AccessContext.parse(input.toString(),ACTOR).getString("status"));
        bad(input.put("actorId",ACTOR).toString());
        bad(input.put("actorId",JSONObject.NULL).put("device",device()).toString());
    }
    @Test public void refusesOfflineCapabilityWithoutSeparateAuthorityContract() throws Exception {
        bad(valid().put("canPrepareOffline",true).toString());
        bad(valid().put("canPrepareOffline","false").toString());
        bad(valid().put("canPrepareOffline",0).toString());
    }
    @Test public void sessionActorMustMatch() throws Exception {
        bad(valid().put("actorId",OTHER).toString());
        assertEquals(OTHER,AccessContext.parse(valid().put("actorId",OTHER).toString(),null).getString("actorId"));
        bad(valid().put("actorId",JSONObject.NULL).toString());
    }
    @Test public void refusesDuplicateUnknownAndMissingFields() throws Exception {
        String raw = valid().toString();
        bad(raw.substring(0,raw.length()-1)+",\"status\":\"signed_in\"}");
        bad(valid().put("accessToken","secret").toString());
        JSONObject missing = valid(); missing.remove("device"); bad(missing.toString());
        JSONObject branch = valid(); branch.getJSONArray("branches").getJSONObject(0).put("canSell",true); bad(branch.toString());
    }
    @Test public void refusesTypeCoercionAndNonIntegerSchema() throws Exception {
        bad(valid().put("schemaVersion","1").toString());
        bad(valid().toString().replace("\"schemaVersion\":1","\"schemaVersion\":1.0"));
        bad(valid().put("branches","[]").toString());
        bad(valid().put("device",false).toString());
        bad(valid().put("status",true).toString());
    }
    @Test public void validatesMembershipAndUniqueBranchIds() throws Exception {
        JSONObject duplicate = valid();
        duplicate.getJSONArray("branches").put(duplicate.getJSONArray("branches").getJSONObject(0)); bad(duplicate.toString());
        bad(valid().put("device",device().put("branchId",OTHER)).toString());
        bad(valid().put("branches",new JSONArray()).toString());
        bad(valid().put("branches",new JSONArray()).put("device",JSONObject.NULL).toString());
    }
    @Test public void validatesRolesUuidNamesAndBounds() throws Exception {
        for (String role : new String[]{"admin","Manager","","owner\n"}) {
            JSONObject value = valid(); value.getJSONArray("branches").getJSONObject(0).put("role",role); bad(value.toString());
        }
        bad(valid().put("actorId","11111111-1111-4111-8111-11111111111G").toString());
        bad(valid().put("device",device().put("name","\nCounter")).toString());
        bad(valid().put("device",device().put("name","x".repeat(81))).toString());
        bad(valid().put("device",device().put("name",12)).toString());
        bad(" ".repeat(AccessContext.MAX_BYTES)+valid());
        JSONObject many = valid(); JSONArray branches = many.getJSONArray("branches");
        for(int i=0;i<500;i++) branches.put(branches.getJSONObject(0)); bad(many.toString());
    }
    @Test public void rejectsLenientJsonGrammarAndMalformedUnicode() throws Exception {
        bad("/* comment */"+valid());
        bad(valid().toString().replace("\"signed_in\"","'signed_in'"));
        bad(valid().toString()+"{}");
        bad(valid().toString().replace("Counter 1","\\ud800"));
    }
    @Test public void sessionResponseIsStrictAndActorCanonical() throws Exception {
        String response = new JSONObject().put("status","authenticated").put("userId",ACTOR).toString();
        assertEquals(ACTOR,AccessContext.sessionActor(response));
        for(String raw:new String[]{response.replace("authenticated","signed_in"),response.replace(ACTOR,"bad"),response.replace("}",",\"password\":\"bad\"}")}) {
            try { AccessContext.sessionActor(raw); fail(); } catch(IllegalArgumentException expected) { }
        }
    }
    @Test public void enrollmentBindsExpectedBranchAndClonesDevice() throws Exception {
        JSONObject original = device(); JSONObject copy = AccessContext.device(original);
        original.put("name","changed"); assertEquals("Counter 1",copy.getString("name"));
        String raw = new JSONObject().put("status","enrolled").put("device",copy).toString();
        assertEquals(DEVICE,AccessContext.enrollment(raw,BRANCH).getString("id"));
        try { AccessContext.enrollment(raw,OTHER); fail(); } catch(IllegalArgumentException expected) { }
        try { AccessContext.device(original.put("token","bad")); fail(); } catch(IllegalArgumentException expected) { }
    }
}
