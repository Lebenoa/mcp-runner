import { SessionHost } from "../src/host.ts";
Deno.test("advertised execution timeout permits a response after SDK default deadline", async () => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      if (req.method === "GET") return new Response(null, { status: 405 });
      if (req.method === "DELETE") return new Response(null);
      const m = await req.json();
      if (!("id" in m)) return new Response(null, { status: 202 });
      if (m.method === "tools/call") {await new Promise((r) =>
          setTimeout(r, 61000)
        );}
      const result = m.method === "initialize"
        ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "long", version: "1" },
        }
        : m.method === "tools/list"
        ? {
          tools: [{
            name: "exec",
            inputSchema: {
              type: "object",
              properties: { timeout_ms: { type: "integer" } },
            },
          }],
        }
        : { content: [{ type: "text", text: "completed after 61 seconds" }] };
      return Response.json({ jsonrpc: "2.0", id: m.id, result }, {
        headers: { "mcp-session-id": "long" },
      });
    },
  );
  const host = new SessionHost(async () => {});
  try {
    await host.handle({
      type: "save",
      profile: {
        name: "long",
        transport: "http",
        url: `http://127.0.0.1:${server.addr.port}/mcp`,
      },
    });
    await host.handle({ type: "connect", name: "long" });
    await host.handle({ type: "preset", preset: "yolo" });
    const result = await host.handle({
      type: "invoke",
      command: {
        id: "long-run",
        server: "long",
        tool: "exec",
        arguments: { timeout_ms: 300000 },
      },
    });
    if (
      JSON.stringify(result) !==
        JSON.stringify({
          content: [{ type: "text", text: "completed after 61 seconds" }],
        })
    ) throw Error("long execution result lost");
    console.log("Long execution completed beyond the 60-second SDK deadline");
  } finally {
    await host.handle({ type: "disconnect", name: "long" });
    await server.shutdown();
  }
});
