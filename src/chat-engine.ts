import { createBlockCard } from './block-card.ts';
import { createPayloadSection } from './payload-view.ts';
import { createElicitationForm } from './elicitation-form.ts';
import { decodeCommand, type Action, type Command } from './contracts.ts';

export type Request = (action: Action) => Promise<unknown>;

/**
 * Provider-specific DOM plumbing for one chat site. The engine owns all
 * orchestration (scanning, invocation, correlation, submission); the adapter
 * only answers "what does this site's markup look like right now".
 */
export interface ChatDom {
  /** The message composer (textarea or contenteditable). */
  composer(): HTMLElement | null;
  /** Current text in the composer. */
  composerValue(composer: HTMLElement): string;
  /** Replace the composer text and fire whatever input event the site expects. */
  setComposerValue(composer: HTMLElement, text: string): void;
  /** The send control (may be disabled while the composer is empty). */
  sendButton(): HTMLElement | null;
  sendDisabled(button: HTMLElement): boolean;
  /** True while the assistant is streaming a response. */
  isGenerating(): boolean;
  /** True once the conversation has any message (new-chat detection). */
  hasMessages(): boolean;
  /** True on routes that open an existing conversation. */
  isExistingChatRoute(): boolean;
  /** Does this event attempt to submit the composer? */
  isSubmitIntent(event: Event): boolean;
  /** User-message elements whose text should be scanned for display cards. */
  userBlocks(): HTMLElement[];
  /** The assistant message element containing this code block; results batch per message. */
  messageOf(container: HTMLElement): Element | null;
  /** Assistant code blocks: card is inserted after `container`, `code` is its text. */
  assistantBlocks(): { container: HTMLElement; code: string; language: string }[];
}

type Pending = { chat: string; command: Command; card: HTMLElement; statusQuery?: boolean };

const flatten = (value: string): string => value.replace(/\s+/g, ' ').trim();
const FENCE = /```(mcp-status-result|mcp-status|mcp-result|mcp)\s*\n([\s\S]*?)\n```/g;
// Markdown-rendering chat sites (chatgpt.com) consume the fences of submitted
// user messages: the DOM text becomes "<language>\n<single-line JSON>".
// These user-block cards are display-only, so accepting the rendered form is
// safe; anything that does not match this strict shape stays verbatim.
const RENDERED = /(?:^|\n)(mcp-status-result|mcp-result|mcp-status|mcp)[ \t]*\n(\{[^\n]*\}|\[[^\n]*\])(?=\n|$)/g;
// Marks payloads produced by our own catch handlers so a legitimate tool
// result that happens to contain an `error` key is not mistaken for a failure.
const FAILURE = Symbol('mcp-runner-failure');
const failure = (message: string) => {
  const payload: { error: string } & { [FAILURE]?: boolean } = { error: message };
  payload[FAILURE] = true;
  return payload;
};
const isFailure = (payload: unknown): payload is { error: string } =>
  typeof payload === 'object' && payload !== null && (payload as { [FAILURE]?: boolean })[FAILURE] === true;

