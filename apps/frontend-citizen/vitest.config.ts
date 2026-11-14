import { defineConfig } from 'vitest/config';

// Test della logica pura in src/lib (formattazione, claims JWT, stati): niente DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
});
