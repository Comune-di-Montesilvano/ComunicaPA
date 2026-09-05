// Shim di compatibilita': i 1142 test esistenti usano l'API globale `jest`
// (jest.fn/mock/spyOn/clearAllMocks/useFakeTimers/Mock/Mocked...). Vitest
// espone la stessa API sotto `vi` - alias globale per zero riscrittura dei
// file .spec.ts esistenti durante la migrazione a Vitest.
import { vi } from 'vitest';

(globalThis as unknown as { jest: typeof vi }).jest = vi;
