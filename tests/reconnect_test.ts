import { SessionHost } from '../src/host.ts';
import { startServer } from './server.ts';
function assert(condition: unknown, message: string): asserts condition { if(!condition) throw new Error(message); }
async function until(predicate: () => boolean, limit = 200, step = 5) {
  for(let i=0;i<limit;i++){ if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,step)); }
  throw new Error('Scenario did not reach expected state');
}
Deno.test('unexpected connection loss retries after 5 seconds and reconnects on its own', async () => {
  const fixture = startServer();
  const host = new SessionHost(async()=>{});
  try {
    await host.handle({type:'save',profile:{name:'w',url:fixture.url.replace('http:','ws:')+'/ws',transport:'ws'}});
    await host.handle({type:'connect',name:'w'});
    assert(host.state.profiles[0].reconnect === true,'connected profile lost reconnection intent');
    fixture.closeSockets();
    await until(() => host.state.connections.w.status === 'disconnected');
    // The server never came back down; the host must reconnect on its own.
    await until(() => host.state.connections.w.status === 'connected', 300, 50);
    assert(!host.state.connections.w.error,'reconnected session kept a stale error');
  } finally {
    await host.handle({type:'disconnect',name:'w'});
    await fixture.close();
  }
});
Deno.test('explicit disconnect stops the retry loop', async () => {
  const fixture = startServer();
  const host = new SessionHost(async()=>{});
  try {
    await host.handle({type:'save',profile:{name:'w',url:fixture.url.replace('http:','ws:')+'/ws',transport:'ws'}});
    await host.handle({type:'connect',name:'w'});
    fixture.closeSockets();
    await until(() => host.state.connections.w.status === 'disconnected');
    await host.handle({type:'disconnect',name:'w'});
    await new Promise(resolve=>setTimeout(resolve,6000));
    assert(host.state.connections.w.status === 'disconnected','explicit disconnect did not stop retries');
  } finally {
    await host.handle({type:'disconnect',name:'w'});
    await fixture.close();
  }
});
