import { SessionHost } from '../src/host.ts';
import { startServer } from './server.ts';
function assert(condition: unknown, message: string): asserts condition { if(!condition) throw new Error(message); }
Deno.test('pacing range is validated, persisted, and restored', async () => {
  let saved: { pacing?: { min: number; max: number } } | undefined;
  const host = new SessionHost(async state => { saved = { pacing: state.pacing }; });
  let rejected = false;
  try { await host.handle({type:'pacing',min:500,max:200}); } catch { rejected = true; }
  assert(rejected,'max below min was accepted');
  rejected = false;
  try { await host.handle({type:'pacing',min:-1,max:100}); } catch { rejected = true; }
  assert(rejected,'negative minimum was accepted');
  rejected = false;
  try { await host.handle({type:'pacing',min:0,max:60001}); } catch { rejected = true; }
  assert(rejected,'oversized maximum was accepted');
  await host.handle({type:'pacing',min:100,max:400});
  assert(host.state.pacing.min === 100 && host.state.pacing.max === 400,'pacing not stored');
  assert(saved?.pacing?.min === 100 && saved.pacing.max === 400,'pacing not persisted');
  const restored = new SessionHost(async()=>{});
  await restored.restore({ profiles: [], rules: {}, results: {}, preset: 'ask', pacing: saved?.pacing });
  assert(restored.state.pacing.min === 100 && restored.state.pacing.max === 400,'pacing lost on restore');
  const fresh = new SessionHost(async()=>{});
  await fresh.restore({ profiles: [], rules: {}, results: {}, preset: 'ask' });
  assert(fresh.state.pacing.min === 0 && fresh.state.pacing.max === 0,'pacing default is disabled');
});
Deno.test('pacing delays tool execution within the configured range', async () => {
  const fixture = startServer();
  const host = new SessionHost(async()=>{});
  try {
    await host.handle({type:'save',profile:{name:'fixture',url:fixture.url+'/mcp',transport:'http'}});
    await host.handle({type:'connect',name:'fixture'});
    await host.handle({type:'rule',server:'fixture',tool:'echo',rule:{readOnly:true,consequential:false,sensitive:false}});
    await host.handle({type:'invoke',command:{id:'unpaced',server:'fixture',tool:'echo',arguments:{value:'fast'}}});
    await host.handle({type:'pacing',min:150,max:250});
    const start = Date.now();
    await host.handle({type:'invoke',command:{id:'paced',server:'fixture',tool:'echo',arguments:{value:'slow'}}});
    const elapsed = Date.now() - start;
    assert(elapsed >= 150,`pacing delay was not applied before execution (${elapsed}ms)`);
    assert(fixture.calls === 2,'paced call did not execute');
  } finally {
    await host.handle({type:'disconnect',name:'fixture'});
    await fixture.close();
  }
});
