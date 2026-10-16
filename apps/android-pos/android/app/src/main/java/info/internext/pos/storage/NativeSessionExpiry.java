package info.internext.pos.storage;

import java.util.function.LongSupplier;

/** In-memory notification lease only. Persistent credentials and financial authorization
 * remain with NativeStaffUnlock. This monitor never acquires an auth/store/ledger lock. */
final class NativeSessionExpiry implements AutoCloseable {
    interface Scheduler {
        void post(Runnable task,long delayMs);
        void remove(Runnable task);
    }
    private final Scheduler scheduler;
    private final LongSupplier elapsed;
    private Runnable invalidate=()->{},notify=()->{};
    private Runnable wake,delivery;
    private long generation,started,deadline;
    private boolean active,closed,expired;

    NativeSessionExpiry(Scheduler scheduler,LongSupplier elapsed) {this.scheduler=scheduler;this.elapsed=elapsed;}
    // Callbacks are native host hooks: invalidation must only change atomic state;
    // notification runs on the scheduler's main looper. Neither may acquire storage locks.
    synchronized void callbacks(Runnable invalidate,Runnable notify) {
        this.invalidate=invalidate;this.notify=notify;
    }
    synchronized void arm(long started,long duration) {
        if(closed)throw new IllegalStateException("pin_unlock_required");
        clear();this.started=started;deadline=Math.addExact(started,duration);active=true;
        long now=elapsed.getAsLong();
        if(now<started||now>=deadline)expire();else schedule(generation,deadline-now);
    }
    private void schedule(long token,long delay) {
        wake=()->check(token);scheduler.post(wake,delay);
    }
    private synchronized void check(long token) {
        if(closed||!active||generation!=token)return;
        long now=elapsed.getAsLong();
        // Handler delays use uptime. Recheck elapsed time, including deep sleep,
        // rather than extending the authorization deadline when a task runs late.
        if(now<started||now>=deadline)expire();else schedule(token,deadline-now);
    }
    synchronized boolean active() {return active;}
    synchronized boolean expired() {return expired;}
    synchronized void expire() {
        if(closed||!active)return;
        if(wake!=null)scheduler.remove(wake);wake=null;active=false;expired=true;
        long token=generation;
        invalidate.run(); // Synchronous: an in-flight detail read must fail its epoch check.
        delivery=()->deliver(token);scheduler.post(delivery,0);
    }
    private synchronized void deliver(long token) {
        if(closed||generation!=token||!expired||delivery==null)return;
        delivery=null;notify.run();
    }
    synchronized void clear() {
        generation++;active=false;expired=false;
        if(wake!=null)scheduler.remove(wake);if(delivery!=null)scheduler.remove(delivery);
        wake=null;delivery=null;
    }
    @Override public synchronized void close() {clear();closed=true;invalidate=()->{};notify=()->{};}
}
