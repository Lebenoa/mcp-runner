import { startChatEngine, type ChatDom, type Request } from './chat-engine.ts';

// chatgpt.com re-renders its composer and controls frequently; every selector
// has fallbacks and each may need updating when the site ships new markup.
const COMPOSER = '#prompt-textarea, textarea[data-testid="prompt-textarea"], textarea#prompt-textarea';
const SEND = 'button[data-testid="send-button"], button#composer-submit-button, button[aria-label="Send prompt"], button[aria-label*="Send"]';
const flattenEditor = (value: string): string => value.replace(/\s+/g, ' ').trim();

const chatGptDom = (doc: Document, win: Window): ChatDom => {
  const composer = () => doc.querySelector<HTMLElement>(COMPOSER);
  const sendButton = () => {
    const buttons = [...doc.querySelectorAll<HTMLElement>(SEND)];
    return buttons.find(button => button.offsetParent !== null) ?? buttons[0] ?? null;
  };
  return {
    composer,
    composerValue: composerElement => composerElement instanceof doc.defaultView!.HTMLTextAreaElement
      ? composerElement.value
      : (composerElement.textContent ?? ''),
    setComposerValue: (composerElement, text) => {
      const view = doc.defaultView;
      if (!view) return;
      if (composerElement instanceof view.HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value')?.set?.call(composerElement, text);
        composerElement.dispatchEvent(new view.Event('input', { bubbles: true }));
        return;
      }
      // ProseMirror contenteditable: replace the content through insertText so
      // the editor's input pipeline (and the send button state) updates. If
      // the command is unavailable or a no-op, fall back to raw replacement.
      composerElement.focus();
      const selection = view.getSelection();
      let inserted = false;
      if (selection && view.document.execCommand) {
        const range = view.document.createRange();
        range.selectNodeContents(composerElement);
        selection.removeAllRanges();
        selection.addRange(range);
        inserted = view.document.execCommand('insertText', false, text);
      }
      if (!inserted || flattenEditor(composerElement.textContent ?? '') !== flattenEditor(text)) {
        composerElement.textContent = text;
        composerElement.dispatchEvent(new view.Event('input', { bubbles: true }));
      }
    },
    sendButton,
    sendDisabled: button => button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true' || button.classList.contains('disabled'),
    isGenerating: () => Boolean(doc.querySelector('[data-testid="stop-button"], [aria-label="Stop streaming"], [aria-label="Stop generating"]')),
    hasMessages: () => Boolean(doc.querySelector('[data-message-author-role], [data-testid^="conversation-turn"]')),
    isExistingChatRoute: () => /^\/(c|g|gpts)\/[^/]/.test(win.location.pathname),
    isSubmitIntent: event => {
      const composerElement = composer();
      const button = sendButton();
      if (!composerElement || !button) return false;
      const target = event.target as Node | null;
      if (event.type === 'click') return !!target && button.contains(target);
      const keyboard = event as KeyboardEvent;
      const insideComposer = target === composerElement || (target instanceof Node && composerElement.contains(target));
      return insideComposer && keyboard.key === 'Enter' && !keyboard.shiftKey && !keyboard.isComposing && !keyboard.ctrlKey && !keyboard.altKey && !keyboard.metaKey;
    },
    userBlocks: () => [...doc.querySelectorAll<HTMLElement>('[data-message-author-role="user"]')],
    messageOf: container => container.closest('[data-message-author-role="assistant"]'),
    assistantBlocks: () => [...doc.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"] pre')].map(pre => {
      const code = pre.querySelector('code');
      const language = code?.className.match(/language-([\w-]+)/)?.[1]?.toLowerCase()
        ?? code?.getAttribute('data-language')?.toLowerCase()
        ?? '';
      return { container: pre, code: pre.textContent ?? '', language };
    }),
  };
};

export function startChatGPTAdapter(request: Request, doc: Document = document, win: Window = window): () => void {
  return startChatEngine(request, doc, win, chatGptDom(doc, win));
}
