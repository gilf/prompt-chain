import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'PromptChain',
      fileName: (format) => format === 'es' ? 'prompt-chain.js' : `prompt-chain.${format}.cjs`
    }
  }
});
