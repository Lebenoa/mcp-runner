import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "../src/vendor/streamableHttp.js";
Deno.test("SSE errors terminate streams; unfinished POSTs still resume", async () => {
  const resumes: string[] = [];
  let interruptedId: unknown;
  const sse = (value: unknown, id: string) =>
    new Response(
      `id: ${id}\nevent: message\ndata: ${JSON.stringify(value)}\n\n`,
      {
        headers: {
          "content-type": "text/event-stream",
          "mcp-session-id": "fixture",
        },
      },
    );
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      if (req.method === "GET") {
        const token = req.headers.get("last-event-id");
        if (!token) return new Response(null, { status: 405 });
        resumes.push(token);
        if (token === "unfinished") {
          return sse({
            jsonrpc: "2.0",
            id: interruptedId,
            result: { content: [{ type: "text", text: "resumed" }] },
          }, "finished");
        }
        return new Response(null, { status: 405 });
      }
      const m = await req.json();
      if (m.params?.arguments?.interrupted) interruptedId = m.id;
      if (!("id" in m)) return new Response(null, { status: 202 });
      if (m.method === "initialize") {
        return sse({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        }, "init");
      }
      if (m.params.arguments.interrupted) {
        return new Response("id: unfinished\nretry: 10\ndata: \n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return sse(
        m.params.arguments.fail
          ? {
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32603, message: "expected tool failure" },
          }
          : {
            jsonrpc: "2.0",
            id: m.id,
            result: { content: [{ type: "text", text: "success" }] },
          },
        `terminal-${m.id}`,
      );
    },
  );
  const client = new Client({ name: "regression", version: "1" }, {
    capabilities: {},
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.addr.port}/mcp`),
    {
      reconnectionOptions: {
        initialReconnectionDelay: 10,
        maxReconnectionDelay: 10,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 1,
      },
    },
  );
  try {
    await client.connect(transport);
    const errors = await Promise.allSettled(
      Array.from(
        { length: 12 },
        () => client.callTool({ name: "echo", arguments: { fail: true } }),
      ),
    );
    if (
      errors.some((r) =>
        r.status !== "rejected" ||
        !String(r.reason).includes("expected tool failure")
      )
    ) throw Error("errors changed");
    await new Promise((r) => setTimeout(r, 60));
    if (resumes.length) throw Error("completed error stream resumed");
    const next = await client.callTool({ name: "echo", arguments: {} });
    if (
      JSON.stringify(next) !==
        JSON.stringify({ content: [{ type: "text", text: "success" }] })
    ) throw Error("next command failed");
    const resumed = await client.callTool(
      { name: "echo", arguments: { interrupted: true } },
      undefined,
      { timeout: 1000 },
    );
    if (
      JSON.stringify(resumed) !==
        JSON.stringify({ content: [{ type: "text", text: "resumed" }] })
    ) throw Error("interrupted response lost");
    if (!resumes.includes("unfinished")) {
      throw Error("interrupted stream did not resume");
    }
  } finally {
    await client.close();
    await server.shutdown();
  }
});
