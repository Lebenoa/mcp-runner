import { SessionHost } from '../src/host.ts';
import { ruleKey } from '../src/contracts.ts';
import { startServer } from './server.ts';
function assert(condition: unknown, message: string): asserts condition { if(!condition) throw new Error(message); }
async function until(predicate: () => boolean) {
  for(let i=0;i<200;i++){ if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,5)); }
  throw new Error('Scenario did not reach expected state');
}
Deno.test('disconnecting one server leaves another server\'s pending approval intact', async () => {
  const a = startServer(), b = startServer();
  const host = new SessionHost(async()=>{});
  try {
    await host.handle({type:'save',profile:{name:'a',url:a.url+'/mcp',transport:'http'}});
    await host.handle({type:'save',profile:{name:'b',url:b.url+'/mcp',transport:'http'}});
    await host.handle({type:'connect',name:'a'});
    await host.handle({type:'connect',name:'b'});
    await host.handle({type:'preset',preset:'ask'});
    const operation = host.handle({type:'invoke',command:{id:'pending',server:'b',tool:'echo',arguments:{value:'later'}}});
    await until(() => host.state.prompts.length > 0);
    await host.handle({type:'disconnect',name:'a'});
    assert(host.state.prompts.length === 1 && host.state.prompts[0].kind === 'execution','unrelated server prompt was cancelled');
    await host.handle({type:'reply',id:host.state.prompts[0].id,action:'accept'});
    await operation;
    assert(b.calls === 1,'surviving approval could not execute');
  } finally {
    await host.handle({type:'disconnect',name:'b'});
    await a.close(); await b.close();
  }
});
Deno.test('disconnecting a server cancels its own pending prompt with an accurate error', async () => {
  const server = startServer();
  const host = new SessionHost(async()=>{});
  try {
    await host.handle({type:'save',profile:{name:'fixture',url:server.url+'/mcp',transport:'http'}});
    await host.handle({type:'connect',name:'fixture'});
    await host.handle({type:'preset',preset:'ask'});
    const operation = host.handle({type:'invoke',command:{id:'waiting',server:'fixture',tool:'echo',arguments:{value:'gone'}}});
    await until(() => host.state.prompts.length > 0);
    const outcome = Promise.allSettled([operation]);
    await host.handle({type:'disconnect',name:'fixture'});
    const [settled] = await outcome;
    assert(settled.status === 'rejected','cancelled execution reported success');
    const error = String((settled as PromiseRejectedResult).reason);
    assert(!error.includes('declined'),`cancel misreported as user decline: ${error}`);
    assert(!host.state.prompts.length,'cancelled prompt was left pending');
    assert(server.calls === 0,'cancelled command executed anyway');
  } finally { await server.close(); }
});
Deno.test('profile rename keeps reviews; endpoint change drops them', async () => {
  const one = startServer(), two = startServer();
  const host = new SessionHost(async()=>{});
  try {
    await host.handle({type:'save',profile:{name:'one',url:one.url+'/mcp',transport:'http'}});
    await host.handle({type:'connect',name:'one'});
    await host.handle({type:'rule',server:'one',tool:'echo',rule:{readOnly:true,consequential:false,sensitive:false}});
    assert(host.state.rules[ruleKey('one','echo')],'rule missing before rename');
    await host.handle({type:'disconnect',name:'one'});
    await host.handle({type:'save',profile:{name:'two',url:one.url+'/mcp',transport:'http'},originalName:'one'});
    assert(host.state.rules[ruleKey('two','echo')] && !host.state.rules[ruleKey('one','echo')],'pure rename dropped the review');
    await host.handle({type:'connect',name:'two'});
    await host.handle({type:'rule',server:'two',tool:'echo',rule:{readOnly:true,consequential:false,sensitive:false}});
    await host.handle({type:'disconnect',name:'two'});
    await host.handle({type:'save',profile:{name:'three',url:two.url+'/mcp',transport:'http'},originalName:'two'});
    assert(!host.state.rules[ruleKey('three','echo')],'endpoint change kept the stale review');
  } finally {
    await one.close(); await two.close();
  }
});
Deno.test('restore rejects an out-of-domain persisted preset', async () => {
  const host = new SessionHost(async()=>{});
  await host.restore({ profiles: [], rules: {}, results: {}, preset: 'bogus' as typeof host.state.preset });
  assert(host.state.preset === 'auto-safe','corrupt persisted preset was trusted');
  await host.restore({ profiles: [], rules: {}, results: {}, preset: 'yolo' });
  assert((host.state.preset as string) === 'yolo','valid persisted preset was discarded');
});
