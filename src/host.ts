import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "./vendor/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import {
  type ElicitRequest,
  ElicitRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import {
  type Action,
  type Command,
  chatKey,
  decodeCommand,
  fingerprint,
  type Prompt,
  redact,
  ruleKey,
  type Snapshot,
  type Tool,
} from "./contracts.ts";
import type { Profile, Rule } from "./contracts.ts";
import { prefillElicitationSchema } from "./elicitation-schema.ts";
import { createSystemPrompt } from "./system-prompt.ts";

const PRESETS = ["auto-safe", "ask", "server-perms", "yolo"] as const;
const RECONNECT_DELAY = 5000;
const MAX_PACING = 60000;
function pacingRange(value: unknown): { min: number; max: number } {
  const range = value as { min?: unknown; max?: unknown } | undefined;
  if (
    typeof range?.min !== "number" || !Number.isSafeInteger(range.min) ||
    typeof range?.max !== "number" || !Number.isSafeInteger(range.max)
  ) return { min: 0, max: 0 };
  const min = Math.min(Math.max(0, range.min), MAX_PACING);
  return { min, max: Math.min(Math.max(range.max, min), MAX_PACING) };
}
const RESULT_LIMIT = 100;
const PROMPT_LIMIT = 50;

export class SessionHost {
  state: Snapshot = {
    profiles: [],
    preset: "auto-safe",
    connections: {},
    rules: {},
    prompts: [],
    results: {},
    pacing: { execution: { min: 0, max: 0 }, response: { min: 0, max: 0 } },
  };
  private clients = new Map<string, Client>();
  private transports = new Map<
    string,
    | StreamableHTTPClientTransport
    | SSEClientTransport
    | WebSocketClientTransport
  >();
  private recovering = new Map<string, Promise<void>>();
  private calls = new Map<Client, Set<Promise<unknown>>>();
  private pending = new Map<
    string,
    (
      reply: {
        action: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
      },
    ) => void
  >();
  private running = new Map<string, Promise<unknown>>();
  private commands = new Map<string, string>();
  // Tombstones for results evicted by pruneResults: replay protection must
  // outlive the payload, or re-invoking an old id silently re-executes.
  private completed = new Set<string>();
  private connecting = new Map<string, Promise<void>>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private persist: (state: Snapshot) => Promise<void>,
    private canReconnect: (profile: Profile) => Promise<boolean> = async () =>
      true,
  ) {}
  async restore(saved?: Partial<Snapshot>) {
    if (!saved) return;
    this.state.profiles = (saved.profiles ?? []).filter((profile) =>
      profile && typeof profile.name === "string" && !!profile.name.trim() &&
      typeof profile.url === "string" && !!profile.url.trim() &&
      ["http", "sse", "ws"].includes(profile.transport)
    );
    // Storage content is untrusted: a corrupted rule could skip approval
    // gates, so validate shape at the entry point, not at use.
    this.state.rules = Object.fromEntries(
      Object.entries(saved.rules ?? {}).filter(([, rule]) =>
        !!rule && typeof rule === "object" &&
        typeof (rule as Rule).fingerprint === "string" &&
        typeof (rule as Rule).readOnly === "boolean" &&
        typeof (rule as Rule).consequential === "boolean" &&
        typeof (rule as Rule).sensitive === "boolean"
      ),
    ) as Snapshot["rules"];
    this.state.preset = saved.preset && PRESETS.includes(saved.preset)
      ? saved.preset
      : "auto-safe";
    this.state.results = saved.results ?? {};
    this.state.customPrompt = typeof saved.customPrompt === "string" &&
        saved.customPrompt.trim() && saved.customPrompt.length <= 20000
      ? saved.customPrompt
      : undefined;
    this.state.pacing = {
      execution: pacingRange(saved.pacing?.execution),
      response: pacingRange(saved.pacing?.response),
    };
    for (const profile of this.state.profiles) {
      this.state.connections[profile.name] = {
        status: "disconnected",
        tools: [],
      };
    }
    await Promise.all(
      this.state.profiles.filter((profile) => profile.reconnect).map(
        async (profile) => {
          try {
            if (!await this.canReconnect(profile)) {
              throw new Error(
                "Endpoint permission missing; reconnect from sidebar",
              );
            }
            await this.connect(profile.name);
          } catch (error) {
            this.state.connections[profile.name] = {
              status: "error",
              tools: [],
              error: String(error),
            };
          }
        },
      ),
    );
  }
  private prompt(prompt: Omit<Prompt, "id">): {
    id: string;
    reply: Promise<{
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    }>;
  } {
    if (this.state.prompts.length >= PROMPT_LIMIT) {
      throw new Error("Too many pending prompts; resolve or cancel some first");
    }
    const id = crypto.randomUUID();
    this.state.prompts.push({ ...prompt, id });
    const { promise, resolve } = Promise.withResolvers<
      {
        action: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
      }
    >();
    this.pending.set(id, resolve);
    return {
      id,
      reply: (async () => {
        try {
          return await promise;
        } finally {
          this.pending.delete(id);
          this.state.prompts = this.state.prompts.filter((p) => p.id !== id);
        }
      })(),
    };
  }
  private cancelServerPrompts(name: string) {
    for (const [id, resolve] of this.pending) {
      const prompt = this.state.prompts.find((p) => p.id === id);
      if (
        prompt &&
        (prompt.kind === "elicitation"
          ? prompt.server
          : prompt.command?.server) === name
      ) resolve({ action: "cancel" });
    }
  }
  // Unexpected connection loss retries every RECONNECT_DELAY until the server
  // answers; an explicit disconnect clears the timer and stops the loop. A
  // revoked endpoint permission stops the loop until the user connects again.
  private scheduleReconnect(name: string) {
    if (this.reconnectTimers.has(name) || this.clients.has(name)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(name);
      const profile = this.state.profiles.find((p) => p.name === name);
      if (!profile?.reconnect) return;
      void this.canReconnect(profile).then((allowed) => {
        if (!allowed) return;
        return this.connect(name).catch(() => this.scheduleReconnect(name));
      }).catch(() => {});
    }, RECONNECT_DELAY);
    this.reconnectTimers.set(name, timer);
  }
  async handle(action: Action): Promise<unknown> {
    switch (action.type) {
      case "snapshot":
        return structuredClone(this.state);
      case "server-status": {
        if (action.action) {
          const profile = this.state.profiles.find((profile) =>
            profile.name === action.server
          );
          if (!profile) throw new Error("Unknown profile");
          if (action.action === "connect") {
            if (!await this.canReconnect(profile)) {
              throw new Error("Grant endpoint permission from the sidebar");
            }
            await this.connect(profile.name);
          } else await this.disconnect(profile.name);
        } else if (action.server !== undefined) {
          throw new Error("Server requires connect or disconnect action");
        }
        return {
          servers: this.state.profiles.map((profile) => {
            const connection = this.state.connections[profile.name];
            const error = connection?.error && redact(connection.error);
            return {
              name: profile.name,
              transport: profile.transport,
              status: connection?.status ?? "disconnected",
              ...(error ? { error } : {}),
              tools: (connection?.tools ?? []).map((tool) => tool.name),
            };
          }),
        };
      }
      case "page-snapshot":
        return {
          systemPrompt: createSystemPrompt(this.state),
          pacing: this.state.pacing,
        };
      case "reply-elicitation": {
        const prompt = this.state.prompts.find((p) =>
          p.id === action.promptId && p.kind === "elicitation" &&
          p.server === action.command.server
        );
        if (
          !prompt ||
          !this.running.has(JSON.stringify([chatKey(action.chat), action.command.id])) ||
          this.commands.get(
              JSON.stringify([chatKey(action.chat), action.command.id]),
            ) !== JSON.stringify(action.command)
        ) throw new Error("Elicitation expired or command mismatch");
        if (
          action.action === "accept" && prompt.schema &&
          !new CfWorkerJsonSchemaValidator().getValidator(
              prompt.schema as Record<string, unknown>,
            )((action.content ?? {}) as Record<string, unknown>).valid
        ) throw new Error("Elicitation reply does not satisfy the requested schema");
        const resolve = this.pending.get(prompt.id);
        if (!resolve) throw new Error("Elicitation expired");
        this.pending.delete(prompt.id);
        resolve({ action: action.action, content: action.content });
        return;
      }
      case "approval-status":
      case "approve-command": {
        const prompt = this.state.prompts.find((p) =>
          p.kind === "execution" && p.chat === action.chat &&
          JSON.stringify(p.command) === JSON.stringify(action.command)
        );
        if (action.type === "approval-status") {
          const waiting = this.state.prompts.find((p) =>
            p.chat === action.chat &&
            JSON.stringify(p.command) === JSON.stringify(action.command)
          ) ?? this.state.prompts.find((p) =>
            p.kind === "elicitation" && p.server === action.command.server &&
            this.running.has(
              JSON.stringify([chatKey(action.chat), action.command.id]),
            )
          );
          return waiting
            ? {
              id: waiting.id,
              message: waiting.message,
              kind: waiting.kind,
              schema: waiting.schema,
            }
            : null;
        }
        if (!prompt || prompt.id !== action.promptId) {
          throw new Error("Approval expired or command mismatch");
        }
        const resolve = this.pending.get(prompt.id);
        if (!resolve) throw new Error("Approval expired");
        this.pending.delete(prompt.id);
        resolve({ action: "accept" });
        return;
      }
      case "save": {
        const p = action.profile;
        if (
          !p || typeof p.name !== "string" || !p.name.trim() ||
          !["http", "sse", "ws"].includes(p.transport)
        ) throw new Error("Invalid profile");
        const url = new URL(p.url);
        if (
          !(p.transport === "ws" ? ["ws:", "wss:"] : ["http:", "https:"])
            .includes(url.protocol) || url.username || url.password
        ) throw new Error("Invalid endpoint URL");
        const name = p.name.trim();
        const originalName = action.originalName ?? name;
        const original = this.state.profiles.find((profile) =>
          profile.name === originalName
        );
        if (action.originalName !== undefined && !original) {
          throw new Error("Profile no longer exists");
        }
        if (this.clients.has(originalName)) {
          throw new Error("Disconnect before editing profile");
        }
        if (
          name !== originalName &&
          this.state.profiles.some((profile) => profile.name === name)
        ) throw new Error("Profile name already exists");
        const changedServer = original &&
          (original.url !== p.url || original.transport !== p.transport);
        for (const key of Object.keys(this.state.rules)) {
          let parsed: [string, string];
          try {
            parsed = JSON.parse(key) as [string, string];
          } catch {
            delete this.state.rules[key];
            continue;
          }
          const [server, tool] = parsed;
          if (server !== originalName) continue;
          const rule = this.state.rules[key];
          if (changedServer || name !== originalName) {
            delete this.state.rules[key];
          }
          if (!changedServer && name !== originalName) {
            this.state.rules[ruleKey(name, tool)] = rule;
          }
        }
        this.state.profiles = original
          ? this.state.profiles.map((profile) =>
            profile.name === originalName
              ? { ...p, name, reconnect: original.reconnect ?? false }
              : profile
          )
          : [...this.state.profiles, { ...p, name, reconnect: false }];
        if (name !== originalName) delete this.state.connections[originalName];
        this.state.connections[name] = { status: "disconnected", tools: [] };
        await this.persist(this.state);
        return;
      }
      case "remove":
        await this.disconnect(action.name);
        this.state.profiles = this.state.profiles.filter((p) =>
          p.name !== action.name
        );
        delete this.state.connections[action.name];
        await this.persist(this.state);
        return;
      case "preset":
        if (!PRESETS.includes(action.preset)) throw new Error("Invalid preset");
        this.state.preset = action.preset;
        await this.persist(this.state);
        return;
      case "custom-prompt": {
        const text = action.text?.trim();
        if (text && text.length > 20000) {
          throw new Error("Custom instructions too long");
        }
        this.state.customPrompt = text || undefined;
        await this.persist(this.state);
        return;
      }
      case "execution-delay":
      case "response-delay": {
        const { min, max } = action;
        if (
          !Number.isSafeInteger(min) || !Number.isSafeInteger(max) ||
          min < 0 || max < min || max > MAX_PACING
        ) throw new Error("Invalid delay range");
        this.state.pacing[
          action.type === "execution-delay" ? "execution" : "response"
        ] = { min, max };
        await this.persist(this.state);
        return;
      }
      case "rule": {
        const tool = this.state.connections[action.server]?.tools.find((t) =>
          t.name === action.tool
        );
        if (
          !tool ||
          Object.values(action.rule).some((v) => typeof v !== "boolean")
        ) throw new Error("Invalid tool classification");
        this.state.rules[ruleKey(action.server, action.tool)] = {
          ...action.rule,
          fingerprint: fingerprint(tool),
        };
        await this.persist(this.state);
        return;
      }
      case "connect":
        return await this.connect(action.name);
      case "disconnect":
        return await this.disconnect(action.name);
      case "reply": {
        const resolve = this.pending.get(action.id);
        if (
          !resolve || !["accept", "decline", "cancel"].includes(action.action)
        ) throw new Error("Prompt expired or invalid response");
        if (action.action === "accept" && action.content) {
          const prompt = this.state.prompts.find((p) => p.id === action.id);
          if (
            prompt?.schema &&
            !new CfWorkerJsonSchemaValidator().getValidator(
                prompt.schema as Record<string, unknown>,
              )(action.content as Record<string, unknown>).valid
          ) throw new Error("Elicitation reply does not satisfy the requested schema");
        }
        resolve({ action: action.action, content: action.content });
        return;
      }
      case "invoke": {
        const command = decodeCommand(action.command);
        if (!command) throw new Error("Invalid MCP command");
        return await this.invoke(command, action.chat);
      }
      default:
        throw new Error("Unknown action");
    }
  }
  // Concurrent connect attempts share one in-flight promise; the client entry
  // is inserted before the transport connects, so a bare clients.has() check
  // would report success for an attempt that is about to fail.
  private async connect(name: string, retry = true) {
    const inFlight = this.connecting.get(name);
    if (inFlight) return await inFlight;
    const attempt = this.connectAttempt(name, retry);
    this.connecting.set(name, attempt);
    try {
      return await attempt;
    } finally {
      if (this.connecting.get(name) === attempt) this.connecting.delete(name);
    }
  }
  private async connectAttempt(name: string, retry: boolean) {
    const profile = this.state.profiles.find((p) => p.name === name);
    if (!profile) throw new Error("Unknown profile");
    if (this.clients.has(name)) return;
    const client = new Client({ name: "mcp-runner", version: "0.1.0" }, {
      capabilities: { elicitation: { form: {}, url: {} } },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    });
    this.clients.set(name, client);
    this.state.connections[name] = { status: "connecting", tools: [] };
    client.setRequestHandler(
      ElicitRequestSchema,
      async (request: ElicitRequest, extra: { signal: AbortSignal }) => {
        const params = request.params;
        const schema = prefillElicitationSchema(
          params.message,
          "requestedSchema" in params
            ? params.requestedSchema as Record<string, unknown>
            : undefined,
        );
        if (this.state.preset === "yolo" && schema && !("url" in params)) {
          const properties = (schema.properties ?? {}) as Record<
            string,
            Record<string, unknown>
          >;
          const content: Record<string, unknown> = {};
          for (const [key, field] of Object.entries(properties)) {
            if (field.const !== undefined) content[key] = field.const;
            else if (field.default !== undefined) content[key] = field.default;
            else if (
              Array.isArray(field.enum) && field.enum.length === 1
            ) content[key] = field.enum[0];
          }
          const validator = new CfWorkerJsonSchemaValidator().getValidator(
            schema,
          );
          if (validator(content).valid) {
            return {
              action: "accept" as const,
              content,
            };
          }
        }
        const { id, reply } = this.prompt({
          kind: "elicitation",
          server: name,
          message: `${name}: ${params.message}${
            "url" in params ? "\nRequested URL: " + params.url : ""
          }`,
          schema,
        });
        const cancel = () => this.pending.get(id)?.({ action: "cancel" });
        extra.signal.addEventListener("abort", cancel, { once: true });
        try {
          return await reply;
        } finally {
          extra.signal.removeEventListener("abort", cancel);
        }
      },
    );
    client.onclose = () => {
      if (this.clients.get(name) === client) {
        this.clients.delete(name);
        this.transports.delete(name);
        this.state.connections[name] = { status: "disconnected", tools: [] };
        this.cancelServerPrompts(name);
        this.scheduleReconnect(name);
      }
    };
    client.onerror = (error: Error) => {
      if (this.clients.get(name) === client) {
        if (/Maximum reconnection attempts/.test(String(error))) {
          // The SSE stream gave up; the client is a zombie. Tear it down and
          // let the delayed retry rebuild the session when the server returns.
          this.clients.delete(name);
          this.transports.delete(name);
          this.cancelServerPrompts(name);
          void client.close().catch(() => {});
          this.state.connections[name] = {
            status: "disconnected",
            tools: [],
            error: String(error),
          };
          this.scheduleReconnect(name);
          return;
        }
        const connection = this.state.connections[name];
        this.state.connections[name] = { ...connection, error: String(error) };
        if (
          error instanceof StreamableHTTPError &&
          (error as StreamableHTTPError).code === 404
        ) {
          this.state.connections[name].status = "error";
        }
      }
    };
    try {
      const url = new URL(profile.url);
      const transport = profile.transport === "http"
        ? new StreamableHTTPClientTransport(url)
        : profile.transport === "sse"
        ? new SSEClientTransport(url)
        : new WebSocketClientTransport(url);
      this.transports.set(name, transport);
      await client.connect(transport);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        if (++pages > 50) throw new Error("Tool list pagination exceeded 50 pages");
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools as Tool[]);
        cursor = page.nextCursor;
      } while (cursor);
      if (this.clients.get(name) !== client) {
        throw new Error("Connection closed during discovery");
      }
      this.state.connections[name] = { status: "connected", tools };
      profile.reconnect = true;
      await this.persist(this.state);
    } catch (error) {
      if (retry && this.expired(name, error)) {
        return await this.recover(name, client);
      }
      const current = this.clients.get(name) === client;
      if (current) {
        this.clients.delete(name);
        this.transports.delete(name);
      }
      await client.close().catch(() => {});
      if (current) {
        this.state.connections[name] = {
          status: "error",
          tools: [],
          error: String(error),
        };
      }
      throw error;
    }
  }
  private expired(name: string, error: unknown) {
    return this.transports.get(name) instanceof StreamableHTTPClientTransport &&
      error instanceof StreamableHTTPError &&
      (error as StreamableHTTPError).code === 404;
  }
  private async recover(name: string, stale: Client) {
    const pending = this.recovering.get(name);
    if (pending) return await pending;
    if (this.clients.get(name) !== stale) {
      if (this.state.connections[name]?.status === "connected") return;
      throw new Error("Disconnected during session recovery");
    }
    const operation = (async () => {
      this.state.connections[name] = { status: "connecting", tools: [] };
      stale.onclose = undefined;
      // Let outstanding POSTs settle before closing: aborting them would erase
      // whether they were rejected as expired or actually executed.
      await Promise.allSettled(this.calls.get(stale) ?? []);
      await stale.close().catch(() => {});
      if (this.clients.get(name) !== stale) {
        throw new Error("Disconnected during session recovery");
      }
      this.clients.delete(name);
      this.transports.delete(name);
      // Bypass the connecting map: the failing attempt this recovery belongs
      // to still occupies it, so connect() here would await itself forever.
      await this.connectAttempt(name, false);
    })();
    this.recovering.set(name, operation);
    try {
      await operation;
    } finally {
      if (this.recovering.get(name) === operation) this.recovering.delete(name);
    }
  }
  private async disconnect(name: string) {
    const timer = this.reconnectTimers.get(name);
    if (timer !== undefined) clearTimeout(timer);
    this.reconnectTimers.delete(name);
    const client = this.clients.get(name);
    this.clients.delete(name);
    const transport = this.transports.get(name);
    this.transports.delete(name);
    const profile = this.state.profiles.find((profile) =>
      profile.name === name
    );
    if (profile) profile.reconnect = false;
    this.cancelServerPrompts(name);
    let terminationError: unknown;
    try {
      if (transport instanceof StreamableHTTPClientTransport) {
        await transport.terminateSession();
      }
    } catch (error) {
      if (
        !(error instanceof StreamableHTTPError &&
          (error as StreamableHTTPError).code === 404)
      ) {
        terminationError = error;
      }
    } finally {
      if (client) await client.close().catch(() => {});
    }
    this.state.connections[name] = {
      status: "disconnected",
      tools: [],
      ...(terminationError ? { error: String(terminationError) } : {}),
    };
    await this.persist(this.state);
  }
  private async invoke(command: Command, chat?: string) {
    if (
      !command ||
      ["id", "server", "tool"].some((k) =>
        typeof command[k as keyof Command] !== "string" ||
        !command[k as keyof Command]
      ) || !command.arguments || typeof command.arguments !== "object" ||
      Array.isArray(command.arguments)
    ) throw new Error("Invalid MCP command");
    const key = JSON.stringify([chatKey(chat), command.id]);
    const signature = JSON.stringify(command);
    const prior = this.commands.get(key);
    if (prior && prior !== signature) {
      throw new Error("Command ID reused with different contents");
    }
    if (this.running.has(key)) return await this.running.get(key);
    if (Object.hasOwn(this.state.results, key) || this.completed.has(key)) {
      throw new Error("Command already completed; use a new ID");
    }
    this.commands.set(key, signature);
    const task = this.execute(command, chat);
    this.running.set(key, task);
    try {
      const result = await task;
      this.state.results[key] = result;
      this.pruneResults();
      // A failed persist must not overwrite the genuine result with an error.
      await this.persist(this.state).catch(() => {});
      return result;
    } catch (error) {
      this.state.results[key] = { error: String(error) };
      this.pruneResults();
      await this.persist(this.state).catch(() => {});
      throw error;
    } finally {
      this.running.delete(key);
      const otherRunning = [...this.running.keys()].some((other) => {
        const signature = this.commands.get(other);
        return signature &&
          (JSON.parse(signature) as Command).server === command.server;
      });
      this.commands.delete(key);
      if (!otherRunning) {
        for (
          const prompt of this.state.prompts.filter((prompt) =>
            prompt.kind === "elicitation" && prompt.server === command.server
          )
        ) this.pending.get(prompt.id)?.({ action: "cancel" });
      }
    }
  }
  private pruneResults() {
    const keys = Object.keys(this.state.results);
    for (const key of keys.slice(0, keys.length - RESULT_LIMIT)) {
      delete this.state.results[key];
      this.completed.add(key);
    }
    for (const key of this.completed) {
      if (this.completed.size <= RESULT_LIMIT * 10) break;
      this.completed.delete(key);
    }
  }
  private async execute(command: Command, chat?: string): Promise<unknown> {
    const recovery = this.recovering.get(command.server);
    if (recovery) await recovery;
    const client = this.clients.get(command.server);
    const tool = this.state.connections[command.server]?.tools.find((t) =>
      t.name === command.tool
    );
    if (
      !client || !tool ||
      this.state.connections[command.server].status !== "connected"
    ) throw new Error("Server disconnected or tool unavailable");
    const candidate = this.state.rules[ruleKey(command.server, command.tool)];
    const rule = candidate?.fingerprint === fingerprint(tool)
      ? candidate
      : undefined;
    const mandatory = !rule || rule.consequential;
    const ask = this.state.preset !== "yolo" &&
      this.state.preset !== "server-perms" &&
      (mandatory || this.state.preset === "ask" || !rule?.readOnly);
    if (ask) {
      const { reply } = this.prompt({
        kind: "execution",
        command,
        chat,
        message: `Execute ${command.server}/${command.tool} for ${
          chat ?? "sidebar"
        }?\n${JSON.stringify(command.arguments, null, 2)}\n${
          mandatory
            ? "Unclassified or consequential action: review effects before approving."
            : ""
        }`,
      });
      const response = await reply;
      if (response.action === "cancel") {
        throw new Error("Disconnected while awaiting approval");
      }
      if (response.action !== "accept") throw new Error("Execution declined");
    }
    if (this.clients.get(command.server) !== client) {
      throw new Error("Disconnected while awaiting approval");
    }
    const pacing = this.state.pacing.execution;
    if (pacing.max > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, pacing.min + Math.random() * (pacing.max - pacing.min))
      );
      if (this.clients.get(command.server) !== client) {
        throw new Error("Disconnected during execution delay");
      }
    }
    let result;
    const requestedTimeout = command.arguments.timeout_ms;
    // Only interpret timeout_ms when the server advertises it as an argument.
    // Leave time for the server's timeout response to reach the client.
    const properties = tool.inputSchema.properties;
    const timeout = properties && typeof properties === "object" &&
        Object.hasOwn(properties, "timeout_ms") &&
        typeof requestedTimeout === "number" &&
        Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0 &&
        requestedTimeout <= 2_147_473_647
      ? Math.max(60_000, requestedTimeout + 10_000)
      : undefined;
    const operation = client.callTool(
      {
        name: command.tool,
        arguments: command.arguments,
      },
      undefined,
      timeout === undefined ? undefined : { timeout },
    );
    const calls = this.calls.get(client) ?? new Set<Promise<unknown>>();
    this.calls.set(client, calls);
    calls.add(operation);
    try {
      result = await operation;
      if (this.clients.get(command.server) === client) {
        this.state.connections[command.server].status = "connected";
        delete this.state.connections[command.server].error;
      }
    } catch (error) {
      if (this.expired(command.server, error)) {
        // A lost session cannot establish whether the server executed the
        // command — restore the session for subsequent commands, never replay.
        try {
          await this.recover(command.server, client);
        } catch (recoveryError) {
          throw new Error(
            `${String(error)}; session restoration failed: ${
              String(recoveryError)
            }`,
          );
        }
        throw new Error(
          `${String(error)}; the session expired during the call, so its outcome is unknown. The session was restored — re-issue this command with a new ID.`,
        );
      }
      if (
        error instanceof McpError &&
        (error as McpError).code === ErrorCode.RequestTimeout
      ) {
        // A timeout cannot establish whether the server executed the command.
        // Restore the session for subsequent commands, never replay this one.
        try {
          await this.recover(command.server, client);
        } catch (recoveryError) {
          throw new Error(
            `${String(error)}; session restoration failed: ${
              String(recoveryError)
            }`,
          );
        }
      }
      throw error;
    } finally {
      calls.delete(operation);
      if (!calls.size) this.calls.delete(client);
    }
    if (
      chat && this.state.preset !== "yolo" &&
      this.state.preset !== "server-perms" && (!rule || rule.sensitive)
    ) {
      const { reply } = this.prompt({
        kind: "disclosure",
        command,
        chat,
        message: `Send this result to ${chat}?\n${
          JSON.stringify(result, null, 2)
        }\nReview for sensitive information.`,
      });
      const response = await reply;
      if (response.action !== "accept") {
        this.state.results[
          JSON.stringify(["private", chatKey(chat), command.id])
        ] = result;
        throw new Error(
          response.action === "cancel"
            ? "Server disconnected before disclosure; result retained in sidebar only"
            : "Result disclosure declined; result retained in sidebar only",
        );
      }
    }
    return result;
  }
}
