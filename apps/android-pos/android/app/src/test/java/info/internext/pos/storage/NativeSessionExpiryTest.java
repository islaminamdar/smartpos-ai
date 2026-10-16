package info.internext.pos.storage;

import java.util.ArrayList;
import org.junit.Test;
import static org.junit.Assert.*;

public class NativeSessionExpiryTest {
    static final class Task {final Runnable runnable;final long delay;boolean removed;Task(Runnable r,long d){runnable=r;delay=d;}}
    static final class Fixture implements NativeSessionExpiry.Scheduler {
        long now=1000;int invalidations,notifications;final ArrayList<Task> tasks=new ArrayList<>();
        final NativeSessionExpiry expiry=new NativeSessionExpiry(this,()->now);
        Fixture(){expiry.callbacks(()->invalidations++,()->notifications++);}
        public void post(Runnable r,long delay){tasks.add(new Task(r,delay));}
        public void remove(Runnable r){for(Task task:tasks)if(task.runnable==r)task.removed=true;}
        void arm(){expiry.arm(now,300_000);}
        void run(int i){tasks.get(i).runnable.run();} // Also simulate already-dequeued, cancelled tasks.
    }
    @Test public void expiresAtExactMonotonicDeadlineAndInvalidatesBeforeMainDelivery(){
        Fixture f=new Fixture();f.arm();assertEquals(300_000,f.tasks.get(0).delay);
        f.now+=300_000;f.run(0);assertFalse(f.expiry.active());assertEquals(1,f.invalidations);assertEquals(0,f.notifications);
        f.run(1);assertEquals(1,f.notifications);
    }
    @Test public void earlyWakeReschedulesOnlyRemainingTimeAndLateWakeDoesNotExtend(){
        Fixture f=new Fixture();f.arm();f.now+=100;f.run(0);assertTrue(f.expiry.active());assertEquals(299_900,f.tasks.get(1).delay);
        f.now+=400_000;f.run(1);f.run(2);assertFalse(f.expiry.active());assertEquals(1,f.notifications);
    }
    @Test public void oldTimerCannotInvalidateNewUnlock(){
        Fixture f=new Fixture();f.arm();f.now+=200_000;f.arm();f.now+=100_000;f.run(0);
        assertTrue(f.expiry.active());assertEquals(0,f.invalidations);f.now+=200_000;f.run(1);f.run(2);assertEquals(1,f.notifications);
    }
    @Test public void queuedOldNotificationCannotWipeLaterUnlock(){
        Fixture f=new Fixture();f.arm();f.now+=300_000;f.run(0);assertEquals(1,f.invalidations);
        f.arm();f.run(1);assertEquals(0,f.notifications);assertTrue(f.expiry.active());
    }
    @Test public void manualLockAndCloseCancelEvenDequeuedTasks(){
        Fixture f=new Fixture();f.arm();f.expiry.clear();f.now+=300_000;f.run(0);assertEquals(0,f.invalidations);
        f.arm();f.expiry.close();f.run(1);assertEquals(0,f.notifications);
        assertThrows(IllegalStateException.class,f::arm);
    }
    @Test public void lazyGuardExpiryAndTimerRaceEmitOnlyOnce(){
        Fixture f=new Fixture();f.arm();f.now+=300_000;f.expiry.expire();f.expiry.expire();f.run(0);f.run(1);
        assertEquals(1,f.invalidations);assertEquals(1,f.notifications);assertTrue(f.expiry.expired());
    }
    @Test public void elapsedRollbackFailsClosed(){
        Fixture f=new Fixture();f.arm();f.now=999;f.run(0);f.run(1);assertFalse(f.expiry.active());assertEquals(1,f.notifications);
    }
    @Test public void closeSuppressesAlreadyQueuedNotification(){
        Fixture f=new Fixture();f.arm();f.now+=300_000;f.run(0);f.expiry.close();f.run(1);assertEquals(0,f.notifications);
    }
    @Test public void delayedCredentialSaveDoesNotExtendTheAbsoluteDeadline(){
        Fixture f=new Fixture();f.now=2000;f.expiry.arm(1000,300_000);assertEquals(299_000,f.tasks.get(0).delay);
        f.now=301_000;f.run(0);assertEquals(1,f.invalidations);
    }
    @Test public void alreadyExpiredAtArmRevokesImmediately(){
        Fixture f=new Fixture();f.now=301_000;f.expiry.arm(1000,300_000);
        assertFalse(f.expiry.active());assertEquals(1,f.invalidations);f.run(0);assertEquals(1,f.notifications);
    }
}
