package info.internext.pos.storage;

import android.content.Context;
import info.internext.pos.access.AccessContext;
import org.json.JSONArray;
import org.json.JSONObject;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Locale;

/** Native-only credentials/session owner. The bridge receives display context, never tokens.
 * Every mutation is serialized, and uncertain enrollment reuses its persisted binding/body. */
public final class NativeSession {
    private final SecureSessionStore store;
    private final NativePosHttp http;
    private final NativeJournal journal;
    public NativeSession(Context context,NativeJournal journal)throws Exception{
        this.store=new SecureSessionStore(context);this.http=new NativePosHttp(store);this.journal=journal;
        custody(store.read());
    }
    NativeSession(SecureSessionStore store,NativePosHttp http,NativeJournal journal)throws Exception{
        this.store=store;this.http=http;this.journal=journal;custody(store.read());
    }
    private void custody(JSONObject state)throws Exception{
        if(journal.hasCustody()&&state.isNull("counter"))throw new NativeAccessError("native_storage_unavailable");
    }
    private static JSONObject signedOut()throws Exception{
        return new JSONObject().put("schemaVersion",1).put("status","signed_out").put("actorId",JSONObject.NULL).put("branches",new JSONArray()).put("device",JSONObject.NULL).put("canPrepareOffline",false);
    }
    public synchronized JSONObject getAccessState()throws Exception{
        JSONObject state=store.read();custody(state);
        if(state.getBoolean("logoutPending"))return signedOut();
        if(state.isNull("actorId")){
            // A killed process can leave login cookies before its actor response was accepted.
            // Require explicit logout, rather than silently adopting an unidentified session.
            if(hasSession(state)){state.put("logoutPending",true);store.write(state);}
            return signedOut();
        }
        String actor=state.getString("actorId");JSONObject access;
        try{access=AccessContext.parse(http.request("GET","/api/pos/native/access",null).toString(),actor);}
        catch(NativeAccessError error){
            if(error.code.equals("native_session_expired")){JSONObject current=store.read();clearSession(current);store.write(current);}
            throw error;
        }
        if(!access.getString("status").equals("signed_in"))throw new NativeAccessError("native_access_unavailable");
        state=store.read();custody(state); // Cookie rotation may have persisted a newer state.
        JSONObject counter=state.optJSONObject("counter"),pending=state.optJSONObject("enrollment"),device=access.optJSONObject("device");
        if(counter!=null&&(!counter.getString("actorId").equals(actor)||device==null||!sameDevice(counter,device)))throw new NativeAccessError("native_counter_account_required");
        if(pending!=null&&(!pending.getString("actorId").equals(actor)||(device!=null&&!pending.getString("branchId").equals(device.getString("branchId")))))throw new NativeAccessError("native_enrollment_uncertain");
        if(device!=null){
            // A server binding must be one this app previously enrolled or was enrolling.
            if(counter==null&&pending==null)throw new NativeAccessError("native_counter_account_required");
            state.put("counter",counter(actor,device)).put("enrollment",JSONObject.NULL);store.write(state);
        }
        return access;
    }
    public synchronized JSONObject signIn(String email,char[] password)throws Exception{
        try{
            JSONObject state=store.read();custody(state);
            if(state.getBoolean("logoutPending")||(state.isNull("actorId")&&hasSession(state))){state.put("logoutPending",true);store.write(state);throw new NativeAccessError("native_sign_out_pending");}
            if(!state.isNull("actorId"))return getAccessState();
            if(email==null||email.trim().isEmpty()||email.length()>254||password==null||password.length<1||password.length>256)throw new NativeAccessError("native_authentication_failed");
            String actor;
            try{actor=AccessContext.sessionActor(http.request("POST","/api/pos/session",new JSONObject().put("email",email.trim().toLowerCase(Locale.ROOT)).put("password",new String(password))).toString());}
            catch(Exception error){
                JSONObject current=store.read();if(hasSession(current)){current.put("logoutPending",true);store.write(current);throw new NativeAccessError("native_sign_out_pending");}throw error;
            }
            state=store.read();state.put("actorId",actor);JSONObject counter=state.optJSONObject("counter"),pending=state.optJSONObject("enrollment");
            if((counter!=null&&!actor.equals(counter.getString("actorId")))||(pending!=null&&!actor.equals(pending.getString("actorId")))){
                state.put("logoutPending",true);store.write(state);
                try{signOut();}catch(Exception ignored){/* Pending state requires explicit completion. */}
                throw new NativeAccessError("native_counter_account_required");
            }
            store.write(state);return getAccessState();
        }finally{if(password!=null)Arrays.fill(password,'\0');}
    }
    public synchronized JSONObject signOut()throws Exception{
        JSONObject state=store.read();custody(state);state.put("logoutPending",true);store.write(state);
        try{
            JSONObject result=http.request("DELETE","/api/pos/session",null);
            if(result.length()!=1||!"signed_out".equals(result.optString("status")))throw new NativeAccessError("native_access_unavailable");
            state=store.read();clearSession(state);state.put("logoutPending",false);store.write(state);return signedOut();
        }catch(Exception error){throw new NativeAccessError("native_sign_out_pending");}
    }
    public synchronized JSONObject enrollCounter(String branchId,String name)throws Exception{
        name=trimName(name);
        if(branchId==null||!branchId.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")||name==null||name.isEmpty()||name.length()>80||name.chars().anyMatch(Character::isISOControl))throw new NativeAccessError("native_access_unavailable");
        JSONObject access=getAccessState();
        if(!access.getString("status").equals("signed_in"))throw new NativeAccessError("native_session_expired");
        String actor=access.getString("actorId");boolean manager=false;JSONArray branches=access.getJSONArray("branches");
        for(int i=0;i<branches.length();i++){JSONObject branch=branches.getJSONObject(i);if(branch.getString("id").equals(branchId)&&("owner".equals(branch.getString("role"))||"manager".equals(branch.getString("role"))))manager=true;}
        if(!manager)throw new NativeAccessError("native_authentication_failed");
        JSONObject state=store.read(),counter=state.optJSONObject("counter"),pending=state.optJSONObject("enrollment");custody(state);
        if(counter!=null){if(counter.getString("actorId").equals(actor)&&counter.getString("branchId").equals(branchId))return access;throw new NativeAccessError("native_counter_account_required");}
        if(pending!=null&&(!actor.equals(pending.getString("actorId"))||!branchId.equals(pending.getString("branchId"))||!name.equals(pending.getString("name"))))throw new NativeAccessError("native_enrollment_uncertain");
        String cookie="pos-device-"+actor;JSONObject cookies=state.getJSONObject("cookies");
        if(!cookies.has(cookie)){
            if(pending!=null)throw new NativeAccessError("native_storage_unavailable");
            byte[] entropy=new byte[32];new SecureRandom().nextBytes(entropy);StringBuilder token=new StringBuilder(64);for(byte b:entropy)token.append(String.format(Locale.ROOT,"%02x",b&255));Arrays.fill(entropy,(byte)0);cookies.put(cookie,token.toString());
        }
        if(!cookies.getString(cookie).matches("[a-f0-9]{64}"))throw new NativeAccessError("native_storage_unavailable");
        state.put("enrollment",new JSONObject().put("actorId",actor).put("branchId",branchId).put("name",name));store.write(state);
        try{
            JSONObject device=AccessContext.enrollment(http.request("POST","/api/pos/native/device",new JSONObject().put("branchId",branchId).put("name",name)).toString(),branchId);
            state=store.read();state.put("counter",counter(actor,device)).put("enrollment",JSONObject.NULL);store.write(state);
            return getAccessState();
        }catch(Exception error){throw new NativeAccessError("native_enrollment_uncertain");}
    }
    // Match ECMAScript String.trim used by the server before freezing an enrollment.
    private static String trimName(String value){
        if(value==null)return null;int start=0,end=value.length();while(start<end&&trimSpace(value.charAt(start)))start++;while(end>start&&trimSpace(value.charAt(end-1)))end--;return value.substring(start,end);
    }
    private static boolean trimSpace(char c){return (c>=9&&c<=13)||c==32||c==160||c==0x1680||(c>=0x2000&&c<=0x200A)||c==0x2028||c==0x2029||c==0x202F||c==0x205F||c==0x3000||c==0xFEFF;}
    // Internal native preparation host only. No bridge may return these snapshots or tokens.
    synchronized JSONObject nativeState()throws Exception{JSONObject value=store.read();custody(value);return value;}
    synchronized void saveOffline(JSONObject value)throws Exception{JSONObject current=store.read();custody(current);current.put("offline",value);store.write(current);}
    /** Compare only preparation custody; retain current rotated tokens and other session fields. */
    synchronized boolean compareAndSetOffline(JSONObject expected,JSONObject replacement)throws Exception{
        JSONObject current=store.read();custody(current);
        if(current.isNull("actorId")||current.getBoolean("logoutPending"))throw new NativeAccessError("native_session_expired");
        if(!current.getString("actorId").equals(expected.getJSONObject("scope").getString("actorId")))throw new NativeAccessError("offline_context_changed");
        JSONObject saved=current.optJSONObject("offline");
        if(saved==null||!NativePreparationTransition.canonical(saved).equals(NativePreparationTransition.canonical(expected)))return false;
        current.put("offline",replacement);store.write(current);return true;
    }
    synchronized JSONObject nativeRequest(String method,String path,JSONObject body)throws Exception{
        JSONObject current=store.read();custody(current);if(current.isNull("actorId")||current.getBoolean("logoutPending"))throw new NativeAccessError("native_session_expired");
        return http.request(method,path,body);
    }
    /** Historical signed evidence remains uploadable after sign-out or access revocation. */
    synchronized JSONObject historicalRequest(String path,JSONObject envelope)throws Exception{
        if(!path.equals("/api/pos/offline/import")&&!path.equals("/api/pos/offline/seal")&&!path.equals("/api/pos/offline/bundle-recovery")&&!path.equals("/api/pos/offline/payment-freeze")&&!path.equals("/api/pos/offline/payment-resolution"))throw new NativeAccessError("native_access_unavailable");
        return http.request("POST",path,envelope);
    }
    private static boolean sameDevice(JSONObject a,JSONObject b)throws Exception{return a.getString("id").equals(b.getString("id"))&&a.getString("branchId").equals(b.getString("branchId"));}
    private static JSONObject counter(String actor,JSONObject device)throws Exception{return AccessContext.device(device).put("actorId",actor);}
    private static boolean hasSession(JSONObject state)throws Exception{JSONObject cookies=state.getJSONObject("cookies");return cookies.has("pos-access")||cookies.has("pos-refresh");}
    private static void clearSession(JSONObject state)throws Exception{state.put("actorId",JSONObject.NULL);state.getJSONObject("cookies").remove("pos-access");state.getJSONObject("cookies").remove("pos-refresh");}
}
