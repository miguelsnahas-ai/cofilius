import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { importarVendas, type VendaNormalizada } from './atribuicao.ts';
import { avisosCancelamento, canceladosDePedidosAnteriores, marcarAvisosVistos } from './avisos.ts';
import { prepararFechamento } from '../relatorios/fechamentoAfiliada.ts';

const venda = (o: Partial<VendaNormalizada>): VendaNormalizada => ({
  plataforma: 'shopee', pedidoId: 'P1', produtoId: '555', produtoNome: 'Organizador', valor: '30.00', comissao: '2.50',
  situacao: 'pendente', chaveRastreio: null, dataPedido: new Date('2026-11-04T15:00:00Z'), ...o,
});

describe.skipIf(!BANCO_HABILITADO)('avisos de cancelamento', () => {
  let sql: Sql;
  let cliente: Cliente;
  beforeAll(async () => { sql = await bancoLimpo(); cliente = await buscarCliente(sql, 'c1'); });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate vendas, eventos_vendas, links, ofertas, fechamentos cascade`; });

  it('venda conhecida que cai vira aviso com a comissão esperada e a postagem; venda que já chega cancelada não', async () => {
    const quando = new Date('2026-11-04T10:00:00Z');
    const o = await importarPlanilhaShopee(sql, cliente, 'link;titulo;preco\nhttps://shopee.com.br/P-i.9.555;Organizador de Gaveta;29,90', { quando });
    const l = await registrarLinkManual(sql, { cliente, ofertaId: o.ofertas[0]!.id, link: 'https://s.shopee.com.br/L555', quando });
    await importarVendas(sql, cliente, [venda({ chaveRastreio: l.chaveRastreio }), venda({ pedidoId: 'P2', situacao: 'validada', comissao: '4.00' })]);
    expect(await avisosCancelamento(sql, cliente)).toEqual([]);

    const r = await importarVendas(sql, cliente, [
      venda({ chaveRastreio: l.chaveRastreio, situacao: 'cancelada', comissao: '0.00' }),
      venda({ pedidoId: 'P2', situacao: 'validada', comissao: '4.00' }),
      venda({ pedidoId: 'P3', situacao: 'cancelada' }),
    ]);
    expect(r.canceladas).toBe(1);
    const avisos = await avisosCancelamento(sql, cliente);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ pedidoId: 'P1', de: 'pendente', comissao: '2.50', postagem: { titulo: 'Organizador de Gaveta' } });

    // Reimportar a mesma situação não repete o aviso.
    await importarVendas(sql, cliente, [venda({ chaveRastreio: l.chaveRastreio, situacao: 'cancelada', comissao: '0.00' })]);
    expect(await avisosCancelamento(sql, cliente)).toHaveLength(1);

    expect(await marcarAvisosVistos(sql, cliente)).toBe(1);
    expect(await avisosCancelamento(sql, cliente)).toEqual([]);
  });

  it('o fechamento conta o que caiu de semanas anteriores', async () => {
    await importarVendas(sql, cliente, [venda({ situacao: 'validada' })]);
    await importarVendas(sql, cliente, [venda({ situacao: 'cancelada' })]);
    await sql`update eventos_vendas set criado_em = '2026-11-11T15:00:00Z'`;
    expect(await canceladosDePedidosAnteriores(sql, cliente, '2026-11-09', '2026-11-15')).toEqual({ pedidos: 1, comissao: 2.5 });
    expect(await canceladosDePedidosAnteriores(sql, cliente, '2026-11-02', '2026-11-08')).toEqual({ pedidos: 0, comissao: 0 });
    const f = await prepararFechamento(sql, cliente, '2026-11-09', '2026-11-15');
    expect(f.texto).toContain('↩️ 1 pedido de semanas anteriores foi cancelado (R$ 2,50 saem do pendente)');
  });
});
