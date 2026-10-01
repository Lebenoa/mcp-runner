import { browser } from 'wxt/browser';
import type { Action, Reply, Snapshot } from './contracts';

export async function request(action: Action): Promise<unknown> {
  const reply = await browser.runtime.sendMessage({ target: 'router', action }) as Reply;
  if (!reply?.ok) throw new Error(reply?.error || 'The extension host rejected the request.');
  return reply.value;
}

export async function snapshot(): Promise<Snapshot> {
  return await request({ type: 'snapshot' }) as Snapshot;
}
