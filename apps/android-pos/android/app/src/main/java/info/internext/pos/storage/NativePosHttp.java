package info.internext.pos.storage;

import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.SignedProtocol;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.net.CookieHandler;
import android.os.SystemClock;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Fixed-origin native HTTPS. No redirects, caller URLs, global cookie manager or TLS bypass. */
final class NativePosHttp {
    static final String ORIGIN="https://pos.internext.info";
    interface ConnectionFactory { HttpsURLConnection open(URL url)throws Exception; }
    private final SecureSessionStore store;private final ConnectionFactory connection;
    NativePosHttp(SecureSessionStore store){this(store,url->(HttpsURLConnection)url.openConnection());}
    NativePosHttp(SecureSessionStore store,ConnectionFactory connection){this.store=store;this.connection=connection;}
    synchronized JSONObject request(String method,String path,JSONObject body)throws Exception{
        if(!allowed(method,path)||((method.equals("POST"))!=(body!=null)))throw new NativeAccessError("native_access_unavailable");
        boolean historical=path.equals("/api/pos/offline/import")||path.equals("/api/pos/offline/seal")||path.equals("/api/pos/offline/bundle-recovery")||path.equals("/api/pos/offline/payment-freeze")||path.equals("/api/pos/offline/payment-resolution");
        byte[] bytes=body==null?null:requestBytes(body,path,historical);if(bytes!=null&&bytes.length>requestLimit(path))throw new NativeAccessError("native_access_unavailable");
        HttpsURLConnection c=null;long deadline=SystemClock.elapsedRealtime()+30000;
        try{
            if(CookieHandler.getDefault()!=null)throw new NativeAccessError("native_access_unavailable");
            c=connection.open(new URL(ORIGIN+path));c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(15000);c.setUseCaches(false);c.setRequestMethod(method);c.setRequestProperty("Accept","application/json");c.setRequestProperty("Accept-Encoding","identity");c.setRequestProperty("Origin",ORIGIN);
            if(!historical){String cookies=cookieHeader(store.read().getJSONObject("cookies"));if(!cookies.isEmpty())c.setRequestProperty("Cookie",cookies);}
            if(bytes!=null){c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");c.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=c.getOutputStream()){out.write(bytes);}}
            int status=c.getResponseCode();checkDeadline(deadline);if(status>=300&&status<400)throw new NativeAccessError("native_access_unavailable");
            // A refresh token can rotate on any authenticated route. Save headers before reading
            // the body, even for errors, so a truncated response cannot discard the new token.
            if(!historical)applyCookies(c.getHeaderFields());
            if(status==401)throw new NativeAccessError(historical?"native_access_unavailable":path.equals("/api/pos/session")&&method.equals("POST")?"native_authentication_failed":"native_session_expired");
            if(status==409&&method.equals("POST")&&path.equals("/api/pos/offline/enroll")){
                JSONObject error=readJson(c,deadline,1024,true);
                // This exact route/status/body and digest binds a definitive pre-insert SQL
                // rejection to THIS attempted request. Any other outcome remains uncertain.
                if(error.length()==4&&"not_enrolled".equals(error.opt("status"))&&"offline_enrollment_proof_expired".equals(error.opt("code"))
                    &&body.get("requestId") instanceof String&&((String)body.get("requestId")).matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
                    &&body.get("requestId").equals(error.opt("requestId"))&&SignedProtocol.hash(bytes).equals(error.opt("requestSha256")))
                    throw new NativeAccessError("offline_enrollment_proof_expired");
                throw new NativeAccessError("native_access_unavailable");
            }
            if(status==409&&method.equals("POST")&&path.equals("/api/pos/offline/import")){
                JSONObject error=readJson(c,deadline,1024,true);
                if(error.length()==3&&"reconciliation_required".equals(error.opt("status"))&&error.opt("exceptionId") instanceof String
                    &&error.getString("exceptionId").matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")&&error.opt("code") instanceof String
                    &&Arrays.asList("bundle","collision","state","sealed","scope","time","chain","number","calculation","budget","payment","ack","storage_conflict","invalid_historical_receipt","unsupported_text").contains(error.getString("code")))return error;
                throw new NativeAccessError("native_access_unavailable");
            }
            if(status<200||status>=300)throw new NativeAccessError(status==429?"native_access_unavailable":status==403?"native_authentication_failed":"native_access_unavailable");
            return readJson(c,deadline,responseLimit(path),false);
        }catch(NativeAccessError error){throw error;}catch(java.nio.charset.CharacterCodingException error){throw new NativeAccessError("native_access_unavailable");}catch(java.io.IOException error){throw new NativeAccessError("native_network_unavailable");}catch(Exception error){throw new NativeAccessError("native_access_unavailable");}
        finally{if(bytes!=null)Arrays.fill(bytes,(byte)0);if(c!=null)c.disconnect();}
    }
    private static byte[] requestBytes(JSONObject body,String path,boolean historical)throws NativeAccessError{
        try{
            if(!historical)return CanonicalJson.bytes(body);
            // The envelope can exceed the decoded signed-payload limit because of base64.
            // Only its transport wrapper is encoded here; signed payload/signature strings
            // are preserved exactly and strict JSON still enforces depth/Unicode/size limits.
            String text=body.toString();CanonicalJson.transport(text,requestLimit(path));return text.getBytes(StandardCharsets.UTF_8);
        }catch(Exception error){throw new NativeAccessError("native_access_unavailable");}
    }
    private static JSONObject readJson(HttpsURLConnection c,long deadline,int limit,boolean errorStream)throws Exception{
            String contentType=c.getContentType();if(contentType==null||!contentType.split(";",2)[0].trim().toLowerCase(Locale.ROOT).equals("application/json"))throw new NativeAccessError("native_access_unavailable");
            String encoding=c.getHeaderField("Content-Encoding");if(encoding!=null&&!encoding.equalsIgnoreCase("identity"))throw new NativeAccessError("native_access_unavailable");
            if(c.getContentLengthLong()>limit)throw new NativeAccessError("native_access_unavailable");
            ByteArrayOutputStream output=new ByteArrayOutputStream();try(InputStream in=errorStream?c.getErrorStream():c.getInputStream()){if(in==null)throw new NativeAccessError("native_access_unavailable");byte[] buffer=new byte[4096];int n;while(true){checkDeadline(deadline);n=in.read(buffer);checkDeadline(deadline);if(n==-1)break;if(output.size()+n>limit)throw new NativeAccessError("native_access_unavailable");output.write(buffer,0,n);}}
            String raw=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output.toByteArray())).toString();
            Object parsed=CanonicalJson.transport(raw,limit);if(!(parsed instanceof JSONObject))throw new NativeAccessError("native_access_unavailable");return (JSONObject)parsed;
    }
    private static int requestLimit(String path){return (path.equals("/api/pos/native/continuation")||path.equals("/api/pos/native/shift-close"))?1024:path.equals("/api/pos/offline/payment-freeze")?1_420_000:path.equals("/api/pos/offline/payment-resolution")?16384:path.equals("/api/pos/offline/import")?1_400_000:(path.equals("/api/pos/offline/enroll")||path.equals("/api/pos/offline/seal")||path.equals("/api/pos/offline/bundle-recovery"))?16384:path.equals("/api/pos/native/prepare")?8192:2048;}
    private static int responseLimit(String path){return (path.equals("/api/pos/offline/payment-freeze")||path.equals("/api/pos/offline/payment-resolution"))?1_420_000:(path.equals("/api/pos/native/prepare")||path.equals("/api/pos/offline/bundle-recovery"))?2_900_000:path.equals("/api/pos/offline/import")?1_400_000:path.equals("/api/pos/offline/seal")?16384:131072;}
    private static void checkDeadline(long deadline)throws NativeAccessError{if(SystemClock.elapsedRealtime()>=deadline)throw new NativeAccessError("native_network_unavailable");}
    private static boolean allowed(String method,String path){return (method.equals("POST")&&(path.equals("/api/pos/native/preparation")||path.equals("/api/pos/native/continuation")||path.equals("/api/pos/native/shift-close")||path.equals("/api/pos/native/prepare")||path.equals("/api/pos/offline/enroll")||path.equals("/api/pos/offline/import")||path.equals("/api/pos/offline/seal")||path.equals("/api/pos/offline/bundle-recovery")||path.equals("/api/pos/offline/payment-freeze")||path.equals("/api/pos/offline/payment-resolution")||path.equals("/api/pos/commands")))||(path.equals("/api/pos/session")&&(method.equals("POST")||method.equals("DELETE")))||(path.equals("/api/pos/native/access")&&method.equals("GET"))||(path.equals("/api/pos/native/device")&&method.equals("POST"));}
    static boolean nameAllowed(String name){return name.equals("pos-access")||name.equals("pos-refresh")||name.matches("pos-device-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");}
    private static String cookieHeader(JSONObject cookies)throws Exception{
        StringBuilder result=new StringBuilder();Iterator<String> keys=cookies.keys();while(keys.hasNext()){String name=keys.next();Object value=cookies.get(name);if(!nameAllowed(name)||!(value instanceof String)||!validValue((String)value))throw new NativeAccessError("native_storage_unavailable");if(result.length()>0)result.append("; ");result.append(name).append('=').append(value);}if(result.length()>24000)throw new NativeAccessError("native_storage_unavailable");return result.toString();
    }
    private static boolean validValue(String value){return value.length()>0&&value.length()<=8192&&value.matches("[A-Za-z0-9._~-]+");}
    private void applyCookies(Map<String,List<String>> headers)throws Exception{
        JSONObject data=store.read(),cookies=data.getJSONObject("cookies");boolean changed=false;
        for(Map.Entry<String,List<String>> header:headers.entrySet()){
            if(header.getKey()==null||!header.getKey().equalsIgnoreCase("Set-Cookie"))continue;
            for(String raw:header.getValue()){
                if(raw==null||raw.length()>10000)throw new NativeAccessError("native_access_unavailable");String[] parts=raw.split(";");int equals=parts[0].indexOf('=');if(equals<1)throw new NativeAccessError("native_access_unavailable");String name=parts[0].substring(0,equals).trim(),value=parts[0].substring(equals+1).trim();if(!nameAllowed(name))continue;
                boolean secure=false,httpOnly=false,path=false,remove=false;
                for(int i=1;i<parts.length;i++){String attr=parts[i].trim();int e=attr.indexOf('=');String key=(e<0?attr:attr.substring(0,e)).toLowerCase(Locale.ROOT),v=e<0?"":attr.substring(e+1);
                    if(key.equals("secure"))secure=true;else if(key.equals("httponly"))httpOnly=true;else if(key.equals("path")){if(!v.equals("/"))throw new NativeAccessError("native_access_unavailable");path=true;}
                    else if(key.equals("domain")&&!v.equalsIgnoreCase("pos.internext.info"))throw new NativeAccessError("native_access_unavailable");
                    else if(key.equals("max-age")){try{remove=Long.parseLong(v)<=0;}catch(NumberFormatException error){throw new NativeAccessError("native_access_unavailable");}}
                }
                if(!secure||!httpOnly||!path||(!remove&&!validValue(value)))throw new NativeAccessError("native_access_unavailable");
                if(remove)cookies.remove(name);else cookies.put(name,value);changed=true;
            }
        }
        if(changed)store.write(data);
    }
}
