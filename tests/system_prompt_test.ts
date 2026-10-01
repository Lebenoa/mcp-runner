import { SessionHost } from '../src/host.ts';
import { createSystemPrompt } from '../src/system-prompt.ts';
function assert(condition: unknown, message: string): asserts condition { if(!condition) throw new Error(message); }
Deno.test('custom instructions replace defaults and clear back', async () => {
  const host = new SessionHost(async()=>{});
  await host.handle({type:'custom-prompt',text:'  Only use read-only tools. Ask before anything else.  '});
  assert(host.state.customPrompt === 'Only use read-only tools. Ask before anything else.','custom prompt not trimmed and stored');
  const prompt = createSystemPrompt(host.state);
  assert(prompt.startsWith('Only use read-only tools.'),'custom instructions not used');
  assert(prompt.includes('No tools are currently available'),'tool section missing from custom prompt');
  assert(!prompt.includes('MCP Runner tool-use instructions'),'default instructions leaked into custom prompt');
  await host.handle({type:'custom-prompt',text:'   '});
  assert(host.state.customPrompt === undefined,'blank custom prompt did not clear');
  assert(createSystemPrompt(host.state).startsWith('MCP Runner tool-use instructions'),'default not restored after clear');
});
Deno.test('custom prompt persists through persist/restore and rejects oversized text', async () => {
  let saved: { customPrompt?: string } | undefined;
  const host = new SessionHost(async state => { saved = { customPrompt: state.customPrompt }; });
  await host.handle({type:'custom-prompt',text:'Be terse.'});
  assert(saved?.customPrompt === 'Be terse.','custom prompt not persisted');
  let rejected = false;
  try { await host.handle({type:'custom-prompt',text:'x'.repeat(20001)}); } catch { rejected = true; }
  assert(rejected && host.state.customPrompt === 'Be terse.','oversized prompt accepted or existing prompt clobbered');
  const restored = new SessionHost(async()=>{});
  await restored.restore({ profiles: [], rules: {}, results: {}, preset: 'ask', customPrompt: saved?.customPrompt });
  assert(restored.state.customPrompt === 'Be terse.','custom prompt lost on restore');
  assert(createSystemPrompt(restored.state).startsWith('Be terse.'),'restored prompt not used');
});
