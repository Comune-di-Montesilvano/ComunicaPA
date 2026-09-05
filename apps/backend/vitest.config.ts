import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Vitest sostituisce Jest/ts-jest per il backend ESM (Nest v12).
// swc gestisce decorator/metadata (esbuild di default non li supporta),
// stesso pattern documentato nei progetti e2e ufficiali NestJS+Vitest.
export default defineConfig({
  test: {
    globals: true,
    root: './src',
    include: ['**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['../vitest.setup.ts'],
    // Stesso vincolo gia' noto per jest (--maxWorkers=2, vedi CLAUDE.md):
    // troppi worker paralleli saturano CPU/RAM e gli hook
    // Test.createTestingModule vanno in timeout non per un bug reale ma
    // per starvation.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 2 } },
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      include: ['**/*.(t|j)s'],
      reportsDirectory: '../coverage',
    },
  },
  plugins: [
    tsconfigPaths(),
    swc.vite({
      module: { type: 'es6' },
      // Senza questo, Test.createTestingModule().compile() va in hang
      // silenzioso (timeout hook 10s, nessun errore leggibile) per
      // perdita dei design:paramtypes su cui si basa la DI di Nest.
      jsc: {
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
});
