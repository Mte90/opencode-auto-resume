import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

// Fix B: repeated rate-limit failures with no user turn keep renewing the
// cooldown ladder, so it never exhausts and the session is nudged forever.
// A counter must latch a stand-down after a few such recoveries. The stand-down
// is observable in the plugin log line "quota loop ... standing down".
const SID = "ses_quota"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeStream() {
  const q: any[] = []; const ws: ((e: any)=>void)[] = []
  const s: any = {
    push(e:any){ if(ws.length) ws.shift()!(e); else q.push(e) },
    subscribe: () => s,
    [Symbol.asyncIterator](){ return { next: () => new Promise((res)=>{ if(q.length) return res({value:q.shift(),done:false}); ws.push((e)=>res({value:e,done:false})) }) } },
  }
  return s
}

async function setup(){
  const stream=makeStream()
  const capture=capturePluginLogs()
  const history: Record<string,unknown[]> = { [SID]: [
    { type:"user", id:"u1", time:{created:Date.now()-60000}, content:[{type:"text",text:"do the work"}] },
    { type:"assistant", id:"a1", time:{created:Date.now()-1000}, content:[] },
  ]}
  const ctx:any={
    app:{name:"opencode",version:"2.0.27",channel:"stable"},
    event:stream,
    options:{ chunkTimeoutMs:150, toolTextCheckDelayMs:0, checkIntervalMs:20, gracePeriodMs:0, warmupMs:0, baseBackoffMs:1, maxBackoffMs:2, maxRetries:3, injectIntervalMs:0, subagentWaitMs:40, debug:false, registryScope:"FixQuotaTestB" },
    session:{ context:async(a:any)=>history[a?.sessionID??SID]??[], active:async()=>({[SID]:{}}), interrupt:async()=>({}), synthetic:async()=>({}), prompt:async()=>({}) },
    client:{session:{get:async()=>({data:{}}),list:async()=>({data:[{id:SID}]})}},
    storage:{get:async()=>({todos:[]}),set:async()=>{},remove:async()=>{}},
    tool:{transform:async()=>({dispose(){}}),list:async()=>[]},
  }
  const cleanup=await (plugin as any).setup(ctx)
  await wait(60)
  return {cleanup,stream,history,capture}
}

describe("fix B: quota fail-loop stand-down",()=>{
  test("repeated rate-limit failures latch a stand-down", async()=>{
    const h=await setup()
    for(let i=0;i<8;i++){
      h.stream.push({type:"session.step.failed",data:{sessionID:SID,error:{type:"provider.rate-limit",message:"429 too many requests"}}})
      await wait(100)
    }
    await wait(300)
    const log=h.capture.lines.join("\n")
    expect(/quota loop \(\d+ rate-limit recoveries/.test(log)).toBe(true)
    h.cleanup?.(); h.capture.stop()
  })
})
