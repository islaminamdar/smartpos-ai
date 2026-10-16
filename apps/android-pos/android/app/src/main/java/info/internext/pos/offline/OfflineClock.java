package info.internext.pos.offline;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

/** Conservative time estimation for a bounded offline authority, not a tamper-proof clock.
 * Readings must originate in native OS code, never in WebView input. Persist nextState
 * atomically with each operation. Latch anomalies separately even when that operation rolls back.
 * A fresh trusted HTTPS time is required for anchor(); replaying an old bundle must not re-anchor.
 */
public final class OfflineClock {
    public static final long MAX_DRIFT_MS = 120_000L;
    public static final long MAX_TIME_MS = 253_402_300_799_999L; // Four-digit UTC years through 9999.
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private OfflineClock() {}

    public static final class ClockException extends IllegalStateException {
        public final String code;
        private ClockException(String code) { super(code); this.code = code; }
        public boolean isAnomaly() { return !"clock_expired".equals(code) && !"clock_not_started".equals(code); }
    }
    public static final class Reading {
        public final String bootId;
        public final long elapsedRealtimeMs, wallTimeMs;
        public Reading(String bootId, long elapsedRealtimeMs, long wallTimeMs) {
            this.bootId = bootId; this.elapsedRealtimeMs = elapsedRealtimeMs; this.wallTimeMs = wallTimeMs;
            boot(bootId); elapsed(elapsedRealtimeMs); time(wallTimeMs);
        }
    }
    public static final class State {
        public final String bootId;
        public final long anchorServerMs, anchorWallMs, anchorElapsedMs, lastElapsedMs;
        public final long highWaterWallMs, highWaterServerMs;
        private State(String bootId, long server, long wall, long elapsed, long lastElapsed, long highWall, long highServer) {
            this.bootId=bootId; anchorServerMs=server; anchorWallMs=wall; anchorElapsedMs=elapsed;
            lastElapsedMs=lastElapsed; highWaterWallMs=highWall; highWaterServerMs=highServer;
            validate(this);
        }
        public String toJson() {
            try {
                JSONObject value = new JSONObject().put("schemaVersion",1).put("bootId",bootId)
                    .put("anchorServerMs",anchorServerMs).put("anchorWallMs",anchorWallMs)
                    .put("anchorElapsedMs",anchorElapsedMs).put("lastElapsedMs",lastElapsedMs)
                    .put("highWaterWallMs",highWaterWallMs).put("highWaterServerMs",highWaterServerMs);
                return new String(CanonicalJson.bytes(value), StandardCharsets.UTF_8);
            } catch (Exception error) { throw failure("clock_invalid_state"); }
        }
        public static State fromJson(String raw) {
            try {
                if (raw==null || raw.length()>2048) throw failure("clock_invalid_state");
                Object parsed=CanonicalJson.parse(raw.getBytes(StandardCharsets.UTF_8));
                if (!(parsed instanceof JSONObject)) throw failure("clock_invalid_state");
                JSONObject value=(JSONObject)parsed;
                if (value.length()!=8 || exactLong(value,"schemaVersion")!=1 || !(value.get("bootId") instanceof String)) throw failure("clock_invalid_state");
                return new State((String)value.get("bootId"),exactLong(value,"anchorServerMs"),exactLong(value,"anchorWallMs"),
                    exactLong(value,"anchorElapsedMs"),exactLong(value,"lastElapsedMs"),exactLong(value,"highWaterWallMs"),exactLong(value,"highWaterServerMs"));
            } catch (Exception error) { throw failure("clock_invalid_state"); }
        }
    }
    public static final class Tick {
        public final long estimatedServerMs;
        public final State nextState;
        private Tick(long estimate,State next) { estimatedServerMs=estimate; nextState=next; }
    }
    /** Only for a fresh online time observation. Caller must prevent resetting existing custody. */
    public static State anchor(long freshTrustedServerMs,Reading now) {
        if(now==null) throw failure("clock_invalid_state");
        time(freshTrustedServerMs);
        if(distance(freshTrustedServerMs,now.wallTimeMs)>MAX_DRIFT_MS) throw failure("clock_drift");
        return new State(now.bootId,freshTrustedServerMs,now.wallTimeMs,now.elapsedRealtimeMs,now.elapsedRealtimeMs,now.wallTimeMs,freshTrustedServerMs);
    }
    public static Tick advance(State state,Reading now,long notBeforeMs,long expiresAtMs) {
        if(state==null || now==null) throw failure("clock_invalid_state");
        validate(state);time(notBeforeMs);time(expiresAtMs);
        if(expiresAtMs<=notBeforeMs) throw failure("clock_invalid_state");
        if(now.wallTimeMs<state.highWaterWallMs) throw failure("clock_rollback");
        final State next;final long estimate;
        if(state.bootId.equals(now.bootId)) {
            if(now.elapsedRealtimeMs<state.lastElapsedMs) throw failure("clock_rollback");
            long monotonic=now.elapsedRealtimeMs-state.anchorElapsedMs;
            long wall=now.wallTimeMs-state.anchorWallMs;
            if(distance(monotonic,wall)>MAX_DRIFT_MS) throw failure("clock_drift");
            estimate=addTime(state.anchorServerMs,monotonic);
            next=new State(state.bootId,state.anchorServerMs,state.anchorWallMs,state.anchorElapsedMs,
                now.elapsedRealtimeMs,now.wallTimeMs,estimate);
        } else {
            long wall=now.wallTimeMs-state.highWaterWallMs;
            // New-boot elapsed time cannot be longer than all time since the previous persisted
            // observation. Small OS-clock drift is tolerated but can never subtract known uptime.
            if(now.elapsedRealtimeMs>wall && now.elapsedRealtimeMs-wall>MAX_DRIFT_MS) throw failure("clock_drift");
            estimate=addTime(state.highWaterServerMs,Math.max(wall,now.elapsedRealtimeMs));
            next=new State(now.bootId,estimate,now.wallTimeMs,now.elapsedRealtimeMs,now.elapsedRealtimeMs,now.wallTimeMs,estimate);
        }
        if(estimate<notBeforeMs) throw failure("clock_not_started");
        if(estimate>=expiresAtMs) throw failure("clock_expired");
        return new Tick(estimate,next);
    }
    private static void validate(State value) {
        boot(value.bootId);time(value.anchorServerMs);time(value.anchorWallMs);time(value.highWaterWallMs);time(value.highWaterServerMs);
        elapsed(value.anchorElapsedMs);elapsed(value.lastElapsedMs);
        if(value.lastElapsedMs<value.anchorElapsedMs || value.highWaterWallMs<value.anchorWallMs || value.highWaterServerMs<value.anchorServerMs)
            throw failure("clock_invalid_state");
        long delta=value.lastElapsedMs-value.anchorElapsedMs;
        if(addTime(value.anchorServerMs,delta)!=value.highWaterServerMs || distance(value.highWaterWallMs-value.anchorWallMs,delta)>MAX_DRIFT_MS)
            throw failure("clock_invalid_state");
    }
    private static long exactLong(JSONObject value,String key) throws Exception {
        Object raw=value.get(key);
        if(!(raw instanceof Integer) && !(raw instanceof Long)) throw failure("clock_invalid_state");
        return ((Number)raw).longValue();
    }
    private static void boot(String id) {
        try { if(id==null || !UUID.fromString(id).toString().equals(id)) throw failure("clock_invalid_state"); }
        catch(IllegalArgumentException error) { throw failure("clock_invalid_state"); }
    }
    private static void time(long value) { if(value<0 || value>MAX_TIME_MS) throw failure("clock_invalid_state"); }
    private static void elapsed(long value) { if(value<0 || value>MAX_SAFE_INTEGER) throw failure("clock_invalid_state"); }
    private static long distance(long a,long b) { return a>=b ? a-b : b-a; }
    private static long addTime(long a,long delta) {
        if(delta<0 || delta>MAX_TIME_MS-a) throw failure("clock_invalid_state");
        return a+delta;
    }
    private static ClockException failure(String code) { return new ClockException(code); }
}
