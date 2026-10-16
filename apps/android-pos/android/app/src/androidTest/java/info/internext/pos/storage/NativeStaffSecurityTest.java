package info.internext.pos.storage;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import info.internext.pos.offline.OfflineBundle;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.UUID;
import java.util.ArrayList;
import static org.junit.Assert.*;

/** Every fixture owns unique synthetic files/aliases and verifies cleanup. No production
 * key, main ledger, Auth identity, server request or real financial record is touched. */
@RunWith(AndroidJUnit4.class)
public class NativeStaffSecurityTest {
    private static final String PIN="13572468";
    private static class MutableClock implements NativeClockSource.ObservationSource {
        int boot=20;long elapsed=1000,wall=1_800_000_000_000L;
        @Override public NativeClockSource.Observation sample(){return new NativeClockSource.Observation(boot,elapsed,wall);}
        void advance(long delta){elapsed+=delta;wall+=delta;}
    }
    private static class Fixture implements AutoCloseable {
        final Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        final String prefix="synthetic-native-auth-"+UUID.randomUUID();
        final String ledger=prefix+"-ledger.db",clockDb=prefix+"-clock.db",authDb=prefix+"-auth.db",clockAlias=prefix+".clock",authAlias=prefix+".auth";
        final NativeJournal journal=new NativeJournal(context,ledger,()->{});
        final MutableClock source=new MutableClock();
        final OfflineBundle.Binding binding=new OfflineBundle.Binding(id(),id(),id(),id(),id(),id(),"a".repeat(64));
        NativeClockSource clock;NativeStaffUnlock auth;
        final Tasks tasks=new Tasks();
        Fixture() throws Exception {try{journal.bindDeviceKey(binding.deviceKeySha256);clock=new NativeClockSource(context,journal,clockDb,clockAlias,source);auth=new NativeStaffUnlock(context,journal,clock,authDb,authAlias,tasks,()->source.elapsed);}catch(Exception error){try{close();}catch(Exception cleanup){error.addSuppressed(cleanup);}throw error;}}
        static String id(){return UUID.randomUUID().toString();}
        void provision() throws Exception {auth.provisionVerifiedStaff(binding,PIN.toCharArray());}
        void unlock() throws Exception {auth.unlock(binding,PIN.toCharArray());}
        void restartAuth() throws Exception {auth.close();auth=new NativeStaffUnlock(context,journal,clock,authDb,authAlias,tasks,()->source.elapsed);}
        void restartClock() throws Exception {clock.close();clock=new NativeClockSource(context,journal,clockDb,clockAlias,source);}
        JSONObject credential() throws Exception {try(SQLiteDatabase db=context.openOrCreateDatabase(authDb,0,null);Cursor c=db.rawQuery("SELECT payload FROM credentials",null)){assertTrue(c.moveToFirst());return new JSONObject(c.getString(0));}}
        @Override public void close() throws Exception {
            if(auth!=null)auth.close();if(clock!=null)clock.close();journal.close();
            KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);
            for(String alias:new String[]{clockAlias,authAlias}){if(keys.containsAlias(alias))keys.deleteEntry(alias);assertFalse(keys.containsAlias(alias));}
            for(String file:new String[]{ledger,clockDb,authDb}){context.deleteDatabase(file);assertFalse(context.getDatabasePath(file).exists());}
        }
    }
    private static final class Tasks implements NativeSessionExpiry.Scheduler {
        final ArrayList<Runnable> all=new ArrayList<>();
        public void post(Runnable task,long delay){all.add(task);}
        public void remove(Runnable task){} // Exercise even callbacks already dequeued by Android.
        void run(int i){all.get(i).run();}
    }
    private static void fails(String code,org.junit.function.ThrowingRunnable action){Exception e=assertThrows(Exception.class,action);assertEquals(code,e.getMessage());}

    @Test public void provisionsPepperedNativeVerifierConsumesPinAndNeverPersistsPlaintext() throws Exception {
        try(Fixture f=new Fixture()) {
            char[] pin=PIN.toCharArray();f.auth.provisionVerifiedStaff(f.binding,pin);assertArrayEquals(new char[8],pin);assertTrue(f.auth.isProvisioned(f.binding));
            JSONObject credential=f.credential();assertEquals(600_000,credential.getLong("iterations"));assertEquals(0,credential.getLong("failures"));assertFalse(credential.toString().contains(PIN));
            KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);assertNull(keys.getKey(f.authAlias,null).getEncoded());
            char[] second=PIN.toCharArray();fails("pin_already_provisioned",()->f.auth.provisionVerifiedStaff(f.binding,second));assertArrayEquals(new char[8],second);
            fails("pin_unlock_required",()->f.auth.requireUnlocked(f.binding));f.unlock();f.auth.requireUnlocked(f.binding);
        }
    }
    @Test public void sessionIsBoundToExactShiftAndExpiresByElapsedTimeAndProcessInstance() throws Exception {
        try(Fixture f=new Fixture()) {
            f.provision();f.unlock();f.auth.requireUnlocked(f.binding);
            var b=f.binding;var changed=new OfflineBundle.Binding(b.organizationId,b.branchId,b.deviceId,b.actorId,Fixture.id(),b.keyEpoch,b.deviceKeySha256);
            fails("pin_unlock_required",()->f.auth.requireUnlocked(changed));f.auth.unlock(changed,PIN.toCharArray());f.auth.requireUnlocked(changed);
            f.source.advance(NativeStaffUnlock.SESSION_MS);fails("pin_unlock_required",()->f.auth.requireUnlocked(changed));
            f.unlock();f.restartAuth();fails("pin_unlock_required",()->f.auth.requireUnlocked(f.binding));
            f.unlock();f.source.boot++;f.source.elapsed=1;f.source.wall+=10000;fails("pin_unlock_required",()->f.auth.requireUnlocked(f.binding));
        }
    }
    @Test public void foregroundExpiryRevokesWithoutAnotherGuardAndNotifiesOnce() throws Exception {
        try(Fixture f=new Fixture()) {
            int[] invalidations={0},notifications={0};f.auth.sessionExpiryCallbacks(()->invalidations[0]++,()->notifications[0]++);
            f.provision();f.unlock();JSONObject before=f.credential();f.source.advance(NativeStaffUnlock.SESSION_MS);f.tasks.run(0);
            assertEquals(1,invalidations[0]);assertEquals(0,notifications[0]);
            fails("pin_unlock_required",()->f.auth.requireUnlocked(f.binding));fails("pin_unlock_required",()->f.auth.requireUnlocked(f.binding));
            f.tasks.run(1);f.tasks.run(1);assertEquals(1,notifications[0]);assertEquals(before.toString(),f.credential().toString());
        }
    }
    @Test public void repeatedLazyExpiryReadsDoNotCancelTheQueuedNotification() throws Exception {
        try(Fixture f=new Fixture()) {
            int[] invalidations={0},notifications={0};f.auth.sessionExpiryCallbacks(()->invalidations[0]++,()->notifications[0]++);
            f.provision();f.unlock();f.source.advance(NativeStaffUnlock.SESSION_MS);
            fails("pin_unlock_required",()->f.auth.requireUnlocked(f.binding));fails("pin_unlock_required",()->f.auth.requireUnlocked(f.binding));
            assertEquals(1,invalidations[0]);f.tasks.run(0);f.tasks.run(1);assertEquals(1,notifications[0]);
        }
    }
    @Test public void successfulReunlockSuppressesOldTimerAndOldQueuedDelivery() throws Exception {
        try(Fixture f=new Fixture()) {
            int[] notifications={0};f.auth.sessionExpiryCallbacks(()->{},()->notifications[0]++);
            f.provision();f.unlock();f.source.advance(NativeStaffUnlock.SESSION_MS);f.tasks.run(0);
            f.unlock();f.tasks.run(0);f.tasks.run(1);f.auth.requireUnlocked(f.binding);assertEquals(0,notifications[0]);
            f.source.advance(NativeStaffUnlock.SESSION_MS);f.tasks.run(2);f.tasks.run(3);assertEquals(1,notifications[0]);
        }
    }
    @Test public void failedReunlockDoesNotCancelAlreadyQueuedExpiryNotification() throws Exception {
        try(Fixture f=new Fixture()) {
            int[] notifications={0};f.auth.sessionExpiryCallbacks(()->{},()->notifications[0]++);
            f.provision();f.unlock();f.source.advance(NativeStaffUnlock.SESSION_MS);f.tasks.run(0);
            fails("pin_incorrect",()->f.auth.unlock(f.binding,"87654321".toCharArray()));
            f.tasks.run(1);assertEquals(1,notifications[0]);fails("pin_unlock_required",()->f.auth.requireUnlocked(f.binding));
        }
    }
    @Test public void expiryNotificationDoesNotWaitForCredentialMonitor() throws Exception {
        try(Fixture f=new Fixture()) {
            java.util.concurrent.CountDownLatch notified=new java.util.concurrent.CountDownLatch(1);
            f.auth.sessionExpiryCallbacks(()->{},notified::countDown);f.provision();f.unlock();f.source.advance(NativeStaffUnlock.SESSION_MS);
            Thread callback=new Thread(()->{f.tasks.run(0);f.tasks.run(1);});
            synchronized(NativeStaffUnlock.class){callback.start();assertTrue(notified.await(2,java.util.concurrent.TimeUnit.SECONDS));}
            callback.join(2000);assertFalse(callback.isAlive());
        }
    }
    @Test public void failedAttemptBeforeDeadlineKeepsOriginalExpiryNotice() throws Exception {
        try(Fixture f=new Fixture()) {
            int[] notifications={0};f.auth.sessionExpiryCallbacks(()->{},()->notifications[0]++);
            f.provision();f.unlock();f.source.advance(NativeStaffUnlock.SESSION_MS-1);
            fails("pin_incorrect",()->f.auth.unlock(f.binding,"87654321".toCharArray()));
            fails("pin_unlock_required",()->f.auth.requireUnlocked(f.binding));
            f.source.advance(1);f.tasks.run(0);f.tasks.run(1);assertEquals(1,notifications[0]);
        }
    }
    @Test public void failuresAndCooldownSurviveRestartRebootAndWallClockForwardChanges() throws Exception {
        try(Fixture f=new Fixture()) {
            f.provision();for(int i=0;i<4;i++)fails("pin_incorrect",()->f.auth.unlock(f.binding,"87654321".toCharArray()));
            f.restartAuth();assertEquals(4,f.credential().getLong("failures"));
            char[] malformed="1".toCharArray();fails("pin_format_invalid",()->f.auth.unlock(f.binding,malformed));assertArrayEquals(new char[1],malformed);
            assertEquals(5,f.credential().getLong("failures"));f.restartAuth();fails("pin_locked",f::unlock);
            f.source.wall+=86_400_000;fails("pin_locked",f::unlock);
            f.source.boot++;f.source.elapsed=1;f.source.wall+=1;fails("pin_locked",f::unlock);
            long restarted=f.credential().getLong("lockUntilElapsed");assertEquals(f.source.elapsed+NativeStaffUnlock.LOCKOUT_MS,restarted);
            f.restartAuth();f.source.advance(NativeStaffUnlock.LOCKOUT_MS-1);fails("pin_locked",f::unlock);
            f.source.advance(1);f.unlock();assertEquals(0,f.credential().getLong("failures"));f.auth.requireUnlocked(f.binding);
        }
    }
    @Test public void tenthFailureRequiresOnlineResetAndCannotBeReprovisionedOrWaitedOut() throws Exception {
        try(Fixture f=new Fixture()) {
            f.provision();for(int i=0;i<5;i++)fails("pin_incorrect",()->f.auth.unlock(f.binding,"87654321".toCharArray()));
            f.source.advance(NativeStaffUnlock.LOCKOUT_MS);
            for(int i=0;i<4;i++)fails("pin_incorrect",()->f.auth.unlock(f.binding,"87654321".toCharArray()));
            fails("pin_online_reset_required",()->f.auth.unlock(f.binding,"87654321".toCharArray()));assertEquals(10,f.credential().getLong("failures"));
            f.restartAuth();f.source.advance(86_400_000);fails("pin_online_reset_required",f::unlock);
            fails("pin_already_provisioned",()->f.auth.provisionVerifiedStaff(f.binding,PIN.toCharArray()));
        }
    }
    @Test public void authenticatedCounterTamperingFailsClosedInsteadOfResettingAttempts() throws Exception {
        try(Fixture f=new Fixture()) {
            f.provision();fails("pin_incorrect",()->f.auth.unlock(f.binding,"87654321".toCharArray()));
            try(SQLiteDatabase db=f.context.openOrCreateDatabase(f.authDb,0,null)){JSONObject p=f.credential();p.put("failures",0);db.execSQL("UPDATE credentials SET payload=?",new Object[]{p.toString()});}
            fails("pin_state_invalid",f::unlock);fails("pin_state_invalid",()->f.auth.provisionVerifiedStaff(f.binding,PIN.toCharArray()));
            f.restartAuth();fails("pin_state_invalid",()->f.auth.isProvisioned(f.binding));
        }
    }
    @Test public void missingKeystorePepperCannotSilentlyCreateReplacementVerifier() throws Exception {
        try(Fixture f=new Fixture()) {
            f.provision();f.auth.close();f.auth=null;KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(f.authAlias);
            fails("native_security_custody_mismatch",()->new NativeStaffUnlock(f.context,f.journal,f.clock,f.authDb,f.authAlias));assertTrue(f.context.getDatabasePath(f.authDb).exists());
        }
    }
    @Test public void missingAuthDatabaseCannotReuseKeystoreKeyToResetCounters() throws Exception {
        try(Fixture f=new Fixture()) {
            f.provision();f.auth.close();f.auth=null;assertTrue(f.context.deleteDatabase(f.authDb));
            fails("native_security_custody_mismatch",()->new NativeStaffUnlock(f.context,f.journal,f.clock,f.authDb,f.authAlias));
        }
    }
    @Test public void nativeClockBootIdentityPersistsAndClockRollbackLatchesAcrossRestart() throws Exception {
        try(Fixture f=new Fixture()) {
            var first=f.clock.read();f.restartClock();assertEquals(first.bootId,f.clock.read().bootId);
            f.source.boot++;f.source.elapsed=5;f.source.wall+=5000;var rebooted=f.clock.read();assertNotEquals(first.bootId,rebooted.bootId);
            f.restartClock();assertEquals(rebooted.bootId,f.clock.read().bootId);
            f.source.wall--;fails("clock_rollback",f.clock::read);f.source.wall+=1000;fails("clock_source_blocked",f.clock::read);
            f.restartClock();fails("clock_source_blocked",f.clock::read);
        }
    }
    @Test public void elapsedRollbackAndBootCounterRollbackCannotCreateFreshClockEpoch() throws Exception {
        try(Fixture f=new Fixture()) {f.clock.read();f.source.elapsed--;fails("clock_rollback",f.clock::read);}
        try(Fixture f=new Fixture()) {f.clock.read();f.source.boot--;f.source.wall++;fails("clock_rollback",f.clock::read);}
    }
    @Test public void actualOsBootCountAndElapsedRealtimeProduceStableIdentityAcrossClockInstances() throws Exception {
        Context c=InstrumentationRegistry.getInstrumentation().getTargetContext();String prefix="synthetic-real-clock-"+UUID.randomUUID(),ledger=prefix+".db",database=prefix+"-clock.db",alias=prefix+".key";
        NativeJournal journal=new NativeJournal(c,ledger,()->{});NativeClockSource clock=null;
        try {
            NativeClockSource.ObservationSource os=()->new NativeClockSource.Observation(Settings.Global.getInt(c.getContentResolver(),Settings.Global.BOOT_COUNT),SystemClock.elapsedRealtime(),System.currentTimeMillis());
            clock=new NativeClockSource(c,journal,database,alias,os);var first=clock.read();clock.close();clock=new NativeClockSource(c,journal,database,alias,os);var second=clock.read();
            assertEquals(first.bootId,second.bootId);assertTrue(second.elapsedRealtimeMs>=first.elapsedRealtimeMs);assertTrue(second.wallTimeMs>=first.wallTimeMs);
        }finally{
            if(clock!=null)clock.close();journal.close();KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);if(keys.containsAlias(alias))keys.deleteEntry(alias);assertFalse(keys.containsAlias(alias));c.deleteDatabase(database);c.deleteDatabase(ledger);assertFalse(c.getDatabasePath(database).exists());assertFalse(c.getDatabasePath(ledger).exists());
        }
    }
}
