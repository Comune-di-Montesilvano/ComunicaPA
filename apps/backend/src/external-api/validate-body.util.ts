import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import type { ValidationIssue } from './external-api.error.js';

/**
 * Validazione manuale (non la ValidationPipe globale): la pipe appiattisce gli
 * errori annidati in stringhe senza path affidabile, qui serve `field` completo
 * (`recipient.address.zip`) nel contratto `details[]`. I controller v2 che la
 * usano dichiarano `@Body() body: Record<string, unknown>` — metatype Object,
 * che la ValidationPipe globale salta per costruzione.
 */
export async function validateBody<T extends object>(
  cls: new () => T,
  body: unknown,
): Promise<{ value: T; issues: ValidationIssue[] }> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { value: new cls(), issues: [{ field: '', message: 'body JSON oggetto obbligatorio' }] };
  }
  const value = plainToInstance(cls, body);
  const errors = await validate(value, { whitelist: true, forbidNonWhitelisted: true });
  return { value, issues: flatten(errors, '') };
}

/** Una issue per campo (messaggi uniti con "; "): più vincoli violati sullo stesso campo non duplicano `field`. */
function flatten(errors: ValidationError[], parent: string): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const e of errors) {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const messages = Object.entries(e.constraints ?? {}).map(([key, message]) => (key === 'whitelistValidation' ? 'campo non ammesso' : message));
    if (messages.length) out.push({ field, message: messages.join('; ') });
    if (e.children?.length) out.push(...flatten(e.children, field));
  }
  return out;
}
