import { browser } from 'wxt/browser';
import { installHost } from '../src/runtime-host.ts';
import { originFor } from '../src/contracts.ts';
import type { Reply, Snapshot } from '../src/contracts.ts';
import { actionSchema } from '../src/validation.ts';
import { createSystemPrompt } from '../src/system-prompt.ts';
export default defineBackground(() => {
  let ready: Promise<void> | undefined;
  async function ensureHost() {
    if (import.meta.env.BROWSER === 'firefox') {
      ready ??= installHost().then(() => {}).catch(error => { ready = undefined; throw error; });
      await ready; return;
    }
    if (ready && !(await browser.offscreen.hasDocument())) ready = undefined;
    if (ready) return await ready;
    ready = (async () => {
      const offscreen = browser.offscreen;
      if (!(await offscreen.hasDocument())) await offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Maintain MCP network sessions while the sidebar is closed' });
      // The document may exist before its module installs the message listener.
      for (let attempt = 0; attempt < 1200; attempt++) {
        try { const response = await browser.runtime.sendMessage({ target: 'host', action: { type:'snapshot' } }); if(response?.ok) return; } catch { /* startup race */ }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('MCP session host failed to start');
    })().catch(error => { ready = undefined; throw error; });
    await ready;
  }
  async function registerDeepSeek() {
    const granted = await browser.permissions.contains({ origins:['https://chat.deepseek.com/*'] });
    const registered = await browser.scripting.getRegisteredContentScripts({ ids:['deepseek'] });
    if (granted && !registered.length) await browser.scripting.registerContentScripts([{ id:'deepseek', matches:['https://chat.deepseek.com/*'], js:['content-scripts/deepseek.js'], runAt:'document_idle' }]);
    if (!granted && registered.length) await browser.scripting.unregisterContentScripts({ ids:['deepseek'] });
  }
  browser.permissions.onAdded.addListener(() => { void registerDeepSeek(); });
  browser.permissions.onRemoved.addListener(() => { void registerDeepSeek(); });
  void registerDeepSeek();
  if (import.meta.env.BROWSER === 'firefox') {
    browser.browserAction.onClicked.addListener(() => { void browser.sidebarAction.toggle(); });
    void ensureHost();
  } else { void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick:true }); }
  browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.target === 'endpoint-permission' && sender.id === browser.runtime.id && sender.url === browser.runtime.getURL('offscreen.html') && !sender.tab) {
      return browser.permissions.contains({ origins: message.origins });
    }
    if (message?.target === 'storage' && sender.id === browser.runtime.id && sender.url === browser.runtime.getURL('offscreen.html') && !sender.tab) {
      if ('value' in message) return browser.storage.local.set({state:message.value});
      return browser.storage.local.get('state').then(saved => saved.state);
    }
    if (message?.target !== 'router' || sender.id !== browser.runtime.id) return;
    return (async (): Promise<Reply> => {
      try {
        const action = actionSchema.parse(message.action);
        const sidebar = sender.url === browser.runtime.getURL('sidepanel.html');
        const page = !!sender.tab && !sidebar;
        if (page) {
          const currentTab = await browser.tabs.get(sender.tab!.id!);
          const url = new URL(currentTab.url ?? sender.url ?? '');
          if (url.origin !== 'https://chat.deepseek.com' || sender.frameId !== 0) throw new Error('Unauthorized page');
          if (!['invoke','snapshot','server-status','approval-status','approve-command','reply-elicitation'].includes(action.type)) throw new Error('Page cannot manage extension');
          if ((action.type === 'invoke' || action.type === 'server-status' || action.type === 'approval-status' || action.type === 'approve-command' || action.type === 'reply-elicitation') && action.chat !== url.href) throw new Error('Command chat does not match sender');
        } else if (!sidebar) throw new Error('Unauthorized extension page');
        if (action.type === 'connect') {
          const stored = await browser.storage.local.get('state');
          const profile = stored.state?.profiles?.find((p: {name:string}) => p.name === action.name);
          if (!profile) throw new Error('Unknown profile');
          if (!(await browser.permissions.contains({ origins:[originFor(profile.url)] }))) throw new Error('Grant endpoint permission from the sidebar');
        }
        await ensureHost();
        const reply = await browser.runtime.sendMessage({ target:'host', action }) as Reply;
        if (page && action.type === 'snapshot' && reply.ok) {
          const state = reply.value as Snapshot;
          reply.value = { systemPrompt: createSystemPrompt(state) };
        }
        return reply;
      } catch(error) { return { ok:false, error:String(error) }; }
    })();
  });
  void ensureHost().catch(error => console.error('MCP startup reconnect failed', error));
});
