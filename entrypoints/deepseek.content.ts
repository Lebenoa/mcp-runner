import { defineContentScript } from '#imports';
import { request } from '../src/bridge.ts';
import { startDeepSeekAdapter } from '../src/deepseek.ts';
import cardStyles from '../src/block-card.css?inline';
export default defineContentScript({
  matches: ['https://chat.deepseek.com/*'], registration:'runtime',
  main() {
    const style=document.createElement('style');
    style.textContent=cardStyles;
    if (document.head) document.head.append(style);
    startDeepSeekAdapter(request);
  },
});
