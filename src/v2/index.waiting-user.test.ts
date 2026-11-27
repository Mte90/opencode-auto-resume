import { describe, test, expect } from "bun:test"
import plugin from "./index"

// Fix D: a stop that says it is waiting on the user is a hand-off, not stalled
// work. An open todo must not revive it with a "please continue" reminder.
const SID = "ses_wait"
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

async function setup(tailText:string){
  const stream=makeStream()
  const injected:string[]=[]
  const history: Record<string,unknown[]> = { [SID]: [
    { type:"user", id:"u1", time:{created:Date.now()-60000}, content:[{type:"text",text:"do the work"}] },
    { type:"assistant", id:"a1", time:{created:Date.now()-1000}, content:[{type:"text",text:tailText}] },
  ]}
  const ctx:any={
    app:{name:"opencode",version:"2.0.27",channel:"stable"},
    event:stream,
    options:{ chunkTimeoutMs:150, toolTextCheckDelayMs:0, checkIntervalMs:20, gracePeriodMs:0, warmupMs:0, baseBackoffMs:1, maxBackoffMs:2, maxRetries:3, injectIntervalMs:0, subagentWaitMs:40, debug:false, registryScope:"FixWaitTest_"+tailText.slice(0,5) },
    session:{ context:async(a:any)=>history[a?.sessionID??SID]??[], active:async()=>({[SID]:{}}), interrupt:async()=>({}), synthetic:async(a:any)=>(injected.push(a?.text),{}), prompt:async(a:any)=>(injected.push(a?.text),{}) },
    client:{session:{get:async()=>({data:{}}),list:async()=>({data:[{id:SID}]})}},
    storage:{get:async()=>({todos:[{content:"remaining work",status:"pending"}]}),set:async()=>{},remove:async()=>{}},
    tool:{transform:async()=>({dispose(){}}),list:async()=>[]},
  }
  const cleanup=await (plugin as any).setup(ctx)
  await wait(60)
  return {cleanup,injected,stream,history}
}

describe("fix D: waiting-on-user stops are final",()=>{
  test("a stop that waits on the user does not get a todo reminder", async()=>{
    const h=await setup("Waiting on your go-ahead for the deploy. Overrides?")
    for(let i=0;i<3;i++){
      h.stream.push({type:"session.execution.started",data:{sessionID:SID}})
      await wait(160)
    }
    await wait(400)
    expect(h.injected.filter((t)=>String(t).includes("todo")||String(t).includes("remaining")).length).toBe(0)
    ;(h.cleanup as ()=>void)?.()
  })

  test("CONTROL: a plain stop with open todos still gets a reminder", async()=>{
    const h=await setup("Stopping here, more work remains on the list.")
    for(let i=0;i<3;i++){
      h.stream.push({type:"session.execution.started",data:{sessionID:SID}})
      await wait(160)
    }
    await wait(400)
    expect(h.injected.length).toBeGreaterThan(0)
    ;(h.cleanup as ()=>void)?.()
  })
})
