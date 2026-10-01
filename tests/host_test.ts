import { SessionHost } from '../src/host.ts';
import { startServer } from './server.ts';
function assert(condition: unknown, message: string): asserts condition { if(!condition) throw new Error(message); }
for(const transport of ['http','sse','ws'] as const) {
  Deno.test(`${transport}: discovery, approved tool, reattachment, disconnect`, async()=>{
    const fixture = startServer();
    const host = new SessionHost(async()=>{});
    try {
      await host.handle({type:'save',profile:{name:'fixture',url:transport === 'ws' ? fixture.url.replace('http:','ws:')+'/ws' : fixture.url+'/'+(transport==='http'?'mcp':'sse'),transport}});
      await host.handle({type:'connect',name:'fixture'});
      assert(host.state.connections.fixture.tools[0].name === 'echo','tool discovery failed');
      await host.handle({type:'rule',server:'fixture',tool:'echo',rule:{readOnly:true,consequential:false,sensitive:false}});
      const result = await host.handle({type:'invoke',command:{id:'one',server:'fixture',tool:'echo',arguments:{value:'transport-'+transport}},chat:'https://chat.deepseek.com/a/chat/1'}) as {content:{text:string}[]};
      assert(result.content[0].text === 'transport-'+transport,'tool result differs');
      const snapshot = await host.handle({type:'snapshot'}) as typeof host.state;
      assert(snapshot.connections.fixture.status==='connected' && fixture.calls===1,'reattachment lost session');
      let rejected=false;
      try {await host.handle({type:'invoke',command:{id:'one',server:'fixture',tool:'echo',arguments:{value:'changed'}},chat:'https://chat.deepseek.com/a/chat/1'});}catch{rejected=true;}
      assert(rejected && fixture.calls===1,'conflicting ID replay executed');
      await host.handle({type:'disconnect',name:'fixture'});
      assert(host.state.connections.fixture.status==='disconnected','disconnect failed');
    } finally {await host.handle({type:'disconnect',name:'fixture'});await fixture.close();}
  });
}
Deno.test('Ask and Auto-safe require approval for unreviewed tools',async()=>{
 const fixture=startServer(); const host=new SessionHost(async()=>{});
 try{
  await host.handle({type:'save',profile:{name:'fixture',url:fixture.url+'/mcp',transport:'http'}}); await host.handle({type:'connect',name:'fixture'});
  for(const preset of ['auto-safe','ask'] as const){
   await host.handle({type:'preset',preset});
   const operation=host.handle({type:'invoke',command:{id:preset,server:'fixture',tool:'echo',arguments:{value:preset}}});
   for(let i=0;i<100 && !host.state.prompts.length;i++){const {promise,resolve}=Promise.withResolvers<void>();setTimeout(resolve,5);await promise;}
   assert(host.state.prompts[0]?.kind==='execution','unclassified call skipped review');
   await host.handle({type:'reply',id:host.state.prompts[0].id,action:'accept'});
   await operation;
  }
  assert(fixture.calls===2,'approved calls missing');
 } finally{await host.handle({type:'disconnect',name:'fixture'});await fixture.close();}
});
Deno.test('startup reconnect restores intended sessions and isolates missing permissions and offline servers',async()=>{
 const fixture=startServer();const host=new SessionHost(async()=>{});
 const restored=new SessionHost(async()=>{},async profile=>profile.name!=='denied');
 try{
  await host.handle({type:'save',profile:{name:'active',url:fixture.url+'/mcp',transport:'http'}});await host.handle({type:'connect',name:'active'});
  await host.handle({type:'save',profile:{name:'off',url:fixture.url+'/mcp',transport:'http'}});await host.handle({type:'connect',name:'off'});await host.handle({type:'disconnect',name:'off'});
  const saved=structuredClone(host.state);
  saved.profiles.push({name:'denied',url:fixture.url+'/mcp',transport:'http',reconnect:true},{name:'offline',url:'http://127.0.0.1:1/mcp',transport:'http',reconnect:true});
  await restored.restore(saved);
  assert(restored.state.connections.active.status==='connected'&&restored.state.connections.active.tools[0].name==='echo','startup lost active tools');
  assert(restored.state.connections.off.status==='disconnected','explicit disconnect was not preserved');
  assert(restored.state.connections.denied.status==='error'&&restored.state.connections.offline.status==='error','startup failures were not isolated');
  const before=JSON.stringify(restored.state);
  const status=await restored.handle({type:'server-status',id:'query',chat:'https://chat.deepseek.com/a/chat/s/status'}) as {servers:{name:string;status:string;tools:string[]}[]};
  const activeServer=status.servers.find(server=>server.name==='active');
  assert(status.servers.length===4&&activeServer?.tools[0]==='echo'&&status.servers.find(server=>server.name==='off')?.status==='disconnected','status omitted saved servers');
  assert(!JSON.stringify(status).includes('127.0.0.1')&&JSON.stringify(restored.state)===before,'status leaked endpoint or changed sessions');
  const chat='https://chat.deepseek.com/a/chat/s/status';
  await restored.handle({type:'server-status',id:'disconnect',chat,action:'disconnect',server:'active'});
  assert(restored.state.profiles.find(profile=>profile.name==='active')?.reconnect===false,'model disconnect retained startup intent');
  await restored.handle({type:'server-status',id:'connect',chat,action:'connect',server:'active'});
  assert(restored.state.connections.active.status==='connected','model connect failed');
  let denied=false;try{await restored.handle({type:'server-status',id:'denied',chat,action:'connect',server:'denied'});}catch{denied=true;}
  assert(denied&&restored.state.connections.denied.status==='error','model connect bypassed endpoint permissions');
 }finally{await host.handle({type:'disconnect',name:'active'});await restored.handle({type:'disconnect',name:'active'});await fixture.close();}
});
