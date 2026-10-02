import { SessionHost } from "../src/host.ts";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function fixture() {
  const sessions = new Set<string>();
  let initialized = 0, calls = 0, rejected = 0, deleted = 0;
  let failCalls = 0, failLists = 0, deleteStatus = 200;
  let description = "Echo";
  let gate: Promise<void> | undefined;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const session = request.headers.get("mcp-session-id");
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method === "DELETE") {
        deleted++;
        if (deleteStatus === 200 && session) sessions.delete(session);
        return new Response(null, { status: deleteStatus });
      }
      const message = await request.json();
      if (message.method === "initialize") {
        initialized++;
        if (gate) await gate;
        const id = crypto.randomUUID();
        sessions.add(id);
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "expiry", version: "1" },
          },
        }, { headers: { "mcp-session-id": id } });
      }
      if (
        !session || !sessions.has(session) ||
        (message.method === "tools/call" && failCalls-- > 0) ||
        (message.method === "tools/list" && failLists-- > 0)
      ) {
        rejected++;
        return new Response("Session not found", { status: 404 });
      }
      if (!("id" in message)) return new Response(null, { status: 202 });
      let result;
      if (message.method === "tools/list") {
        result = {
          tools: [{
            name: "echo",
            description,
            inputSchema: { type: "object" },
          }],
        };
      } else {
        calls++;
        result = {
          content: [{ type: "text", text: message.params.arguments.value }],
        };
      }
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}/mcp`,
    get initialized() {
      return initialized;
    },
    get calls() {
      return calls;
    },
    get rejected() {
      return rejected;
    },
    get deleted() {
      return deleted;
    },
    get live() {
      return sessions.size;
    },
    expire() {
      sessions.clear();
    },
    changeTool() {
      description = "Changed effects";
    },
    failCalls(n: number) {
      failCalls = n;
    },
    failLists(n: number) {
      failLists = n;
    },
    deleteStatus(n: number) {
      deleteStatus = n;
    },
    gate(p: Promise<void>) {
      gate = p;
    },
    close() {
      return server.shutdown();
    },
  };
}
async function setup() {
  const server = fixture();
  const host = new SessionHost(async () => {});
  await host.handle({
    type: "save",
    profile: { name: "fixture", url: server.url, transport: "http" },
  });
  await host.handle({ type: "connect", name: "fixture" });
  await host.handle({
    type: "rule",
    server: "fixture",
    tool: "echo",
    rule: { readOnly: true, consequential: false, sensitive: false },
  });
  const invoke = (id: string) =>
    host.handle({
      type: "invoke",
      command: {
        id,
        server: "fixture",
        tool: "echo",
        arguments: { value: id },
      },
    });
  return {
    server,
    host,
    invoke,
    async close() {
      await host.handle({ type: "disconnect", name: "fixture" });
      await server.close();
    },
  };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Scenario did not reach expected state");
}
Deno.test("expired HTTP session: concurrent calls share recovery and are never replayed", async () => {
  const f = await setup();
  try {
    f.server.expire();
    const results = await Promise.allSettled([f.invoke("one"), f.invoke("two")]);
    assert(
      results.every((result) => result.status === "rejected") &&
        String((results[0] as PromiseRejectedResult).reason).includes(
          "outcome is unknown",
        ) &&
        String((results[1] as PromiseRejectedResult).reason).includes(
          "outcome is unknown",
        ),
      "expired call was replayed instead of failing visibly",
    );
    assert(
      f.server.initialized === 2 && f.server.calls === 0,
      "recovery duplicated sessions or replayed calls",
    );
    assert(
      f.host.state.connections.fixture.status === "connected" &&
        !f.host.state.connections.fixture.error,
      "recovery left stale status",
    );
    await f.host.handle({ type: "disconnect", name: "fixture" });
    assert(
      f.server.deleted === 1 && f.server.live === 0,
      "disconnect leaked live session",
    );
  } finally {
    await f.close();
  }
});
Deno.test("rediscovery invalidates old classification for subsequent commands", async () => {
  const f = await setup();
  try {
    f.server.expire();
    f.server.changeTool();
    const outcome = await Promise.allSettled([f.invoke("changed")]);
    assert(
      outcome[0].status === "rejected",
      "expired call was replayed instead of failing visibly",
    );
    assert(
      f.host.state.connections.fixture.status === "connected",
      "session not restored after expiry",
    );
    const operation = f.invoke("changed-2");
    await until(() => f.host.state.prompts.length > 0);
    assert(
      f.server.calls === 0 && f.host.state.prompts[0].kind === "execution",
      "changed tool bypassed approval",
    );
    await f.host.handle({
      type: "reply",
      id: f.host.state.prompts[0].id,
      action: "accept",
    });
    await operation;
    assert(Number(f.server.calls) === 1, "approved retry not executed");
  } finally {
    await f.close();
  }
});
Deno.test("expired call restores the session but reports an unknown outcome", async () => {
  const f = await setup();
  try {
    f.server.failCalls(2);
    const result = await Promise.allSettled([f.invoke("bounded")]);
    assert(
      result[0].status === "rejected" && f.server.initialized === 2 &&
        f.server.calls === 0,
      "retry not bounded",
    );
    assert(
      f.host.state.connections.fixture.status === "connected" &&
        f.host.state.connections.fixture.tools.length > 0,
      "restored session not advertised",
    );
  } finally {
    await f.close();
  }
});
Deno.test("disconnect during replacement initialization cannot resurrect connection", async () => {
  const f = await setup();
  const gate = Promise.withResolvers<void>();
  try {
    f.server.expire();
    f.server.gate(gate.promise);
    const operation = Promise.allSettled([f.invoke("cancelled")]);
    await until(() => f.server.initialized === 2);
    await f.host.handle({ type: "disconnect", name: "fixture" });
    gate.resolve();
    await operation;
    assert(
      f.host.state.connections.fixture.status === "disconnected" &&
        !f.host.state.profiles[0].reconnect && f.server.calls === 0,
      "disconnect resurrected session",
    );
  } finally {
    gate.resolve();
    await f.close();
  }
});
for (const status of [405, 500]) {
  Deno.test(`DELETE ${status}: local disconnect completes`, async () => {
    const f = await setup();
    try {
      f.server.deleteStatus(status);
      await f.host.handle({ type: "disconnect", name: "fixture" });
      assert(
        f.server.deleted === 1 &&
          f.host.state.connections.fixture.status === "disconnected" &&
          !f.host.state.profiles[0].reconnect,
        "failed DELETE blocked local cleanup",
      );
      assert(
        status === 405
          ? !f.host.state.connections.fixture.error
          : !!f.host.state.connections.fixture.error,
        "termination failure reporting incorrect",
      );
    } finally {
      await f.close();
    }
  });
}
Deno.test("discovery 404 reinitializes once", async () => {
  const server = fixture();
  const host = new SessionHost(async () => {});
  try {
    server.failLists(1);
    await host.handle({
      type: "save",
      profile: { name: "fixture", url: server.url, transport: "http" },
    });
    await host.handle({ type: "connect", name: "fixture" });
    assert(
      server.initialized === 2 &&
        host.state.connections.fixture.status === "connected" &&
        host.state.connections.fixture.tools[0].name === "echo",
      "discovery failed to recover",
    );
  } finally {
    await host.handle({ type: "disconnect", name: "fixture" });
    await server.close();
  }
});
