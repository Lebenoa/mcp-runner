import { browser } from 'wxt/browser';
import { installHost } from '../src/runtime-host.ts';
import { CHAT_SITES, originFor, redact } from '../src/contracts.ts';
import type { Reply } from '../src/contracts.ts';
import { actionSchema } from '../src/validation.ts';
export default defineBackground(() => {
  let ready: Promise<void> | undefined;
  let creating = false;
  async function ensureHost() {
    if (import.meta.env.BROWSER === 'firefox') {
      ready ??= installHost().then(() => {}).catch(error => { ready = undefined; throw error; });
      await ready; return;
    }
    if (ready) {
      // While creation is in flight the document may not exist yet; resetting
      // ready here would race a duplicate createDocument, so wait it out.
      if (creating) return await ready;
      if (!(await browser.offscreen.hasDocument())) ready = undefined;
      if (ready) return await ready;
    }
    creating = true;
    ready = (async () => {
      const offscreen = browser.offscreen;
      if (!(await offscreen.hasDocument())) await offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Maintain MCP network sessions while the sidebar is closed' });
      // The document may exist before its module installs the message listener.
      for (let attempt = 0; attempt < 1200; attempt++) {
        try { const response = await browser.runtime.sendMessage({ target: 'host', action: { type:'snapshot' } }); if(response?.ok) return; } catch { /* startup race */ }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('MCP session host failed to start');
    })().finally(() => { creating = false; }).catch(error => { ready = undefined; throw error; });
    await ready;
  }
  let registering: Promise<void> | undefined;
  function registerChats() {
    registering ??= (async () => {
      for (const site of CHAT_SITES) {
        try {
          const granted = await browser.permissions.contains({ origins: [site.match] });
          const registered = await browser.scripting.getRegisteredContentScripts({ ids: [site.id] });
          if (granted && !registered.length) await browser.scripting.registerContentScripts([{ id: site.id, matches: [site.match], js: [site.script], runAt: 'document_idle' }]);
          if (!granted && registered.length) await browser.scripting.unregisterContentScripts({ ids: [site.id] });
        } catch (error) { console.error(`MCP content script registration failed for ${site.id}`, error); }
      }
    })().finally(() => { registering = undefined; });
    return registering;
  }
  browser.permissions.onAdded.addListener(() => { void registerChats(); });
  browser.permissions.onRemoved.addListener(() => { void registerChats(); });
  void registerChats();
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
      let page = false;
      try {
        const action = actionSchema.parse(message.action);
        const sidebar = sender.url === browser.runtime.getURL('sidepanel.html');
        page = !!sender.tab && !sidebar;
        if (page) {
          const currentTab = await browser.tabs.get(sender.tab!.id!);
          const url = new URL(currentTab.url ?? sender.url ?? '');
          if (!CHAT_SITES.some(site => site.origin === url.origin) || sender.frameId !== 0) throw new Error('Unauthorized page');
          if (action.type !== 'invoke' && action.type !== 'page-snapshot' && action.type !== 'server-status' && action.type !== 'approval-status' && action.type !== 'approve-command' && action.type !== 'reply-elicitation') throw new Error('Page cannot manage extension');
          if ((action.type === 'invoke' || action.type === 'server-status' || action.type === 'approval-status' || action.type === 'approve-command' || action.type === 'reply-elicitation') && action.chat !== url.href) throw new Error('Command chat does not match sender');
        } else if (!sidebar) throw new Error('Unauthorized extension page');
        await ensureHost();
        return await browser.runtime.sendMessage({ target:'host', action }) as Reply;
      } catch(error) {
        const text = String(error);
        return { ok:false, error: page ? redact(text) : text };
      }
    })();
  });
  void ensureHost().catch(error => console.error('MCP startup reconnect failed', error));
});
