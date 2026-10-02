import { defineContentScript } from '#imports';
import { request } from '../src/bridge.ts';
import { startChatGPTAdapter } from '../src/chatgpt.ts';
import cardStyles from '../src/block-card.css?inline';
export default defineContentScript({
  matches: ['https://chatgpt.com/*'], registration:'runtime',
  main() {
    const style=document.createElement('style');
    style.textContent=cardStyles;
    if (document.head) document.head.append(style);
    startChatGPTAdapter(request);
  },
});
