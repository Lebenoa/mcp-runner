export type Preset = 'auto-safe' | 'ask' | 'server-perms' | 'yolo';
export interface Profile { name: string; url: string; transport: 'http' | 'sse' | 'ws'; reconnect?: boolean }
export interface Tool { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }
export interface Rule { fingerprint: string; readOnly: boolean; consequential: boolean; sensitive: boolean }
export interface Command { id: string; server: string; tool: string; arguments: Record<string, unknown> }
export interface Prompt { id: string; kind: 'execution' | 'disclosure' | 'elicitation'; message: string; schema?: Record<string, unknown>; command?: Command; chat?: string; server?: string }
export interface Snapshot { profiles: Profile[]; preset: Preset; connections: Record<string, { status: string; tools: Tool[]; error?: string }>; rules: Record<string, Rule>; prompts: Prompt[]; results: Record<string, unknown>; customPrompt?: string; pacing: { execution: { min: number; max: number }; response: { min: number; max: number } } }
export type Action =
 | { type: 'snapshot' }
 | { type: 'page-snapshot' }
 | { type: 'server-status'; id: string; chat: string; action?: 'connect' | 'disconnect'; server?: string }
 | { type: 'save'; profile: Profile; originalName?: string }
 | { type: 'remove'; name: string }
 | { type: 'preset'; preset: Preset }
 | { type: 'custom-prompt'; text?: string }
 | { type: 'execution-delay'; min: number; max: number }
 | { type: 'response-delay'; min: number; max: number }
 | { type: 'rule'; server: string; tool: string; rule: Omit<Rule, 'fingerprint'> }
 | { type: 'connect' | 'disconnect'; name: string }
 | { type: 'invoke'; command: Command; chat?: string }
 | { type: 'approval-status'; command: Command; chat: string }
 | { type: 'approve-command'; command: Command; chat: string; promptId: string }
 | { type: 'reply-elicitation'; command: Command; chat: string; promptId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
 | { type: 'reply'; id: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
export interface Reply { ok: boolean; value?: unknown; error?: string }
export function fingerprint(tool: Tool): string { return JSON.stringify(tool); }
export function ruleKey(server: string, tool: string): string { return JSON.stringify([server, tool]); }
export function originFor(url: string): string {
  const parsed = new URL(url);
  const protocol = parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol;
  return `${protocol}//${parsed.hostname}/*`;
}
export const CHAT_SITES = [
  { id: 'deepseek', origin: 'https://chat.deepseek.com', match: 'https://chat.deepseek.com/*', script: 'content-scripts/deepseek.js' },
  { id: 'chatgpt', origin: 'https://chatgpt.com', match: 'https://chatgpt.com/*', script: 'content-scripts/chatgpt.js' },
] as const;
/** Command/chat identity strips query and hash so replaying an id under a
 * different URL suffix still counts as the same conversation. */
export function chatKey(chat?: string): string {
  if (!chat) return 'sidebar';
  try { const parsed = new URL(chat); return `${parsed.origin}${parsed.pathname}`; } catch { return chat; }
}
/** Decode an untrusted command object: only id/server/tool/arguments survive,
 * and every field must be a non-empty string (arguments a plain object). */
export function decodeCommand(value: unknown): Command | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  if (!('id' in value) || !('server' in value) || !('tool' in value) || !('arguments' in value)) return null;
  const { id, server, tool, arguments: args } = value;
  if (typeof id !== 'string' || !id.trim() || typeof server !== 'string' || !server.trim() ||
      typeof tool !== 'string' || !tool.trim() || !args || Array.isArray(args) || typeof args !== 'object') return null;
  return { id, server, tool, arguments: args as Record<string, unknown> };
}
/** Strip endpoint URLs and tokens from error text bound for untrusted surfaces. */
export function redact(text: string): string {
  return text
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[endpoint]')
    .replace(/(bearer\s+|token[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}
