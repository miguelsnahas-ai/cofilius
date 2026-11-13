import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente } from '../../db/clientes.ts';
import { atualizarCliente, criarCliente, definirAtivo, listarCadastro, normalizarWhatsapp, removerNicho, salvarNicho } from './cadastro.ts';

describe('normalizarWhatsapp', () => {
  it('aceita com ou sem DDI e formatação', () => {
    expect(normalizarWhatsapp('(11) 99999-8888')).toBe('5511999998888');
    expect(normalizarWhatsapp('+55 11 99999-8888')).toBe('5511999998888');
    expect(() => normalizarWhatsapp('123')).toThrow('inválido');
  });
});

describe.skipIf(!BANCO_HABILITADO)('cadastro de clientes', () => {
  let sql: Sql;
  beforeAll(async () => { sql = await bancoLimpo(); });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`delete from clientes where codigo <> 'c1'`; });

  it('cria, atualiza, pausa e reativa', async () => {
    const c = await criarCliente(sql, 'ana', { nome: 'Ana', whatsapp: '(21) 98888-7777', horarioEnvio: '09:30', limiteMensagensDia: 6 });
    expect(c).toMatchObject({ codigo: 'ana', whatsapp: '5521988887777', horarioEnvio: '09:30', limiteMensagensDia: 6, ativo: true, nichos: [] });
    await expect(criarCliente(sql, 'ana', { nome: 'Outra' })).rejects.toThrow('Já existe');
    await expect(criarCliente(sql, 'Ana Maria', { nome: 'x' })).rejects.toThrow('Código');
    expect(await atualizarCliente(sql, 'ana', { tomGrupo: 'Divertido', horarioEnvio: '20:00' })).toMatchObject({ tomGrupo: 'Divertido', horarioEnvio: '20:00' });
    await expect(atualizarCliente(sql, 'ana', { horarioEnvio: '25:00' })).rejects.toThrow('Horário');
    await definirAtivo(sql, 'ana', false);
    await expect(buscarCliente(sql, 'ana')).rejects.toThrow('inativo');
    expect((await listarCadastro(sql, false)).map((x) => x.codigo)).toEqual(['c1']);
    await definirAtivo(sql, 'ana', true);
    expect((await buscarCliente(sql, 'ana')).nome).toBe('Ana');
  });

  it('nichos: cria, substitui pelo mesmo nome e remove', async () => {
    await criarCliente(sql, 'bia', { nome: 'Bia' });
    await salvarNicho(sql, 'bia', { nome: 'Pets', palavrasChave: ['ração', 'arranhador', 'ração'] });
    const n = await salvarNicho(sql, 'bia', { nome: 'Pets', palavrasChave: ['coleira'] });
    expect(n).toEqual([{ slug: 'pets', nome: 'Pets', palavras_chave: ['coleira'] }]);
    await expect(salvarNicho(sql, 'bia', { nome: 'Casa', palavrasChave: [] })).rejects.toThrow('palavra-chave');
    expect(await removerNicho(sql, 'bia', 'pets')).toEqual([]);
    await expect(removerNicho(sql, 'bia', 'pets')).rejects.toThrow('não existe');
  });
});