export function startChatEngine(request: Request, doc: Document, win: Window, dom: ChatDom): () => void {
  const seen = new Map<string, string>();
  const shared = new Set<string>();
  const resultObservers = new Set<MutationObserver>();
  const approvalTimers = new Set<number>();
  let generation = 0;
  let stopped = false;
  let preparingPrompt = false;
  let replayingSubmission = false;
  let firstMessageSent = false;
  let promptRoute = win.location.href;
  const interceptFirstMessage = (event: Event) => {
    if (!event.isTrusted || replayingSubmission) return;
    const input = dom.composer();
    const arrow = dom.sendButton();
    if (!input || !arrow || !dom.isSubmitIntent(event)) return;
    if (promptRoute !== win.location.href) {
      promptRoute = win.location.href;
      firstMessageSent = false;
    }
    if (firstMessageSent || dom.isExistingChatRoute() || dom.hasMessages() || !flatten(dom.composerValue(input)) || dom.isGenerating() || dom.sendDisabled(arrow)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (preparingPrompt) return;
    preparingPrompt = true;
    const draft = dom.composerValue(input);
    const route = win.location.href;
    void request({ type: 'page-snapshot' }).then(value => {
      if (stopped || win.location.href !== route || !input.isConnected || flatten(dom.composerValue(input)) !== flatten(draft) || dom.hasMessages()) return;
      if (!value || typeof value !== 'object' || !('systemPrompt' in value) || typeof value.systemPrompt !== 'string') throw new Error('Tool instructions unavailable');
      dom.setComposerValue(input, `${value.systemPrompt}\n\nUser request:\n${draft}`);
      const button = dom.sendButton();
      if (!button) {
        // The site re-rendered mid-flight: restore the draft and fail loudly
        // instead of leaving the overwritten composer unsent.
        dom.setComposerValue(input, draft);
        throw new Error('Send button unavailable');
      }
      firstMessageSent = true;
      replayingSubmission = true;
      try { button.click(); } finally { replayingSubmission = false; }
    }).catch(() => {
      const notice = doc.createElement('p'); notice.setAttribute('role', 'alert');
      notice.textContent = 'MCP Runner could not load tool instructions. Your message was not sent; reconnect servers and try again.';
      input.insertAdjacentElement('beforebegin', notice);
    }).finally(() => { preparingPrompt = false; });
  };
  doc.addEventListener('click', interceptFirstMessage, true);
  doc.addEventListener('keydown', interceptFirstMessage, true);
  const cardStatus = (card: HTMLElement, status: string) => {
    const badge=card.querySelector('.mcp-card-status');
    if(badge) badge.textContent=status;
  };
  const cardFor = (code: HTMLElement, command: Command, key: string, statusQuery = false) => {
    const raw = statusQuery ? `\`\`\`mcp-status\n${JSON.stringify({ id: command.id, ...command.arguments })}\n\`\`\`` : `\`\`\`mcp\n${JSON.stringify(command,null,2)}\n\`\`\``;
    const card = createBlockCard(doc, command, 'Processing', { Arguments: statusQuery ? { id: command.id, ...command.arguments } : command.arguments }, raw);
    card.dataset.mcpRunnerId = key;
    code.insertAdjacentElement('afterend', card);
    code.hidden = true;
    return card;
  };
  const sendResult = async (records: Pending[], payloads: unknown[]) => {
    const record = records[0];
    records.forEach((entry, index) => {
      const payload = payloads[index];
      cardStatus(entry.card, isFailure(payload) ? 'Failed — result ready' : 'Result ready');
      entry.card.querySelector('.mcp-card-body')!.prepend(createPayloadSection(doc, 'Response', payload));
    });
    const messages = records.map((entry, index) => {
      const payload = payloads[index];
      const result = isFailure(payload) ? payload : { result: payload };
      return entry.statusQuery
        ? `\`\`\`mcp-status-result\n${JSON.stringify({ id: entry.command.id, ...result as object })}\n\`\`\``
        : `\`\`\`mcp-result\n${JSON.stringify({ id: entry.command.id, server: entry.command.server, tool: entry.command.tool, ...result as object })}\n\`\`\``;
    });
    let sent = false;
    let sending = false;
    // One random wait per batch, drawn from the sidebar-configured range.
    // Pacing failures fall back to submitting immediately.
    const wait = await request({ type: 'page-snapshot' }).then(value => {
      if (!value || typeof value !== 'object' || !('pacing' in value)) return 0;
      const response = (value as { pacing?: { response?: { min?: unknown; max?: unknown } } }).pacing?.response;
      if (!response || typeof response.min !== 'number' || typeof response.max !== 'number') return 0;
      const min = Math.max(0, response.min), max = Math.max(0, response.max);
      return max > 0 ? min + Math.random() * Math.max(0, max - min) : 0;
    }).catch(() => 0);
    const submit = () => {
      if (sent || sending || stopped || win.location.href !== record.chat) return;
      const input = dom.composer();
      // The send control may not exist until the composer has content
      // (verified on chatgpt.com), so insert the text first and let the
      // completion observer wait for the button instead of requiring it here.
      if (!input || flatten(dom.composerValue(input)) || dom.isGenerating()) {
        if (record.card.dataset.mcpPending !== 'true') record.card.dataset.mcpPending = 'true';
        return;
      }
      sending = true;
      win.setTimeout(() => {
        sending = false;
        if (sent || stopped || win.location.href !== record.chat) return;
        const currentInput = dom.composer();
        if (!currentInput || flatten(dom.composerValue(currentInput)) || dom.isGenerating()) {
          if (record.card.dataset.mcpPending !== 'true') record.card.dataset.mcpPending = 'true';
          return;
        }
        const text = messages.join('\n\n');
        dom.setComposerValue(currentInput, text);
        let observer: MutationObserver;
        const complete = () => {
          // A composer the user has typed into is not terminal: keep watching
          // so the pending retry can re-submit once the composer clears.
          if (sent) { observer.disconnect(); resultObservers.delete(observer); return; }
          if (stopped || win.location.href !== record.chat || !record.card.isConnected) {
            observer.disconnect(); resultObservers.delete(observer); return;
          }
          const currentInput = dom.composer();
          if (!currentInput || flatten(dom.composerValue(currentInput)) !== flatten(text)) {
            if (record.card.dataset.mcpPending !== 'true') record.card.dataset.mcpPending = 'true';
            return;
          }
          const currentArrow = dom.sendButton();
          if (!currentArrow || dom.sendDisabled(currentArrow) || dom.isGenerating()) return;
          sent = true; currentArrow.click();
          records.forEach(entry => {
            entry.card.dataset.mcpPending = 'false';
            cardStatus(entry.card, 'Submitted');
            shared.add(JSON.stringify([entry.chat, entry.command.id, entry.command.server, entry.command.tool]));
          });
          button.remove();
          observer.disconnect(); resultObservers.delete(observer);
        };
        observer = new MutationObserver(complete);
        resultObservers.add(observer);
        observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        complete();
      }, wait);
    };
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = records.length > 1 ? 'Submit MCP result batch' : 'Submit MCP result';
    button.addEventListener('click', submit);
    record.card.querySelector('.mcp-card-body')!.append(button);
    const retryObserver = new MutationObserver(() => {
      if (!record.card.isConnected || stopped || win.location.href !== record.chat) {
        retryObserver.disconnect(); resultObservers.delete(retryObserver); return;
      }
      if (record.card.dataset.mcpPending === 'true') submit();
    });
    resultObservers.add(retryObserver);
    retryObserver.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    submit();
  };
  const scan = () => {
    if (stopped) return;
    const chat = win.location.href;
    if (promptRoute !== chat) { promptRoute = chat; firstMessageSent = false; }
    for(const original of dom.userBlocks()) {
      if(!original || original.classList.contains('mcp-card') || original.hidden) continue;
      const raw=original.textContent ?? '';
      let matches=[...raw.trim().matchAll(FENCE)].map(match=>({lang:match[1],body:match[2],raw:match[0]}));
      let consumed=raw.trim();
      if(matches.length){
        for(const match of matches)consumed=consumed.replace(match.raw,'');
      }else{
        const rendered=[...raw.matchAll(RENDERED)];
        if(rendered.length){
          matches=rendered.map(match=>({lang:match[1],body:match[2],raw:'```'+match[1]+'\n'+match[2]+'\n```'}));
          consumed=raw.replace(RENDERED,'');
        }
      }
      if (!matches.length || consumed.trim()) continue;
      for (const match of matches) {
      try {
        const value:unknown=JSON.parse(match.body);
        if(!value || typeof value!=='object' || !('id' in value) || typeof value.id!=='string') continue;
        const statusQuery = match.lang.startsWith('mcp-status');
        if (!statusQuery && (!('server' in value) || !('tool' in value) || typeof value.server !== 'string' || typeof value.tool !== 'string')) continue;
        const metadata = { id: value.id, server: statusQuery ? 'MCP Runner' : 'server' in value && typeof value.server === 'string' ? value.server : '', tool: statusQuery ? 'Server status' : 'tool' in value && typeof value.tool === 'string' ? value.tool : '' };
        const response = match.lang.endsWith('-result');
        const sections = response ? { Result: 'result' in value ? value.result : value } : { Arguments: statusQuery ? value : 'arguments' in value ? value.arguments : {} };
        const card=createBlockCard(doc,metadata,response?'Result shared':'Display only',sections,match.raw);
        card.dataset.mcpUserBlock='true';original.insertAdjacentElement('afterend',card);original.hidden=true;
      } catch { /* Preserve malformed blocks verbatim. */ }
      }
    }
    if (dom.isGenerating()) return;
    const batches = new Map<Element, { records: Pending[]; operations: Promise<unknown>[] }>();
    for (const { container, code, language } of dom.assistantBlocks()) {
      if (language !== 'mcp' && language !== 'mcp-status') continue;
      const statusQuery = language === 'mcp-status';
      let command: Command | null = null;
      if (statusQuery) {
        try {
          const value: unknown = JSON.parse(code || '');
          if (value && typeof value === 'object' && !Array.isArray(value) && 'id' in value && typeof value.id === 'string' && value.id.trim() && Object.keys(value).every(key => ['id','action','server'].includes(key))) {
            const action = 'action' in value ? value.action : undefined;
            const server = 'server' in value ? value.server : undefined;
            if (action === undefined && server === undefined || (action === 'connect' || action === 'disconnect') && typeof server === 'string' && server.trim()) command = { id: value.id, server: 'MCP Runner', tool: 'Server status', arguments: action ? { action, server } : {} };
          }
        } catch { /* Preserve malformed status requests. */ }
      } else {
        try { command = decodeCommand(JSON.parse(code || '')); } catch { /* Preserve malformed blocks. */ }
      }
      if (!command) continue;
      const key = JSON.stringify([chat, command.id]);
      const signature = JSON.stringify(command);
      const sharedKey = JSON.stringify([chat, command.id, command.server, command.tool]);
      if (shared.has(sharedKey)) continue;
      const prior = seen.get(key);
      if (prior !== undefined) {
        if (prior !== signature && ![...doc.querySelectorAll<HTMLElement>('[data-mcp-conflict]')].some(card => card.dataset.mcpConflict === key)) {
          const conflict = doc.createElement('aside');
          conflict.dataset.mcpConflict = key;
          conflict.textContent = `Rejected conflicting reuse of MCP command id ${command.id}.`;
          container.insertAdjacentElement('afterend', conflict);
        }
        continue;
      }
      const messageElement = dom.messageOf(container);
      if (!messageElement) continue;
      seen.set(key, signature);
      if (seen.size > 500) seen.delete(seen.keys().next().value as string);
      const card = cardFor(container, command, key, statusQuery);
      const record: Pending = { chat, command, card, statusQuery };
      let batch = batches.get(messageElement);
      if (!batch) { batch = { records: [], operations: [] }; batches.set(messageElement, batch); }
      batch.records.push(record);
      if (statusQuery) {
        const action = command.arguments.action as 'connect' | 'disconnect' | undefined;
        const server = command.arguments.server as string | undefined;
        batch.operations.push(request({ type: 'server-status', id: command.id, chat, action, server }).catch(error => failure(String(error))));
        continue;
      }
      let finished = false;
      let checking = false;
      let approvalId: string | undefined;
      let controls: HTMLElement | undefined;
      const checkApproval = async () => {
        if (checking || finished || stopped || win.location.href !== chat || !card.isConnected) return;
        checking = true;
        try {
          let value: unknown;
          try {
            value = await request({ type: 'approval-status', command, chat });
          } catch {
            // The host restarted or the prompt expired; the card must not sit
            // on "Awaiting approval" forever.
            cardStatus(card, 'Approval expired — review sidebar');
            return;
          }
          if (finished || stopped || win.location.href !== chat) return;
          if (value && typeof value === 'object' && 'kind' in value && value.kind === 'elicitation' && 'id' in value && typeof value.id === 'string' && 'message' in value && typeof value.message === 'string') {
            if (approvalId === value.id) return;
            controls?.remove(); approvalId = value.id; controls = doc.createElement('section');
            const warning=doc.createElement('pre');warning.textContent=value.message;controls.append(warning);
            const schema='schema' in value && value.schema && typeof value.schema==='object' ? value.schema as Record<string,unknown> : undefined;
            const promptId=value.id;
            controls.append(createElicitationForm(doc,schema,async(action,content)=>{
              await request({type:'reply-elicitation',command,chat,promptId,action,content});
              controls?.remove();controls=undefined;approvalId=undefined;cardStatus(card,'Processing');
            }));
            card.querySelector('.mcp-card-body')!.append(controls);(card as HTMLDetailsElement).open=true;
            cardStatus(card,'Awaiting elicitation');return;
          }
          if (value && typeof value === 'object' && 'kind' in value && value.kind !== 'execution') {
            controls?.remove(); controls = undefined; approvalId = undefined;
            cardStatus(card, 'Awaiting disclosure — review sidebar'); return;
          }
          if (finished || stopped || win.location.href !== chat) return;
          if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !('message' in value) || typeof value.message !== 'string') {
            if (controls) { controls.remove(); controls = undefined; approvalId = undefined; cardStatus(card, 'Processing'); }
            return;
          }
          if (approvalId === value.id) return;
          controls?.remove(); approvalId = value.id;
          controls = doc.createElement('section');
          const warning = doc.createElement('pre'); warning.textContent = value.message;
          const approve = doc.createElement('button'); approve.type = 'button'; approve.textContent = 'Approve';
          const promptId = value.id;
          approve.addEventListener('click', event => {
            if (!event.isTrusted || stopped || finished || win.location.href !== chat) return;
            approve.disabled = true;
            void request({ type: 'approve-command', command, chat, promptId }).then(() => {
              controls?.remove(); controls = undefined; approvalId = undefined; cardStatus(card, 'Processing');
            }).catch(() => { approve.disabled = false; cardStatus(card, 'Approval expired — review sidebar'); });
          });
          controls.append(warning, approve); card.querySelector('.mcp-card-body')!.append(controls);
          cardStatus(card, 'Awaiting approval');
        } finally { checking = false; }
      };
      const approvalTimer = win.setInterval(() => { void checkApproval().catch(() => {}); }, 400);
      approvalTimers.add(approvalTimer);
      const clearApproval = () => { finished = true; win.clearInterval(approvalTimer); approvalTimers.delete(approvalTimer); controls?.remove(); };
      const operation = request({ type: 'invoke', command, chat }).catch(error => failure(String(error))).finally(clearApproval);
      batch.operations.push(operation);
    }
    for (const batch of batches.values()) {
      const ownGeneration = generation;
      void Promise.all(batch.operations).then(payloads => {
        if (stopped || ownGeneration !== generation || win.location.href !== chat) return;
        void sendResult(batch.records, payloads);
      });
    }
  };
  let scanTimer: number | undefined;
  const scheduleScan = (mutations: MutationRecord[]) => {
    if (mutations.every(mutation => {
      const element = mutation.target.nodeType === 1 ? mutation.target as Element : mutation.target.parentElement;
      return Boolean(element?.closest('.mcp-card'));
    })) return;
    if (scanTimer !== undefined) win.clearTimeout(scanTimer);
    scanTimer = win.setTimeout(() => { scanTimer = undefined; scan(); }, 800);
  };
  const observer = new MutationObserver(scheduleScan);
  observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  const onNavigation = () => {
    if (promptRoute !== win.location.href) { promptRoute = win.location.href; firstMessageSent = false; }
    generation++;
    if (scanTimer !== undefined) win.clearTimeout(scanTimer);
    for (const timer of approvalTimers) win.clearInterval(timer);
    approvalTimers.clear();
    for (const resultObserver of resultObservers) resultObserver.disconnect();
    resultObservers.clear();
    scan();
  };
  win.addEventListener('popstate', onNavigation);
  win.addEventListener('hashchange', onNavigation);
  scan();
  return () => {
    stopped = true;
    if (scanTimer !== undefined) win.clearTimeout(scanTimer);
    for (const timer of approvalTimers) win.clearInterval(timer);
    approvalTimers.clear();
    doc.removeEventListener('click', interceptFirstMessage, true);
    doc.removeEventListener('keydown', interceptFirstMessage, true);
    observer.disconnect();
    for (const resultObserver of resultObservers) resultObserver.disconnect();
    resultObservers.clear();
    win.removeEventListener('popstate', onNavigation);
    win.removeEventListener('hashchange', onNavigation);
  };
}
