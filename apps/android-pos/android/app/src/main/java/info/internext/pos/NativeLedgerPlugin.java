package info.internext.pos;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import info.internext.pos.storage.DeviceIdentity;
import info.internext.pos.storage.NativeJournal;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Read-only bridge until the native authority/checkout engine and server import are verified. */
@CapacitorPlugin(name = "NativeLedger")
public final class NativeLedgerPlugin extends Plugin {
    private NativeJournal journal;
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    @Override public void load() { journal = new NativeJournal(getContext()); }
    interface ReadOperation { org.json.JSONObject read() throws Exception; }
    private void read(PluginCall call, ReadOperation operation) {
        storage.execute(() -> {
            try { call.resolve(new JSObject(operation.read().toString())); }
            catch (Exception error) { call.reject("This device's saved records could not be read. Keep the app installed and contact support.", "native_storage_unavailable"); }
        });
    }
    @PluginMethod public void getIdentity(PluginCall call) { read(call, () -> new DeviceIdentity().readOrCreate(journal)); }
    @PluginMethod public void getStatus(PluginCall call) { read(call, () -> journal.status()); }
    @PluginMethod public void listReceipts(PluginCall call) { read(call, () -> journal.listReceipts()); }
    @Override protected void handleOnDestroy() {
        storage.execute(() -> journal.close()); storage.shutdown(); super.handleOnDestroy();
    }
}
