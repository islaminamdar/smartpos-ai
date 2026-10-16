import { beforeEach, expect, it, vi } from 'vitest'
const m=vi.hoisted(()=>({getShiftCloseState:vi.fn(),checkShiftClose:vi.fn(),closeShift:vi.fn(),retryShiftClose:vi.fn()}))
vi.mock('../../../apps/android-pos/node_modules/@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>true,getPlatform:()=> 'android',isPluginAvailable:()=>true},registerPlugin:()=>m}))
import {parseNativeShiftCloseState,getNativeShiftCloseState,checkNativeShiftClose,closeNativeShift,retryNativeShiftClose} from '../../../apps/android-pos/src/native'
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ready={schemaVersion:1,status:'ready',shiftId:id(1),commandId:null,countedCashFils:null,result:null,pinRequired:false,canClose:true,canRetry:false,reasonCode:null}
const pending={...ready,status:'pending',commandId:id(2),countedCashFils:12345,canClose:false,canRetry:true,reasonCode:'native_shift_close_uncertain'}
const closed={...pending,status:'closed',canRetry:false,reasonCode:null,result:{commandId:id(2),shiftId:id(1),countedCashFils:12345,expectedCashFils:12500,cashDifferenceFils:-155,closedAt:'2026-10-16T12:00:00.000Z'}}
beforeEach(()=>vi.resetAllMocks())
it('preserves signed counted cash, exact difference and locked original references',()=>{
 for(const state of [ready,pending,closed,{...pending,countedCashFils:null,canRetry:false,reasonCode:'pin_unlock_required'},{...closed,countedCashFils:null,result:null,reasonCode:'pin_unlock_required'}])expect(parseNativeShiftCloseState(state)).toEqual(state)
})
it.each([
 {...ready,extra:true},{...ready,canClose:false},{...ready,commandId:id(2)},{...ready,reasonCode:'future_reason'},
 {...pending,commandId:null},{...pending,countedCashFils:null},{...pending,countedCashFils:1.1},{...pending,countedCashFils:100000001},
 {...pending,canClose:true},{...closed,canRetry:true},{...closed,status:'pending'},
 {...closed,result:{...closed.result,shiftId:id(9)}},{...closed,result:{...closed.result,commandId:id(9)}},
 {...closed,result:{...closed.result,countedCashFils:1}},{...closed,result:{...closed.result,cashDifferenceFils:155}},
 {...closed,result:{...closed.result,expectedCashFils:Number.MAX_SAFE_INTEGER+1}},
 {...closed,result:{...closed.result,closedAt:'2026-02-31T12:00:00.000Z'}},
 {...closed,result:{...closed.result,closedAt:'2026-10-16T12:00:00Z'}},
])('rejects malformed or contradictory close metadata',v=>expect(()=>parseNativeShiftCloseState(v)).toThrow())
it('bridge sends only exact original IDs and integer count without secrets',async()=>{
 m.getShiftCloseState.mockResolvedValue(pending);m.checkShiftClose.mockResolvedValue(ready);m.closeShift.mockResolvedValue(closed);m.retryShiftClose.mockResolvedValue(closed)
 expect(await getNativeShiftCloseState()).toEqual(pending);expect(await checkNativeShiftClose()).toEqual(ready)
 expect(await closeNativeShift(id(1),12345)).toEqual(closed);expect(m.closeShift).toHaveBeenCalledExactlyOnceWith({shiftId:id(1),countedCashFils:12345})
 expect(await retryNativeShiftClose(id(2))).toEqual(closed);expect(m.retryShiftClose).toHaveBeenCalledExactlyOnceWith({commandId:id(2)})
})
it('rejects changed identity/count readbacks and invalid input before dispatch',async()=>{
 for(const amount of [-1,1.1,100000001,Infinity,NaN])await expect(closeNativeShift(id(1),amount)).rejects.toThrow()
 await expect(closeNativeShift('wrong',1)).rejects.toThrow();expect(m.closeShift).not.toHaveBeenCalled()
 for(const state of [{...pending,shiftId:id(9)},{...pending,countedCashFils:12346},ready]){m.closeShift.mockResolvedValue(state);await expect(closeNativeShift(id(1),12345)).rejects.toThrow()}
 m.retryShiftClose.mockResolvedValue({...pending,commandId:id(9)});await expect(retryNativeShiftClose(id(2))).rejects.toThrow()
})

it('parses actual Android SQLite/Keystore close and lost-response recovery output',async()=>{
 const {default:actual}=await import('./fixtures/native-shift-close-android-output.json')
 for(const value of Object.values(actual.states))expect(parseNativeShiftCloseState(value)).toEqual(value)
 expect(actual.states.pending.commandId).toBe(actual.states.closed.commandId)
 expect(actual.states.retryReady.countedCashFils).toBe(actual.states.closed.result.countedCashFils)
 expect(actual.states.signedOut).toMatchObject({countedCashFils:null,result:null,canRetry:false,canClose:false})
})
