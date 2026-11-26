import { describe, test, expect } from "bun:test"
import plugin from "./index"

// Fix C: a continue re-sends the same oversized history, so a context-limit error
// can never be cleared by auto-resume. It must be treated as a permanent failure
// and latch, rather than climbing the stall ladder forever.
const SID = "ses_ctx"
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
  const injected:string[]=[]
  const history: Record<string,unknown[]> = { [SID]: [
    { type:"user", id:"u1", time:{created:Date.now()-60000}, content:[{type:"text",text:"do the work"}] },
    { type:"assistant", id:"a1", time:{created:Date.now()-1000}, content:[] },
  ]}
  const ctx:any={
    app:{name:"opencode",version:"2.0.27",channel:"stable"},
    event:stream,
    options:{ chunkTimeoutMs:120, toolTextCheckDelayMs:0, checkIntervalMs:20, gracePeriodMs:0, warmupMs:0, baseBackoffMs:1, maxBackoffMs:2, maxRetries:3, injectIntervalMs:0, subagentWaitMs:40, debug:false, registryScope:"FixCtxTest" },
    session:{ context:async(a:any)=>history[a?.sessionID??SID]??[], active:async()=>({[SID]:{}}), interrupt:async()=>({}), synthetic:async(a:any)=>(injected.push(a?.text),{}), prompt:async(a:any)=>(injected.push(a?.text),{}) },
    client:{session:{get:async()=>({data:{}}),list:async()=>({data:[{id:SID}]})}},
    storage:{get:async()=>({todos:[]}),set:async()=>{},remove:async()=>{}},
    tool:{transform:async()=>({dispose(){}}),list:async()=>[]},
  }
  const cleanup=await (plugin as any).setup(ctx)
  await wait(60)
  return {cleanup,injected,stream,history}
}

describe("fix C: context-limit errors latch permanently",()=>{
  test("a context-limit step failure does not produce repeated nudges", async()=>{
    const h=await setup()
    const err="input tokens exceed the model context limit (131072 > 131072)"
    for(let i=0;i<3;i++){
      h.stream.push({type:"session.step.failed",data:{sessionID:SID,error:{type:"provider.invalid-request",message:err}}})
      await wait(120)
    }
    await wait(400)
    // After the latch, no further stall nudges should land.
    const before=h.injected.length
    await wait(300)
    expect(h.injected.length).toBe(before)
    ;(h.cleanup as ()=>void)?.()
  })
})
