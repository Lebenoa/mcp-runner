import { SessionHost } from '../src/host.ts';
import { startServer } from './server.ts';
Deno.test('Ask requires separate approval for consequential execution and sensitive disclosure',async()=>{
 const fixture=startServer();const host=new SessionHost(async()=>{});
 try{
  await host.handle({type:'save',profile:{name:'fixture',url:fixture.url+'/mcp',transport:'http'}});await host.handle({type:'connect',name:'fixture'});
  await host.handle({type:'preset',preset:'ask'});await host.handle({type:'rule',server:'fixture',tool:'echo',rule:{readOnly:false,consequential:true,sensitive:true}});
  const operation=host.handle({type:'invoke',command:{id:'risk',server:'fixture',tool:'echo',arguments:{value:'private-result'}},chat:'https://chat.deepseek.com/a/chat/s/fixture'});
  const execution=host.state.prompts[0];if(execution?.kind!=='execution'||fixture.calls!==0)throw new Error('Consequential action bypassed approval');
  await host.handle({type:'reply',id:execution.id,action:'accept'});
  for(let i=0;i<100 && host.state.prompts[0]?.kind!=='disclosure';i++){const {promise,resolve}=Promise.withResolvers<void>();setTimeout(resolve,5);await promise;}
  const disclosure=host.state.prompts[0];if(disclosure?.kind!=='disclosure'||!disclosure.message.includes('private-result'))throw new Error('Sensitive result bypassed disclosure review');
  await host.handle({type:'reply',id:disclosure.id,action:'decline'});
  let rejected=false;try{await operation;}catch{rejected=true;}
  if(!rejected||!JSON.stringify(host.state.results).includes('private-result'))throw new Error('Declined disclosure did not retain private result');
 }finally{await host.handle({type:'disconnect',name:'fixture'});await fixture.close();}
});
Deno.test('Yolo executes unreviewed and consequential tools and shares sensitive output without prompts',async()=>{
 const fixture=startServer();const host=new SessionHost(async()=>{});
 try{
  await host.handle({type:'save',profile:{name:'fixture',url:fixture.url+'/mcp',transport:'http'}});await host.handle({type:'connect',name:'fixture'});
  await host.handle({type:'preset',preset:'yolo'});
  for(const id of ['unreviewed','consequential']){
   if(id==='consequential')await host.handle({type:'rule',server:'fixture',tool:'echo',rule:{readOnly:false,consequential:true,sensitive:true}});
   const result=await host.handle({type:'invoke',command:{id,server:'fixture',tool:'echo',arguments:{value:'sensitive-'+id}},chat:'https://chat.deepseek.com/a/chat/s/yolo'});
   if(!JSON.stringify(result).includes('sensitive-'+id)||host.state.prompts.length)throw new Error('Yolo blocked execution or disclosure');
  }
  if(fixture.calls!==2)throw new Error('Yolo calls missing');
 }finally{await host.handle({type:'disconnect',name:'fixture'});await fixture.close();}
});
Deno.test('card approval binds exact command and chat and cannot be replayed',async()=>{
 const fixture=startServer();const host=new SessionHost(async()=>{});
 const chat='https://chat.deepseek.com/a/chat/s/approval';
 const command={id:'card',server:'fixture',tool:'echo',arguments:{value:'approved'}};
 try{
  await host.handle({type:'save',profile:{name:'fixture',url:fixture.url+'/mcp',transport:'http'}});await host.handle({type:'connect',name:'fixture'});
  await host.handle({type:'rule',server:'fixture',tool:'echo',rule:{readOnly:true,consequential:false,sensitive:false}});await host.handle({type:'preset',preset:'ask'});
  const operation=host.handle({type:'invoke',command,chat});const promptId=host.state.prompts[0].id;
  for(const action of [
   {type:'approve-command' as const,command:{...command,arguments:{value:'different'}},chat,promptId},
   {type:'approve-command' as const,command,chat:chat+'/other',promptId},
   {type:'approve-command' as const,command,chat,promptId:'expired'},
  ]){let rejected=false;try{await host.handle(action);}catch{rejected=true;}if(!rejected||fixture.calls!==0)throw new Error('Mismatched approval accepted');}
  await host.handle({type:'approve-command',command,chat,promptId});await operation;
  let rejected=false;try{await host.handle({type:'approve-command',command,chat,promptId});}catch{rejected=true;}
  if(!rejected||fixture.calls!==1)throw new Error('Approval replay accepted');
 }finally{await host.handle({type:'disconnect',name:'fixture'});await fixture.close();}
});
