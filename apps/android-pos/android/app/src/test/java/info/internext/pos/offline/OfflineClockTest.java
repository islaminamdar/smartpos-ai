package info.internext.pos.offline;
import static org.junit.Assert.*;
import static info.internext.pos.offline.OfflineClock.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;

public class OfflineClockTest {
 private static final String B="00000000-0000-4000-8000-000000000001",N="00000000-0000-4000-8000-000000000002";
 private static final long S=1792123200000L,U=1000000;
 private static Reading r(String b,long e,long w){return new Reading(b,e,w);}
 private static State initial(){return anchor(S,r(B,U,S));}
 private static Tick tick(State s,Reading r){return advance(s,r,S,S+86400000);}
 private static ClockException rejects(String code,Runnable run){ClockException e=assertThrows(ClockException.class,run::run);assertEquals(code,e.code);return e;}
 private static String json(JSONObject value)throws Exception{return new String(CanonicalJson.bytes(value),StandardCharsets.UTF_8);}
 @Test public void monotonicTimeRetainsOriginalAnchor(){State s=initial();Tick one=tick(s,r(B,U+1000,S+1100));assertEquals(S+1000,one.estimatedServerMs);Tick two=tick(one.nextState,r(B,U+2000,S+2300));assertEquals(S+2000,two.estimatedServerMs);assertEquals(S,two.nextState.anchorWallMs);assertEquals(U+2000,two.nextState.lastElapsedMs);assertEquals(S,s.highWaterServerMs);}
 @Test public void canonicalStateSurvivesProcessRestart(){State before=tick(initial(),r(B,U+1000,S+1000)).nextState;State after=State.fromJson(before.toJson());assertEquals(before.toJson(),after.toJson());assertEquals(S+2000,tick(after,r(B,U+2000,S+2000)).estimatedServerMs);}
 @Test public void detectsElapsedRollbackAfterLastTick(){State s=tick(initial(),r(B,U+2000,S+2000)).nextState;assertTrue(rejects("clock_rollback",()->tick(s,r(B,U+1500,S+2100))).isAnomaly());rejects("clock_rollback",()->tick(s,r(B,U-1,S+2100)));}
 @Test public void anyWallRollbackRejectsWithinOrAcrossBoot(){State s=tick(initial(),r(B,U+2000,S+2000)).nextState;rejects("clock_rollback",()->tick(s,r(B,U+3000,S+1999)));rejects("clock_rollback",()->tick(s,r(N,1000,S+1999)));}
 @Test public void smallDriftCannotResetToleranceEachTick(){State s=tick(initial(),r(B,U+1000,S+61000)).nextState;State next=tick(s,r(B,U+2000,S+122000)).nextState;rejects("clock_drift",()->tick(next,r(B,U+3000,S+183000)));}
 @Test public void bothForwardAndSlowDriftAreBounded(){assertEquals(S+1,tick(initial(),r(B,U+1,S+MAX_DRIFT_MS+1)).estimatedServerMs);rejects("clock_drift",()->tick(initial(),r(B,U+1,S+MAX_DRIFT_MS+2)));rejects("clock_drift",()->tick(initial(),r(B,U+MAX_DRIFT_MS+1,S)));}
 @Test public void rebootRecoversOfflineFromPersistedHighWater(){State s=State.fromJson(tick(initial(),r(B,U+10000,S+10000)).nextState.toJson());Tick reboot=tick(s,r(N,5000,S+70000));assertEquals(S+70000,reboot.estimatedServerMs);assertEquals(N,reboot.nextState.bootId);assertEquals(5000,reboot.nextState.anchorElapsedMs);assertEquals(S+71000,tick(reboot.nextState,r(N,6000,S+71000)).estimatedServerMs);}
 @Test public void rebootNeverSubtractsKnownUptime(){assertEquals(S+60000,tick(initial(),r(N,60000,S+1000)).estimatedServerMs);rejects("clock_drift",()->tick(initial(),r(N,MAX_DRIFT_MS+1002,S+1000)));}
 @Test public void startInclusiveExpiryExclusiveAreNotPermanentAnomalies(){assertEquals(S,advance(initial(),r(B,U,S),S,S+1).estimatedServerMs);assertFalse(rejects("clock_expired",()->advance(initial(),r(B,U+1,S+1),S,S+1)).isAnomaly());assertFalse(rejects("clock_not_started",()->advance(initial(),r(B,U,S),S+1,S+2)).isAnomaly());}
 @Test public void rebootCannotExtendExpiry(){rejects("clock_expired",()->advance(initial(),r(N,2000,S+5000),S,S+5000));}
 @Test public void badInitialOffsetAndUnsafeReadingsFailClosed(){rejects("clock_drift",()->anchor(S,r(B,U,S+MAX_DRIFT_MS+1)));rejects("clock_invalid_state",()->anchor(S,null));rejects("clock_invalid_state",()->r(B,-1,S));rejects("clock_invalid_state",()->r(B,Long.MAX_VALUE,S));rejects("clock_invalid_state",()->r(B,0,-1));rejects("clock_invalid_state",()->r("BAD",0,S));rejects("clock_invalid_state",()->r("00000000-0000-4000-8000-00000000000A",0,S));}
 @Test public void trustedServerOffsetIsRetained(){State s=anchor(S,r(B,U,S+30000));assertEquals(S+1000,tick(s,r(B,U+1000,S+31000)).estimatedServerMs);}
 @Test public void overflowAndBadAuthorityBoundsFailClosed(){State end=anchor(MAX_TIME_MS-100,r(B,0,MAX_TIME_MS-100));rejects("clock_invalid_state",()->advance(end,r(B,200,MAX_TIME_MS),0,MAX_TIME_MS));rejects("clock_invalid_state",()->advance(initial(),r(B,U,S),S,S));rejects("clock_invalid_state",()->advance(initial(),r(B,U,S),-1,S+1));rejects("clock_invalid_state",()->advance(null,r(B,U,S),S,S+1));}
 @Test public void persistedStateRejectsCoercionsMissingAndInconsistentFields()throws Exception{String original=initial().toJson();JSONObject missing=new JSONObject(original);missing.remove("lastElapsedMs");rejects("clock_invalid_state",()->State.fromJson(missing.toString()));JSONObject extra=new JSONObject(original).put("trusted",true);rejects("clock_invalid_state",()->State.fromJson(extra.toString()));JSONObject string=new JSONObject(original).put("anchorServerMs",Long.toString(S));rejects("clock_invalid_state",()->State.fromJson(string.toString()));String inconsistent=json(new JSONObject(original).put("highWaterServerMs",S+1));rejects("clock_invalid_state",()->State.fromJson(inconsistent));rejects("clock_invalid_state",()->State.fromJson(original.replace("\"schemaVersion\":1","\"schemaVersion\":1.0")));rejects("clock_invalid_state",()->State.fromJson(" "+original));rejects("clock_invalid_state",()->State.fromJson(null));}
}
