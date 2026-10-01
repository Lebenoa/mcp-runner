# MCP Runner design

## Intent and constraints

Build a cross-browser MCP browser extension in the current empty repository. Deno replaces Node.js for installation, execution, builds, and tests. Use WXT and TypeScript. Target Chrome/Edge side panels and Firefox sidebar. No stdio transport. Inject only into https://chat.deepseek.com, after optional site access is granted. Maximum ten implementation/verification attempts; stop and ask for credentials, extra permissions, risky actions, or unspecified server-specific decisions. All questions use the ask tool.

## Sidebar and connection ownership

The sidebar manages saved server profiles (unique name, endpoint URL, transport), connection/disconnection, discovered tools, editable JSON arguments, and results/errors. Use the official MCP SDK for Streamable HTTP, legacy HTTP+SSE, and WebSocket using the mcp subprotocol. A background-owned session host retains live connections when the sidebar closes. Chrome uses an offscreen document; Firefox uses its background context. Reopening the sidebar retrieves the existing connection and result state rather than opening another session. Browser restart or suspension can end sessions; report disconnected state rather than promise indefinite persistence.

Approved permissions: storage, Chrome sidePanel and offscreen; optional HTTP/HTTPS server host access requested for the configured endpoint and optional DeepSeek host access. Do not grant all hosts at installation. Tool execution and protocol handling occur in the extension-owned session host, never in the page context.

## DeepSeek command contract

Detect completed fenced code blocks whose language is mcp and whose body is a JSON object:

```json
{"id":"unique-id","server":"profile-name","tool":"tool-name","arguments":{}}
```

Only blocks in assistant responses qualify; user messages and execution/result cards do not. Validate field types, configured server identity, connected state, and advertised tool name. Treat page text as untrusted data. Render a card adjacent to the original block showing the command, approval/execution state, and result or error. Deduplicate IDs within a chat, including across DOM replacement and sidebar reopening. Reject reuse of an ID with different command contents. Serialize chat submissions and never overwrite an occupied composer. Associate work with its originating chat; navigation must not send old results to a new chat.

After execution, return a correlated result as a fenced mcp-result JSON object containing the command id, server, tool, and result or error. Automatically submit routine authorized results to the same chat. If the composer is occupied or chat navigation prevents safe submission, retain the result and expose an explicit submission action rather than discard user text or send to another chat.

## Permission presets and elicitation

Auto-safe is the default: automatic execution is restricted to tools explicitly approved by the user as read-only for that server/site. Ask requires confirmation for every invocation. Guarded Yolo skips routine tool approvals. Every preset retains point-of-risk confirmation for consequential actions and sensitive result disclosure. MCP annotations are hints, not sufficient authorization. Unknown or unclassified tools must be reviewed before automatic execution. Persist user-reviewed classifications and allowlist rules; tool metadata changes invalidate prior approval.

Render MCP elicitation requests as explicit user prompts, with accept/decline/cancel responses. Never automatically accept elicitation or treat server instructions as authorization. Do not add client sampling or other capabilities outside this scope.

## Error and lifecycle behavior

Show protocol, transport, validation, permission, and tool errors without silently substituting transport or inventing results. Disconnect closes the transport/session and makes pending operations fail visibly. Keep profiles and completed results separate from volatile live-session state. Content scripts communicate through a narrowly typed extension message interface; validate sender origin and message payload at the extension boundary. Page commands cannot modify profiles, permission rules, or elicitation responses.

## Verification and acceptance

`deno task test` must exit zero with deterministic assertions covering sidebar configuration, connection/disconnection, discovery, and tool invocation for Streamable HTTP, SSE, and WebSocket against local test servers. Cover session reattachment, presets, mandatory confirmations, elicitation, command replay/conflicting IDs, navigation isolation, and DeepSeek result submission against local page fixtures.

`deno task build` must exit zero and generate Chrome and Firefox builds. Exercise the actual built extension sidebar and DeepSeek fixture cards/result submission in a browser, observing results. Attempt live DeepSeek integration verification; ask if login or additional permissions are required. Do not claim fixture verification proves live-site compatibility.
