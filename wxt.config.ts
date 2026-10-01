import { defineConfig } from 'wxt';
export default defineConfig({
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      const chatOrigins = ['https://chat.deepseek.com/*', 'https://chatgpt.com/*'];
      manifest.host_permissions = manifest.host_permissions?.filter(host => !chatOrigins.includes(host));
      if (manifest.manifest_version === 2) {
        manifest.optional_permissions = [...(manifest.optional_permissions ?? []), 'http://*/*', 'https://*/*'];
      }
    },
  },
  manifest: ({ browser }) => ({
    name: 'MCP Runner', description: 'MCP tools in your sidebar and supported AI chats',
    permissions: ['storage', 'scripting', ...(browser === 'firefox' ? [] : ['sidePanel', 'offscreen'])],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    ...(browser === 'firefox' ? { browser_action: { default_title: 'MCP Runner' } } : { action: { default_title: 'MCP Runner' } }),
  }),
});
