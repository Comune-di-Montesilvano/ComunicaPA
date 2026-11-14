import { defineConfig } from 'vitest/config';

// Test della logica pura in src/ (journey, timeline SEND, guida): niente DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
});
