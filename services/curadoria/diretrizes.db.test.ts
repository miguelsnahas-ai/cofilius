import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { aprovarDiretriz, descartarDiretriz, diretrizesVigentes, listarDiretrizes, proporDiretriz } from './diretrizes.ts';

describe.skipIf(!BANCO_HABILITADO)('diretrizes de nicho', () => {
  let sql: Sql;
  let cliente: Cliente;
  beforeAll(async () => { sql = await bancoLimpo(); cliente = await buscarCliente(sql, 'c1'); });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate diretrizes_nicho`; });

  it('proposta não vale até ser aprovada; aprovar substitui a anterior', async () => {
    const v1 = await proporDiretriz(sql, cliente, 'casa', 'Priorizar utilidades de cozinha até R$ 60.', 'operador');
    expect(v1).toMatchObject({ versao: 1, situacao: 'proposta' });
    expect(await diretrizesVigentes(sql, cliente)).toEqual({});
    await aprovarDiretriz(sql, cliente, v1.id);
    const v2 = await proporDiretriz(sql, cliente, 'Casa', 'Evitar eletrônico sem frete grátis.', 'analista');
    expect(v2.versao).toBe(2);
    expect((await diretrizesVigentes(sql, cliente)).casa!.versao).toBe(1);
    await aprovarDiretriz(sql, cliente, v2.id);
    const vig = await diretrizesVigentes(sql, cliente);
    expect(vig.casa).toMatchObject({ versao: 2, propostaPor: 'analista' });
    expect((await listarDiretrizes(sql, cliente, 'casa')).map((d) => [d.versao, d.situacao])).toEqual([[2, 'aprovada'], [1, 'substituida']]);
  });

  it('recusa nicho fora do cadastro, texto vazio e aprovar o que não é proposta', async () => {
    await expect(proporDiretriz(sql, cliente, 'pets', 'x', 'operador')).rejects.toThrow('não está no cadastro');
    await expect(proporDiretriz(sql, cliente, 'casa', '  ', 'operador')).rejects.toThrow('vazia');
    const d = await proporDiretriz(sql, cliente, 'beleza', 'Só marcas conhecidas.', 'operador');
    await descartarDiretriz(sql, cliente, d.id);
    await expect(aprovarDiretriz(sql, cliente, d.id)).rejects.toThrow('descartada');
  });
});
