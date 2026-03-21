import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const configDir = path.dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = path.resolve(configDir, '..');
  const env = loadEnv(mode, workspaceRoot, '');
  const baseRpcUrl = env.BASE_RPC_URL_READ || env.BASE_RPC_URL || 'https://mainnet.base.org';
  const agentApiUrl = env.AGENT_API_URL || 'http://localhost:3001';

  return {
    envDir: workspaceRoot,
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: agentApiUrl,
          changeOrigin: true,
          rewrite: (requestPath) => requestPath.replace(/^\/api/, ''),
        },
      },
    },
    define: {
      __BASE_RPC_URL__: JSON.stringify(baseRpcUrl),
    },
  };
});
