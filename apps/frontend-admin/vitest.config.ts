import { defineConfig } from 'vitest/config';

// Test della logica pura in src/ (journey, timeline SEND, guida): niente DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      reportOnFailure: true,
      include: ['src/**/*.{ts,tsx}'],
      reportsDirectory: './coverage',
    },
  },
});
