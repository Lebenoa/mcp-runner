import { browser } from 'wxt/browser';
import { SessionHost } from './host.ts';
import { originFor } from './contracts.ts';
import type { Action, Reply } from './contracts.ts';
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
    return restored.then(() => host.handle(message.action as Action)).then(value => ({ ok: true, value } satisfies Reply), error => ({ ok: false, error: String(error) } satisfies Reply));
  });
  return host;
}
