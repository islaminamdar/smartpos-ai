package info.internext.pos.storage;
import android.content.Context;
import info.internext.pos.R;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.SignedProtocol;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
/** Release-pinned public keys. Never download trust from a response or accept a caller key. */
final class NativeTrustKeys {
    static Map<String,PublicKey> load(Context context)throws Exception{
        try(InputStream in=context.getResources().openRawResource(R.raw.offline_server_keys)){
            ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[1024];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>8192)throw new Exception();out.write(buffer,0,n);}
            Object value=CanonicalJson.transport(out.toString(StandardCharsets.UTF_8.name()),8192);if(!(value instanceof JSONArray))throw new Exception();JSONArray rows=(JSONArray)value;if(rows.length()<1||rows.length()>8)throw new Exception();
            Map<String,PublicKey> keys=new HashMap<>();for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);if(row.length()!=2)throw new Exception();String id=row.getString("id");if(!id.matches("[A-Za-z0-9._-]{1,120}")||keys.containsKey(id))throw new Exception();keys.put(id,SignedProtocol.publicKey(SignedProtocol.decode(row.getString("publicKeySpki"),256)));}return Collections.unmodifiableMap(keys);
        }catch(Exception error){throw new NativeAccessError("offline_not_configured");}
    }
}
