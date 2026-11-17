import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { salvarNoEnv } from './configLocal.ts';

describe('salvarNoEnv', () => {
  it('cria a partir do exemplo, troca linhas comentadas, preserva o resto e aspas quando precisa', async () => {
    const pasta = await mkdtemp(join(tmpdir(), 'env-'));
    await writeFile(join(pasta, '.env.example'), '# Banco\nDATABASE_URL=\n# PAINEL_OPERADOR=\nOUTRA=1\n');
    const arquivo = join(pasta, '.env');
    await salvarNoEnv({ DATABASE_URL: 'postgresql://u:p@h:5432/db', PAINEL_OPERADOR: 'Miguel Nahas', NOVA: 'x#y "z"' }, arquivo);
    const texto = await readFile(arquivo, 'utf8');
    expect(texto).toContain("# Banco\nDATABASE_URL=postgresql://u:p@h:5432/db\nPAINEL_OPERADOR='Miguel Nahas'\nOUTRA=1");
    expect(parse(texto)).toMatchObject({ DATABASE_URL: 'postgresql://u:p@h:5432/db', PAINEL_OPERADOR: 'Miguel Nahas', NOVA: 'x#y "z"', OUTRA: '1' });
    expect(process.env.PAINEL_OPERADOR).toBe('Miguel Nahas');
    await salvarNoEnv({ NOVA: null }, arquivo);
    expect(parse(await readFile(arquivo, 'utf8')).NOVA).toBeUndefined();
    await expect(salvarNoEnv({ X: 'a\nb' }, arquivo)).rejects.toThrow('quebra de linha');
    await expect(salvarNoEnv({ 'x y': 'a' }, arquivo)).rejects.toThrow('Chave inválida');
    delete process.env.PAINEL_OPERADOR; delete process.env.DATABASE_URL;
  });
});
