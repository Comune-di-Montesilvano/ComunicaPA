import 'reflect-metadata';
import { IsString, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { validateBody } from './validate-body.util.js';

class Inner {
  @IsString()
  name!: string;
}

class Outer {
  @IsString()
  title!: string;

  @ValidateNested()
  @Type(() => Inner)
  @IsOptional()
  inner?: Inner;
}

describe('validateBody', () => {
  it('restituisce issues con il path completo dei campi annidati', async () => {
    const { issues } = await validateBody(Outer, { title: 'x', inner: { name: 5 } });
    expect(issues).toEqual([{ field: 'inner.name', message: expect.stringContaining('name') }]);
  });

  it('segnala come issue i campi non dichiarati (forbidNonWhitelisted)', async () => {
    const { issues } = await validateBody(Outer, { title: 'x', inner: { name: 'a', foo: 1 } });
    expect(issues).toEqual([{ field: 'inner.foo', message: 'campo non ammesso' }]);
  });

  it('più vincoli violati sullo stesso campo → una sola issue', async () => {
    const { issues } = await validateBody(Outer, { title: 5 });
    expect(issues.map((i) => i.field)).toEqual(['title']);
  });

  it('body non oggetto → issue sul root', async () => {
    const { issues } = await validateBody(Outer, 'stringa');
    expect(issues).toEqual([{ field: '', message: 'body JSON oggetto obbligatorio' }]);
  });

  it('nessuna issue → value è un\'istanza della classe', async () => {
    const { value, issues } = await validateBody(Outer, { title: 'x' });
    expect(issues).toEqual([]);
    expect(value).toBeInstanceOf(Outer);
  });
});
