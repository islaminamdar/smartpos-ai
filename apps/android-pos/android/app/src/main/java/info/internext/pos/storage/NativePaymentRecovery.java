package info.internext.pos.storage;

import android.content.Context;
import info.internext.pos.offline.SignedProtocol;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;

/** Historical evidence transport, independent of login/PIN/clock and selling permission.
 * Display of customer/payment details remains the checkout coordinator's responsibility.
 * No caller URL, envelope, manager outcome or payment action is accepted from JavaScript. */
public final class NativePaymentRecovery {
    interface Transport { JSONObject post(String path,JSONObject body)throws Exception; }
    private final NativeJournal journal;
    private final DeviceIdentity identity;
    private final Map<String,PublicKey> keys;
    private final PublicKey deviceKey;
    private final Transport transport;
    public NativePaymentRecovery(Context context,NativeJournal journal,NativeSession session)throws Exception{
        this(journal,new DeviceIdentity(),NativeTrustKeys.load(context),session::historicalRequest);
    }
    NativePaymentRecovery(NativeJournal journal,DeviceIdentity identity,Map<String,PublicKey> keys,Transport transport)throws Exception{
        this.journal=journal;this.identity=identity;this.keys=Collections.unmodifiableMap(new HashMap<>(keys));this.transport=transport;
        JSONObject device=identity.readOrCreate(journal);
        this.deviceKey=SignedProtocol.publicKey(SignedProtocol.decode(device.getString("publicKeySpkiBase64Url"),256));
        if(!SignedProtocol.fingerprint(deviceKey).equals(device.getString("deviceKeySha256")))throw new NativeAccessError("native_storage_unavailable");
    }
    public synchronized JSONObject recover(String intentId)throws Exception{
        if(intentId==null||!intentId.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))
            throw new NativeAccessError("native_checkout_unavailable");
        try{
            NativeCheckoutEngine engine=NativeCheckoutEngine.forHistorical(journal,keys,deviceKey,identity::sign,intentId);
            // Fresh random challenge per explicit retry. Original proof is never rebuilt.
            String nonce=challenge();JSONObject request=engine.paymentResolutionRequest(intentId,nonce);
            JSONObject response=transport.post("/api/pos/offline/payment-freeze",request);
            return engine.acceptPaymentResolution(intentId,response,nonce);
        }catch(Exception error){throw new NativeAccessError("offline_payment_recovery_uncertain");}
    }
    private static String challenge(){byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);
        StringBuilder result=new StringBuilder(64);for(byte value:bytes)result.append(String.format(java.util.Locale.ROOT,"%02x",value&255));return result.toString();}
}
