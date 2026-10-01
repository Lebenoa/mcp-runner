import { SessionHost } from '../src/host.ts';
Deno.test('elicitation prompts accept, decline, cancel explicitly',async()=>{
 const host=new SessionHost(async()=>{});
 const socket=Deno.serve({hostname:'127.0.0.1',port:0,onListen(){}},request=>{
  const {socket,response}=Deno.upgradeWebSocket(request,{protocol:'mcp'});
  socket.onmessage=event=>{
   const message=JSON.parse(event.data);
   if(message.method==='initialize') socket.send(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'elicitation',version:'1'}}}));
   if(message.method==='tools/list') socket.send(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{tools:[{name:'question',inputSchema:{type:'object'}}]}}));
   if(message.method==='tools/call'){
    const toolId=message.id;
    socket.send(JSON.stringify({jsonrpc:'2.0',id:'elicit',method:'elicitation/create',params:{message:'Choose a label',requestedSchema:{type:'object',properties:{label:{type:'string'}},required:['label']}}}));
    const old=socket.onmessage;
    socket.onmessage=e=>{const reply=JSON.parse(e.data);if(reply.id==='elicit'){socket.send(JSON.stringify({jsonrpc:'2.0',id:toolId,result:{content:[{type:'text',text:JSON.stringify(reply.result)}]}}));socket.onmessage=old;}else old?.call(socket,e);};
   }
  }; return response;
 });
 try{
  await host.handle({type:'save',profile:{name:'e',url:`ws://127.0.0.1:${socket.addr.port}`,transport:'ws'}}); await host.handle({type:'connect',name:'e'});
  await host.handle({type:'rule',server:'e',tool:'question',rule:{readOnly:true,consequential:false,sensitive:false}});
  await host.handle({type:'preset',preset:'yolo'});
  for(const action of ['accept','decline','cancel'] as const){
   const operation=host.handle({type:'invoke',command:{id:action,server:'e',tool:'question',arguments:{}}});
   for(let i=0;i<100 && !host.state.prompts.length;i++){const {promise,resolve}=Promise.withResolvers<void>();setTimeout(resolve,5);await promise;}
   const prompt=host.state.prompts[0];if(prompt?.kind!=='elicitation')throw new Error('No explicit elicitation prompt');
   await host.handle({type:'reply',id:prompt.id,action,...(action==='accept'?{content:{label:'approved'}}:{})});
   const result=await operation as {content:{text:string}[]}; const response=JSON.parse(result.content[0].text);
   if(response.action!==action || (action==='accept' && response.content.label!=='approved')) throw new Error('Incorrect elicitation response');
  }
 }finally{await host.handle({type:'disconnect',name:'e'});await socket.shutdown();}
});
