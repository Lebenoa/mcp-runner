export type Preset = 'auto-safe' | 'ask' | 'server-perms' | 'yolo';
export interface Profile { name: string; url: string; transport: 'http' | 'sse' | 'ws'; reconnect?: boolean }
export interface Tool { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }
export interface Rule { fingerprint: string; readOnly: boolean; consequential: boolean; sensitive: boolean }
export interface Command { id: string; server: string; tool: string; arguments: Record<string, unknown> }
export interface Prompt { id: string; kind: 'execution' | 'disclosure' | 'elicitation'; message: string; schema?: Record<string, unknown>; command?: Command; chat?: string; server?: string }
export interface Snapshot { profiles: Profile[]; preset: Preset; connections: Record<string, { status: string; tools: Tool[]; error?: string }>; rules: Record<string, Rule>; prompts: Prompt[]; results: Record<string, unknown>; customPrompt?: string }
export type Action =
 | { type: 'snapshot' }
 | { type: 'server-status'; id: string; chat: string; action?: 'connect' | 'disconnect'; server?: string }
 | { type: 'save'; profile: Profile; originalName?: string }
 | { type: 'remove'; name: string }
 | { type: 'preset'; preset: Preset }
 | { type: 'custom-prompt'; text?: string }
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
