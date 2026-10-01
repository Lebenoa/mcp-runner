import { SessionHost } from "../src/host.ts";
Deno.test("request timeout restores session without replaying ambiguous call", async () => {
  let initialized = 0, calls = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method === "DELETE") {return new Response(null, {
          status: 200,
        });}
      const m = await request.json();
      if (m.method === "initialize") initialized++;
      if (!("id" in m)) return new Response(null, { status: 202 });
      if (m.method === "tools/call" && ++calls === 1) {return new Response(
          null,
          { status: 202 },
        );}
      const result = m.method === "initialize"
        ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "timeout", version: "1" },
        }
        : m.method === "tools/list"
        ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "next command succeeds" }] };
      return Response.json({ jsonrpc: "2.0", id: m.id, result }, {
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
    const invoke = (id: string) =>
      host.handle({
        type: "invoke",
        command: { id, server: "fixture", tool: "echo", arguments: {} },
      });
    const [first] = await Promise.allSettled([invoke("ambiguous")]);
    if (
      first.status !== "rejected" ||
      !String(first.reason).includes("Request timed out")
    ) throw Error("timeout must remain visible");
    if (
      initialized !== 2 || calls !== 1 ||
      host.state.connections.fixture.status !== "connected"
    ) throw Error("session not restored or ambiguous command replayed");
    const next = await invoke("next");
    if (
      JSON.stringify(next) !==
        JSON.stringify({
          content: [{ type: "text", text: "next command succeeds" }],
        }) || Number(calls) !== 2
    ) throw Error("next command failed");
  } finally {
    await host.handle({ type: "disconnect", name: "fixture" });
    await server.shutdown();
  }
});
