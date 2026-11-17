import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarVendas, registrarCliques, type VendaNormalizada } from '../vendas/atribuicao.ts';
import { resultadosPeriodo } from './resultados.ts';

const venda = (o: Partial<VendaNormalizada>): VendaNormalizada => ({
  plataforma: 'shopee', pedidoId: 'P1', produtoId: '1', produtoNome: 'Organizador', valor: '30.00', comissao: '2.00',
  situacao: 'pendente', chaveRastreio: null, dataPedido: new Date('2026-11-10T15:00:00Z'), ...o,
});

describe.skipIf(!BANCO_HABILITADO)('resultados do período', () => {
  let sql: Sql;
  let cliente: Cliente;
  beforeAll(async () => {
    sql = await bancoLimpo();
    cliente = await buscarCliente(sql, 'c1');
    await importarVendas(sql, cliente, [
      venda({}),
      venda({ pedidoId: 'P2', situacao: 'validada', comissao: '5.00', dataPedido: new Date('2026-11-12T15:00:00Z') }),
      venda({ pedidoId: 'P2', produtoId: '2', produtoNome: 'Cesto', situacao: 'validada', comissao: '1.00', dataPedido: new Date('2026-11-12T15:00:00Z') }),
      venda({ pedidoId: 'P3', situacao: 'cancelada', comissao: '4.00', dataPedido: new Date('2026-11-12T16:00:00Z') }),
      // 01:30 UTC do dia 13 ainda é dia 12 em São Paulo
      venda({ pedidoId: 'P4', plataforma: 'amazon', produtoId: 'B01', comissao: '3.00', dataPedido: new Date('2026-11-13T01:30:00Z') }),
      venda({ pedidoId: 'P9', comissao: '9.00', dataPedido: new Date('2026-10-01T15:00:00Z') }),
    ]);
    await registrarCliques(sql, cliente, [
      { plataforma: 'shopee', chaveRastreio: 'sem-sub-id', dia: '2026-11-10', cliques: 7 },
      { plataforma: 'amazon', chaveRastreio: 'loja-20', dia: '2026-11-12', cliques: 3 },
    ]);
  });
  afterAll(async () => { await sql?.end(); });

  it('totais separados, dias completos, produtos e recentes', async () => {
    const r = await resultadosPeriodo(sql, cliente, '2026-11-10', '2026-11-12');
    expect(r.totais).toEqual({
      comissaoPendente: '5.00', comissaoValidada: '6.00', comissaoCancelada: '4.00',
      pedidos: 3, pedidosCancelados: 1, cliques: 10, vendido: '120.00', naoAtribuidas: 4,
    });
    expect(r.dias).toEqual([
      { dia: '2026-11-10', pendente: '2.00', validada: '0.00', pedidos: 1, cliques: 7 },
      { dia: '2026-11-11', pendente: '0.00', validada: '0.00', pedidos: 0, cliques: 0 },
      { dia: '2026-11-12', pendente: '3.00', validada: '6.00', pedidos: 2, cliques: 3 },
    ]);
    expect(r.produtos.map((p) => [p.produtoId, p.pedidos, p.comissao])).toEqual([['1', 2, '7.00'], ['B01', 1, '3.00'], ['2', 1, '1.00']]);
    expect(r.recentes[0]).toMatchObject({ pedidoId: 'P4', data: '2026-11-12T22:30', situacao: 'pendente', atribuida: false });
    expect(r.recentes).toHaveLength(5);
    expect(r.atualizado.vendas).not.toBeNull();
  });

  it('filtra por plataforma (vendas e cliques)', async () => {
    const r = await resultadosPeriodo(sql, cliente, '2026-11-10', '2026-11-12', 'amazon');
    expect(r.totais).toMatchObject({ comissaoPendente: '3.00', comissaoValidada: '0.00', pedidos: 1, cliques: 3 });
  });

  it('recusa período inválido', async () => {
    await expect(resultadosPeriodo(sql, cliente, '2026-11-12', '2026-11-10')).rejects.toThrow('depois');
    await expect(resultadosPeriodo(sql, cliente, '12/11/2026', '2026-11-10')).rejects.toThrow('AAAA-MM-DD');
  });
});
