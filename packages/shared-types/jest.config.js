module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Nessun tsconfig.json bare in questo package (solo tsconfig.cjs.json/
  // esm.json) — ts-jest compila con i default hard-coded quando non trova
  // un tsconfig nominato così. TS 6.0 ha cambiato il default di "types" da
  // "tutto node_modules/@types" a [] — va richiamato esplicitamente,
  // altrimenti describe/it/expect (@types/jest, mai importati qui) non
  // risolvono più.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { types: ['jest', 'node'] } }],
  },
};
