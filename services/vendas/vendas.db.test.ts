import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { chaveShopee, importarVendas, registrarCliques, resumoPeriodo, type VendaNormalizada } from './atribuicao.ts';
import { lerPlanilhaVendas } from './planilhaVendas.ts';

const quando = new Date('2026-11-12T11:15:00Z');

describe('chaveShopee', () => {
  it('une os 5 sub_ids; vazio vira ""', () => {
    expect(chaveShopee(['c1', 'wa', '20261112', '22912345678', '0815'])).toBe('c1-wa-20261112-22912345678-0815');
    expect(chaveShopee(['c1', 'wa', null, undefined, ''])).toBe('c1-wa---');
    expect(chaveShopee([null, '', undefined])).toBeNull();
  });
});

describe('lerPlanilhaVendas', () => {
  it('lê o modelo', () => {
    const r = lerPlanilhaVendas(readFileSync(join(import.meta.dirname, '../../docs/modelos/vendas.csv'), 'utf8'));
    expect(r.erros).toEqual([]);
    expect(r.vendas.map((v) => [v.plataforma, v.situacao, v.chaveRastreio, v.comissao])).toEqual([
      ['shopee', 'pendente', 'c1-wa-20261112-22912345678-0815', '3.59'],
      ['mercado_livre', 'validada', 'wa-s46-casa', '14.50'],
      ['amazon', 'pendente', 'loja-20', '2.40'],
    ]);
    expect(r.vendas[0]!.dataPedido!.toISOString()).toBe('2026-11-12T13:30:00.000Z');
  });
  it('aponta linhas com erro', () => {
    const r = lerPlanilhaVendas('plataforma;pedido;produto;situacao\nsubmarino;1;2;pendente\nshopee;1;2;sumiu\nshopee;;2;pendente\nshopee;1;2;Concluída');
    expect(r.erros.map((e) => e.linha)).toEqual([2, 3, 4]);
    expect(r.vendas[0]!.situacao).toBe('validada');
  });
});

