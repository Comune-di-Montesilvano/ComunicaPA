import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // eslint-plugin-react-hooks v7 include di serie il ruleset React
      // Compiler nel preset 'recommended' — questo progetto non adotta React
      // Compiler. 'set-state-in-effect' vieta setState sincrono nel corpo di
      // un effect (spinge a derivare lo stato durante il render invece che
      // sincronizzarlo con un effect) — nei 4 casi reali in questo file
      // (gate OIDC su parametri URL non validi, selezione notifica da
      // querystring, fetch condizionale dei legal facts SEND, reset pagina
      // su cambio filtri) è il pattern idiomatico corretto per un
      // "synchronization effect" (dati esterni: URL/rete), non lo
      // stato-derivato-da-stato che la regola vuole prevenire. Disattivata
      // qui, non nel preset intero.
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
