export function startServer() {
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  let calls = 0;
  const encoder = new TextEncoder();
  const tool = { name:'echo', description:'Echo a value', inputSchema:{ type:'object', properties:{ value:{type:'string'} }, required:['value'] }, outputSchema:{ type:'object', properties:{value:{type:'string'}},required:['value'] }, annotations:{ readOnlyHint:true } };
  function response(message: Record<string, unknown>) {
    if (!('id' in message)) return undefined;
    const params = message.params as Record<string, unknown>;
    const result = message.method === 'initialize' ? { protocolVersion:'2025-06-18', capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'} }
      : message.method === 'tools/list' ? {tools:[tool]} : message.method === 'tools/call' ? (calls++, { content:[{type:'text',text:String((params.arguments as Record<string,unknown>).value)}],structuredContent:{value:String((params.arguments as Record<string,unknown>).value)} }) : {};
    return {jsonrpc:'2.0',id:message.id,result};
  }
  const server = Deno.serve({hostname:'127.0.0.1',port:0,onListen(){}}, async request => {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const {socket,response:upgrade} = Deno.upgradeWebSocket(request,{protocol:'mcp'});
      let toolId: unknown;
      socket.onmessage = event => {
        const message=JSON.parse(event.data);
        if(message.method==='tools/call' && message.params.arguments.value==='workspace-approval'){
          toolId=message.id;
          socket.send(JSON.stringify({jsonrpc:'2.0',id:'workspace-elicit',method:'elicitation/create',params:{message:"Allow this server to switch its workspace to 'S:\\Data\\CODE\\Rust'? This changes the directory used by read, write, edit, list, grep, and trusted exec when exec is enabled.",requestedSchema:{type:'object',properties:{approved_path:{type:'string'}},required:['approved_path']}}}));return;
        }
        if(message.id==='workspace-elicit'){
          const text=JSON.stringify(message.result);
          socket.send(JSON.stringify({jsonrpc:'2.0',id:toolId,result:{content:[{type:'text',text}],structuredContent:{value:text}}}));return;
        }
        const result = response(message); if(result) socket.send(JSON.stringify(result));
      };
      return upgrade;
    }
    if (url.pathname === '/sse') {
      const id = crypto.randomUUID();
      const stream = new ReadableStream<Uint8Array>({ start(controller) { streams.set(id,controller); controller.enqueue(encoder.encode(`event: endpoint\ndata: /messages?session=${id}\n\n`)); }, cancel(){ streams.delete(id); } });
      return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
    }
    if (request.method === 'DELETE') return new Response(null,{status:200});
    if (request.method === 'GET') return new Response(null,{status:405});
    const message = await request.json();
    const result = response(message);
    if (url.pathname === '/messages') {
      if(result) streams.get(url.searchParams.get('session')!)?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(result)}\n\n`));
      return new Response(null,{status:202});
    }
    if (!result) return new Response(null,{status:202});
    return Response.json(result,{headers:{'Mcp-Session-Id':'fixture-session'}});
  });
  return {url:`http://127.0.0.1:${server.addr.port}`, get calls(){return calls;}, tool, async close(){ for(const controller of streams.values()) { try {controller.close();}catch{} } await server.shutdown(); }};
}
