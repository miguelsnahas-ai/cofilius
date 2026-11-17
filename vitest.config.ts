import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**'],
    // Os testes com banco recriam o schema; um arquivo de cada vez evita que um apague o banco do outro.
    fileParallelism: false,
  },
});