describe.skipIf(!BANCO_HABILITADO)('atribuição de vendas', () => {
  let sql: Sql;
  let cliente: Cliente;
  let chave: string;
  let linkShopee: string;

  beforeAll(async () => {
    sql = await bancoLimpo();
    cliente = await buscarCliente(sql, 'c1');
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => {
    await sql`truncate vendas, cliques, links, ofertas cascade`;
    const r = await importarPlanilhaShopee(sql, cliente, 'link;titulo;preco\nhttps://shopee.com.br/P-i.9.555;Organizador;29,90', { quando });
    const l = await registrarLinkManual(sql, { cliente, ofertaId: r.ofertas[0]!.id, link: 'https://s.shopee.com.br/L555', quando });
    chave = l.chaveRastreio;
    linkShopee = l.id;
    // links de Mercado Livre e Amazon (etiqueta por canal+nicho), criados direto no banco
    await sql`insert into links (cliente_id, plataforma, url_origem, url_afiliado, chave_rastreio, canal, nicho, produto_id, criado_em)
      values (${cliente.clienteId}, 'mercado_livre', 'https://produto.mercadolivre.com.br/MLB-1', 'https://mercadolivre.com/sec/a', 'wa-s46-casa', 'wa', 'casa', 'MLB1', '2026-11-12T10:00:00Z'),
             (${cliente.clienteId}, 'amazon', 'https://www.amazon.com.br/dp/B01', 'https://amzn.to/x', 'loja-20', 'wa', 'casa', 'B01', '2026-11-12T10:00:00Z')`;
  });

  const venda = (v: Partial<VendaNormalizada>): VendaNormalizada => ({
    plataforma: 'shopee', pedidoId: 'P1', produtoId: '555', situacao: 'pendente', valor: '29.90', comissao: '3.59',
    chaveRastreio: null, dataPedido: new Date('2026-11-12T13:00:00Z'), ...v,
  });

  it('Shopee: casa pela chave; produto diferente continua atribuído e marcado', async () => {
    const r = await importarVendas(sql, cliente, [
      venda({ pedidoId: 'P1', chaveRastreio: chave }),
      venda({ pedidoId: 'P2', produtoId: '999', chaveRastreio: chave }),
      venda({ pedidoId: 'P3', chaveRastreio: 'c1-wa-20261101-777-0900' }),
      venda({ pedidoId: 'P4', chaveRastreio: null }),
    ]);
    expect(r).toMatchObject({ total: 4, novas: 4, atribuidas: 2, naoAtribuidas: 2 });
    const linhas = await sql`select pedido_id, link_id, atribuida_por, produto_diferente from vendas order by pedido_id`;
    expect(linhas.map((l) => [l.pedido_id, l.link_id === linkShopee, l.atribuida_por, l.produto_diferente])).toEqual([
      ['P1', true, 'chave_rastreio', false], ['P2', true, 'chave_rastreio', true],
      ['P3', false, null, false], ['P4', false, null, false],
    ]);
  });

  it('Mercado Livre e Amazon: casam por etiqueta E produto, com link criado antes do pedido', async () => {
    const r = await importarVendas(sql, cliente, [
      venda({ plataforma: 'mercado_livre', pedidoId: 'M1', produtoId: 'MLB1', chaveRastreio: 'wa-s46-casa' }),
      venda({ plataforma: 'mercado_livre', pedidoId: 'M2', produtoId: 'MLB2', chaveRastreio: 'wa-s46-casa' }),
      venda({ plataforma: 'mercado_livre', pedidoId: 'M3', produtoId: 'MLB1', chaveRastreio: 'wa-s46-casa', dataPedido: new Date('2026-11-11T10:00:00Z') }),
      venda({ plataforma: 'amazon', pedidoId: 'A1', produtoId: 'B01', chaveRastreio: 'loja-20' }),
    ]);
    expect(r).toMatchObject({ atribuidas: 2, naoAtribuidas: 2 });
    const [m1] = await sql`select atribuida_por from vendas where pedido_id = 'M1'`;
    expect(m1!.atribuida_por).toBe('etiqueta_produto');
  });

  it('reimportar atualiza a situação, informa a mudança e dá nova chance à não atribuída', async () => {
    await importarVendas(sql, cliente, [venda({ pedidoId: 'P1', chaveRastreio: chave }), venda({ pedidoId: 'P9', chaveRastreio: 'c1-wa-20261112-888-0815' })]);
    const r2 = await importarVendas(sql, cliente, [venda({ pedidoId: 'P1', chaveRastreio: chave, situacao: 'cancelada' })]);
    expect(r2).toMatchObject({ novas: 0, atualizadas: 1 });
    expect(r2.mudancasSituacao).toEqual([{ pedidoId: 'P1', produtoId: '555', de: 'pendente', para: 'cancelada' }]);
    // aparece o link da P9 depois (ex.: link registrado com atraso) → na próxima importação ela é atribuída
    await sql`insert into links (cliente_id, plataforma, url_origem, url_afiliado, chave_rastreio, canal, produto_id)
      values (${cliente.clienteId}, 'shopee', 'https://shopee.com.br/product/9/888', 'https://s.shopee.com.br/L888', 'c1-wa-20261112-888-0815', 'wa', '888')`;
    const r3 = await importarVendas(sql, cliente, [venda({ pedidoId: 'P9', chaveRastreio: 'c1-wa-20261112-888-0815' })]);
    expect(r3.atribuidas).toBe(1);
  });

  it('recusa venda inválida sem gravar nada', async () => {
    await expect(importarVendas(sql, cliente, [venda({}), venda({ pedidoId: '' })])).rejects.toThrow('sem pedido');
    await expect(importarVendas(sql, cliente, [venda({ comissao: '-1' })])).rejects.toThrow('comissao inválido');
    const [contagem] = await sql<{ n: number }[]>`select count(*)::int as n from vendas`;
    expect(contagem!.n).toBe(0);
  });

  it('cliques: Shopee liga ao link; reimportar o mesmo dia substitui', async () => {
    await registrarCliques(sql, cliente, [
      { plataforma: 'shopee', chaveRastreio: chave, dia: '2026-11-12', cliques: 5 },
      { plataforma: 'mercado_livre', chaveRastreio: 'wa-s46-casa', dia: '2026-11-12', cliques: 7 },
    ]);
    await registrarCliques(sql, cliente, [{ plataforma: 'shopee', chaveRastreio: chave, dia: '2026-11-12', cliques: 8 }]);
    const linhas = await sql`select plataforma, cliques, link_id is not null as ligado from cliques order by plataforma`;
    expect(linhas.map((l) => [l.plataforma, l.cliques, l.ligado])).toEqual([['mercado_livre', 7, false], ['shopee', 8, true]]);
    await expect(registrarCliques(sql, cliente, [{ plataforma: 'shopee', chaveRastreio: 'x', dia: '12/11', cliques: 1 }])).rejects.toThrow('Dia');
  });

  it('resumo do período separa pendente, validada e cancelada e mostra as não atribuídas', async () => {
    await importarVendas(sql, cliente, [
      venda({ pedidoId: 'P1', chaveRastreio: chave, comissao: '3.59', situacao: 'pendente' }),
      venda({ pedidoId: 'P2', chaveRastreio: chave, comissao: '2.00', situacao: 'validada' }),
      venda({ pedidoId: 'P3', chaveRastreio: chave, comissao: '1.00', situacao: 'cancelada' }),
      venda({ pedidoId: 'P4', chaveRastreio: null, comissao: '5.00', situacao: 'validada' }),
      venda({ pedidoId: 'P5', chaveRastreio: chave, comissao: '9.00', dataPedido: new Date('2026-11-20T12:00:00Z') }),
    ]);
    await registrarCliques(sql, cliente, [{ plataforma: 'shopee', chaveRastreio: chave, dia: '2026-11-12', cliques: 10 }]);
    const r = await resumoPeriodo(sql, cliente, '2026-11-09', '2026-11-15');
    expect(r.comissao).toEqual({ pendente: '3.59', validada: '7.00', cancelada: '1.00' });
    expect(r.naoAtribuidas).toEqual({ pedidos: 1, comissao: '5.00' });
    expect(r.cliques).toBe(10);
    expect(r.melhoresPostagens).toEqual([{ linkId: linkShopee, chaveRastreio: chave, titulo: 'Organizador', pedidos: 2, comissao: '5.59' }]);
    expect(r.porPlataformaESituacao.map((p) => [p.situacao, p.pedidos])).toEqual([['cancelada', 1], ['pendente', 1], ['validada', 2]]);
  });
});
