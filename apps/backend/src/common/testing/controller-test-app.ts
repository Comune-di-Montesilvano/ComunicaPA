import 'reflect-metadata';
import { INestApplication, ValidationPipe, type Provider, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';

// Helper solo per i test: app Nest minimale con UN controller, service
// mockati e ValidationPipe identica a main.ts. Niente guard (l'autorizzazione
// e' coperta da auth/route-security.inventory.spec.ts): un middleware imposta
// req.user come farebbe JwtAuthGuard.
export const TEST_OPERATOR = { username: 'operatore-test', role: 'user', type: 'operator' } as const;

export async function createControllerApp(
  controller: Type<unknown>,
  providers: Provider[],
  user: Record<string, unknown> = TEST_OPERATOR,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [controller], providers }).compile();
  const app = moduleRef.createNestApplication();
  app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = user;
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  return app;
}
