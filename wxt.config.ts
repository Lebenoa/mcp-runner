import { defineConfig } from 'wxt';
import { CHAT_SITES } from './src/contracts.ts';
export default defineConfig({
  // Extension pages cannot reuse module preloads across worlds (Chrome warns
  // and drops them), so the generated <link rel="modulepreload"> tags only
  // produce console noise.
  vite: () => ({ build: { modulePreload: false } }),
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      const chatMatches = CHAT_SITES.map(site => site.match);
      manifest.host_permissions = manifest.host_permissions?.filter(host => !chatMatches.includes(host));
      if (manifest.manifest_version === 2) {
        manifest.optional_permissions = [...(manifest.optional_permissions ?? []), 'http://*/*', 'https://*/*'];
      }
    },
  },
  manifest: ({ browser }) => ({
    name: 'MCP Runner', description: 'MCP tools in your sidebar and supported AI chats',
    permissions: ['storage', 'scripting', ...(browser === 'firefox' ? [] : ['sidePanel', 'offscreen'])],
    // Local servers are granted at install (required permissions never
    // prompt); match patterns ignore ports, so every local port is covered.
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    ...(browser === 'firefox' ? { browser_action: { default_title: 'MCP Runner' } } : { action: { default_title: 'MCP Runner' } }),
  }),
});
