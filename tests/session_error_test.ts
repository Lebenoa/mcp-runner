import { SessionHost } from "../src/host.ts";
for (const status of [404, 500]) {
  Deno.test(`HTTP ${status}: ${status === 404 ? "replacement discovery failure surfaces" : "ambiguous failure is not retried"}`, async () => {
    let initialized = 0, calls = 0;
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }
        if (request.method === "DELETE") {
          return new Response(null, { status: 200 });
        }
        const message = await request.json();
        if (message.method === "initialize") initialized++;
        if (message.method === "tools/call") {
          calls++;
          return new Response("Session not found", { status });
        }
        if (
          initialized > 1 && message.method === "tools/list"
        ) return new Response("Session not found", { status: 404 });
        if (!("id" in message)) return new Response(null, { status: 202 });
        const result = message.method === "initialize"
          ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "error", version: "1" },
          }
          : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
        return Response.json({ jsonrpc: "2.0", id: message.id, result }, {
          headers: { "mcp-session-id": String(initialized) },
        });
      },
    );
    const host = new SessionHost(async () => {});
    try {
      await host.handle({
        type: "save",
        profile: {
          name: "fixture",
          url: `http://127.0.0.1:${server.addr.port}/mcp`,
          transport: "http",
        },
      });
      await host.handle({ type: "connect", name: "fixture" });
      await host.handle({ type: "preset", preset: "yolo" });
      const result = await Promise.allSettled([
        host.handle({
          type: "invoke",
          command: {
            id: "failure",
            server: "fixture",
            tool: "echo",
            arguments: {},
          },
        }),
      ]);
      if (
        result[0].status !== "rejected" || calls !== 1 ||
        initialized !== (status === 404 ? 2 : 1)
      ) throw new Error("incorrect retry boundary");
      if (
        status === 404 &&
        (host.state.connections.fixture.status !== "error" ||
          host.state.connections.fixture.tools.length)
      ) throw new Error("replacement failure advertised connected");
      if (!host.state.connections.fixture.error) {
        throw new Error("transport failure hidden");
      }
    } finally {
      await host.handle({ type: "disconnect", name: "fixture" });
      await server.shutdown();
    }
  });
}
