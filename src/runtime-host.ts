import { browser } from 'wxt/browser';
import { SessionHost } from './host.ts';
import { originFor } from './contracts.ts';
import type { Reply } from './contracts.ts';
import { actionSchema } from './validation.ts';
export async function installHost() {
  const offscreen = import.meta.env.BROWSER !== 'firefox';
  const host = new SessionHost(async state => {
    const saved = { profiles: state.profiles, preset: state.preset, rules: state.rules, results: state.results, customPrompt: state.customPrompt, pacing: state.pacing };
    if (offscreen) await browser.runtime.sendMessage({ target:'storage', value:saved });
    else await browser.storage.local.set({ state:saved });
  }, async profile => {
    const origins = [originFor(profile.url)];
    return offscreen
      ? await browser.runtime.sendMessage({ target: 'endpoint-permission', origins })
      : await browser.permissions.contains({ origins });
  });
  const stored = offscreen ? await browser.runtime.sendMessage({target:'storage'}) : (await browser.storage.local.get('state')).state;
  const restored = host.restore(stored);
  browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.target !== 'host' || sender.id !== browser.runtime.id || sender.tab) return;
    // Same validation the service-worker router applies: no blind casts.
    const parsed = actionSchema.safeParse(message.action);
    if (!parsed.success) return Promise.resolve({ ok: false, error: 'Invalid action' } satisfies Reply);
    return restored.then(() => host.handle(parsed.data)).then(value => ({ ok: true, value } satisfies Reply), error => ({ ok: false, error: String(error) } satisfies Reply));
  });
  return host;
}
