package info.internext.pos.offline;
import static org.junit.Assert.*;
import static info.internext.pos.offline.OfflineClock.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Android JSON/runtime compatibility; reboot readings are deterministic synthetic inputs. */
@RunWith(AndroidJUnit4.class)
public class OfflineClockAndroidTest {
 private static final String B="00000000-0000-4000-8000-000000000001",N="00000000-0000-4000-8000-000000000002";
 private static final long S=1792123200000L;
 @Test public void androidCanonicalJsonRoundTripKeepsClockState(){
  State original=anchor(S,new Reading(B,100000,S));
  Tick first=advance(original,new Reading(B,101000,S+1000),S,S+86400000);
  State reopened=State.fromJson(first.nextState.toJson());assertEquals(first.nextState.toJson(),reopened.toJson());
  Tick second=advance(reopened,new Reading(B,102000,S+2000),S,S+86400000);assertEquals(S+2000,second.estimatedServerMs);
 }
 @Test public void syntheticRebootMaintainsTimeWithoutOnlineDependency(){
  State state=State.fromJson(anchor(S,new Reading(B,100000,S)).toJson());
  Tick after=advance(state,new Reading(N,5000,S+60000),S,S+86400000);
  assertEquals(S+60000,after.estimatedServerMs);assertEquals(N,after.nextState.bootId);
 }
 @Test public void androidRuntimeRejectsRollbackAndExactExpiry(){
  State state=advance(anchor(S,new Reading(B,100000,S)),new Reading(B,101000,S+1000),S,S+86400000).nextState;
  try{advance(state,new Reading(B,100500,S+1100),S,S+86400000);fail("rollback accepted");}catch(ClockException error){assertEquals("clock_rollback",error.code);assertTrue(error.isAnomaly());}
  try{advance(state,new Reading(B,102000,S+2000),S,S+2000);fail("expiry accepted");}catch(ClockException error){assertEquals("clock_expired",error.code);assertFalse(error.isAnomaly());}
 }
}
