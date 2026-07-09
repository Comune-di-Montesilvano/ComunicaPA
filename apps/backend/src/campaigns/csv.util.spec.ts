import { escapeCsvField } from './csv.util';

describe('escapeCsvField', () => {
  it('racchiude il valore tra virgolette ed esegue escaping delle virgolette interne', () => {
    expect(escapeCsvField('Mario "Rossi"')).toBe('"Mario ""Rossi"""');
  });

  it('antepone un apice ai valori che iniziano con = + - @ per prevenire formula injection', () => {
    expect(escapeCsvField('=SUM(A1:A2)')).toBe('"\'=SUM(A1:A2)"');
    expect(escapeCsvField('+1234')).toBe('"\'+1234"');
    expect(escapeCsvField('-1234')).toBe('"\'-1234"');
    expect(escapeCsvField('@cmd')).toBe('"\'@cmd"');
  });

  it('lascia invariati i valori normali', () => {
    expect(escapeCsvField('AAA1')).toBe('"AAA1"');
  });
});
