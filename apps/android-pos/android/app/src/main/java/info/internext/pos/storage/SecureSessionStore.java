package info.internext.pos.storage;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import info.internext.pos.offline.CanonicalJson;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.concurrent.ConcurrentHashMap;

/** One native owner serializes all session operations. Tokens are encrypted at rest and never
 * copied into WebView cookies, localStorage, preferences, logs, backups or bridge responses. */
final class SecureSessionStore {
    private static final ConcurrentHashMap<String,Object> LOCKS=new ConcurrentHashMap<>();
    private final AtomicFile file; private final String alias; private final Object lock;
    private static final byte[] AAD="internext-pos-native-session-v1".getBytes(StandardCharsets.UTF_8);
    SecureSessionStore(Context context) throws Exception {this(context,"native-session-v1.bin","internext.pos.session.v1");}
    SecureSessionStore(Context context,String name,String alias)throws Exception{
        if(!name.matches("[A-Za-z0-9._-]{1,120}")||!alias.matches("[A-Za-z0-9._-]{1,160}"))throw new NativeAccessError("native_storage_unavailable");
        File path=new File(context.getNoBackupFilesDir(),name);file=new AtomicFile(path);this.alias=alias;lock=LOCKS.computeIfAbsent(path.getAbsolutePath(),key->new Object());
        synchronized(lock){
            KeyStore ks=keys();
            if(!path.exists()&&!new File(path+".bak").exists()){
                if(ks.containsAlias(alias))throw new NativeAccessError("native_storage_unavailable");
                KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
                g.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());g.generateKey();
                write(new JSONObject().put("schemaVersion",1).put("actorId",JSONObject.NULL).put("cookies",new JSONObject()).put("counter",JSONObject.NULL).put("enrollment",JSONObject.NULL).put("logoutPending",false));
            }
            read();
        }
    }
    private KeyStore keys()throws Exception{KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);return ks;}
    private SecretKey key()throws Exception{KeyStore ks=keys();if(!ks.containsAlias(alias))throw new NativeAccessError("native_storage_unavailable");return (SecretKey)ks.getKey(alias,null);}
    JSONObject read()throws Exception{
        synchronized(lock){
            byte[] plain=null;
            try{
                File base=file.getBaseFile(),backup=new File(base+".bak");
                if(base.length()>131101||backup.length()>131101)throw new NativeAccessError("native_storage_unavailable");
                byte[] bytes=file.readFully();if(bytes.length<30||bytes.length>131101||bytes[0]!=1)throw new NativeAccessError("native_storage_unavailable");
                Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Arrays.copyOfRange(bytes,1,13)));cipher.updateAAD(AAD);plain=cipher.doFinal(bytes,13,bytes.length-13);
                Object parsed=CanonicalJson.parse(plain);if(!(parsed instanceof JSONObject))throw new NativeAccessError("native_storage_unavailable");JSONObject value=(JSONObject)parsed;
                if(value.length()!=6||value.getInt("schemaVersion")!=1||!(value.get("cookies") instanceof JSONObject)||!(value.get("logoutPending") instanceof Boolean))throw new NativeAccessError("native_storage_unavailable");
                for(String field:new String[]{"actorId","counter","enrollment"})if(!value.has(field))throw new NativeAccessError("native_storage_unavailable");return value;
            }catch(NativeAccessError error){throw error;}catch(Exception error){throw new NativeAccessError("native_storage_unavailable");}finally{if(plain!=null)Arrays.fill(plain,(byte)0);}
        }
    }
    void write(JSONObject value)throws Exception{
        synchronized(lock){
            byte[] plain=CanonicalJson.bytes(value);FileOutputStream out=null;
            try{
                if(plain.length>131072)throw new NativeAccessError("native_storage_unavailable");
                Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());cipher.updateAAD(AAD);byte[] iv=cipher.getIV();if(iv.length!=12)throw new NativeAccessError("native_storage_unavailable");byte[] encrypted=cipher.doFinal(plain);
                out=file.startWrite();out.write(1);out.write(iv);out.write(encrypted);file.finishWrite(out);out=null;
            }catch(Exception error){if(out!=null)file.failWrite(out);throw new NativeAccessError("native_storage_unavailable");}finally{Arrays.fill(plain,(byte)0);}
        }
    }
}
