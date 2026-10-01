import { startChatEngine, type ChatDom, type Request } from './chat-engine.ts';

export type { Request };

const SEND_ARROW = 'div[role="button"].ds-button--circle.ds-button--primary';
const COMPOSER = 'textarea[placeholder="Message DeepSeek"]';

const deepSeekDom = (doc: Document, win: Window): ChatDom => {
  const sendArrow = () => [...doc.querySelectorAll<HTMLElement>(SEND_ARROW)].find(candidate => candidate.querySelector('svg path[d^="M8.3125 0.980206"]')) ?? null;
  const composer = () => doc.querySelector<HTMLElement>(COMPOSER);
  return {
    composer,
    composerValue: composerElement => (composerElement as HTMLTextAreaElement).value ?? '',
    setComposerValue: (composerElement, text) => {
      const textarea = doc.defaultView?.HTMLTextAreaElement;
      if (textarea && composerElement instanceof textarea) {
        Object.getOwnPropertyDescriptor(textarea.prototype, 'value')?.set?.call(composerElement, text);
      }
      composerElement.dispatchEvent(new (doc.defaultView?.Event || Event)('input', { bubbles: true }));
    },
    sendButton: () => sendArrow(),
    sendDisabled: button => button.classList.contains('ds-button--disabled'),
    isGenerating: () => Boolean(doc.querySelector('.ds-loading, [aria-label="Stop generating"], [aria-label="Stop response"], [aria-label="停止生成"], [data-testid="stop-button"]')),
    hasMessages: () => Boolean(doc.querySelector('.ds-message, .ds-assistant-message-main-content')),
    isExistingChatRoute: () => /\/chat\/s\//.test(win.location.pathname),
    isSubmitIntent: event => {
      const composerElement = composer();
      const arrow = sendArrow();
      if (!composerElement || !arrow) return false;
      const target = event.target as Node | null;
      const keyboard = event as KeyboardEvent;
      return event.type === 'click'
        ? !!target && arrow.contains(target)
        : target === composerElement && keyboard.key === 'Enter' && !keyboard.shiftKey && !keyboard.isComposing && !keyboard.ctrlKey && !keyboard.altKey && !keyboard.metaKey;
    },
    userBlocks: () => [...doc.querySelectorAll<HTMLElement>('.ds-message:not(:has(.ds-assistant-message-main-content))')]
      .flatMap(message => message.firstElementChild instanceof HTMLElement ? [message.firstElementChild] : []),
    messageOf: container => container.closest('.ds-assistant-message-main-content'),
    assistantBlocks: () => [...doc.querySelectorAll<HTMLElement>('.md-code-block pre')].map(pre => {
      const block = pre.closest<HTMLElement>('.md-code-block');
      const language = block?.querySelector('.md-code-block-banner span')?.textContent?.trim().toLowerCase() ?? '';
      return { container: block ?? pre, code: pre.textContent ?? '', language };
    }),
  };
};

export function startDeepSeekAdapter(request: Request, doc: Document = document, win: Window = window): () => void {
  return startChatEngine(request, doc, win, deepSeekDom(doc, win));
}
