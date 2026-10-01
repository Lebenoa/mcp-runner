import { SessionHost } from '../src/host.ts';
import { startServer } from './server.ts';
function assert(condition: unknown, message: string): asserts condition { if(!condition) throw new Error(message); }
Deno.test('delay ranges are validated, persisted, and restored independently', async () => {
  let saved: { pacing?: unknown } | undefined;
  const host = new SessionHost(async state => { saved = { pacing: state.pacing }; });
  for (const action of [
    { type: 'execution-delay' as const, min: 500, max: 200 },
    { type: 'response-delay' as const, min: -1, max: 100 },
    { type: 'execution-delay' as const, min: 0, max: 60001 },
  ]) {
    let rejected = false;
    try { await host.handle(action); } catch { rejected = true; }
    assert(rejected,`invalid range accepted: ${JSON.stringify(action)}`);
  }
  await host.handle({type:'execution-delay',min:100,max:400});
  await host.handle({type:'response-delay',min:200,max:800});
  assert(host.state.pacing.execution.min === 100 && host.state.pacing.execution.max === 400,'execution delay not stored');
  assert(host.state.pacing.response.min === 200 && host.state.pacing.response.max === 800,'response delay not stored');
  const restored = new SessionHost(async()=>{});
  await restored.restore({ profiles: [], rules: {}, results: {}, preset: 'ask', pacing: saved?.pacing as never });
  assert(restored.state.pacing.execution.min === 100 && restored.state.pacing.execution.max === 400,'execution delay lost on restore');
  assert(restored.state.pacing.response.min === 200 && restored.state.pacing.response.max === 800,'response delay lost on restore');
  const fresh = new SessionHost(async()=>{});
  await fresh.restore({ profiles: [], rules: {}, results: {}, preset: 'ask' });
  assert(fresh.state.pacing.execution.min === 0 && fresh.state.pacing.execution.max === 0 && fresh.state.pacing.response.min === 0 && fresh.state.pacing.response.max === 0,'delay default is disabled');
});
Deno.test('execution delay applies before tool execution within the configured range', async () => {
  const fixture = startServer();
  const host = new SessionHost(async()=>{});
  try {
    await host.handle({type:'save',profile:{name:'fixture',url:fixture.url+'/mcp',transport:'http'}});
    await host.handle({type:'connect',name:'fixture'});
    await host.handle({type:'rule',server:'fixture',tool:'echo',rule:{readOnly:true,consequential:false,sensitive:false}});
    await host.handle({type:'invoke',command:{id:'unpaced',server:'fixture',tool:'echo',arguments:{value:'fast'}}});
    await host.handle({type:'execution-delay',min:150,max:250});
    const start = Date.now();
    await host.handle({type:'invoke',command:{id:'paced',server:'fixture',tool:'echo',arguments:{value:'slow'}}});
    const elapsed = Date.now() - start;
    assert(elapsed >= 150,`execution delay was not applied (${elapsed}ms)`);
    assert(fixture.calls === 2,'paced call did not execute');
  } finally {
    await host.handle({type:'disconnect',name:'fixture'});
    await fixture.close();
  }
});
