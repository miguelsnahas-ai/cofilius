import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { chaveDoUtm, cliquesShopee, conversoesShopee, dinheiroShopee, linkAmazon, tipoPelaUrl, CHAVE_SEM_SUB_ID } from './conversores.ts';
import { clientePareado, gerarPareamento, receberCapturas, ultimosRecebimentos } from './receber.ts';

// Formato da gravação de 13/11/2026, com valores inventados.
function item(o: Record<string, unknown> = {}) {
  return { item_id: 555, item_name: 'Organizador', item_price: 2990000, actual_amount: 2990000, qty: 1, item_commission: 179400,
    display_item_status: 'Pending', item_status: 'PENDING', platform_commission_rate: 6000, shop_id: 9, global_category_lv1_name: 'Casa', ...o };
}
function conversao(o: Record<string, unknown> = {}, itens = [item()], pedido = 'PED1') {
  return { checkout_id: 'K1', checkout_status: 'Pending', purchase_time: 1794496500, utm_content: '----', affiliate_name: 'nao-guardar',
    orders: [{ order_id: '1', order_sn: pedido, items: itens }], ...o };
}
const relatorio = (list: unknown[], total = list.length) => ({ code: 0, msg: 'success', data: { list, page_num: 1, page_size: 20, total_count: total } });
const URL_CONV = 'https://affiliate.shopee.com.br/api/v3/report/list?page_size=20&page_num=1';
const URL_CLIQ = 'https://affiliate.shopee.com.br/api/v1/click_report/list?page_num=1&page_size=20';
const URL_AMZ = 'https://www.amazon.com.br/associates/sitestripe/getShortUrl?longUrl=x&marketplaceId=526970&storeId=loja-20';

describe('conversores da extensão', () => {
  it('reconhece só os dados que o painel usa', () => {
    expect(tipoPelaUrl(URL_CONV)).toBe('shopee.conversoes');
    expect(tipoPelaUrl(URL_CLIQ)).toBe('shopee.cliques');
    expect(tipoPelaUrl(URL_AMZ)).toBe('amazon.link');
    expect(tipoPelaUrl('https://affiliate.shopee.com.br/api/v3/dashboard/detail')).toBeNull();
    expect(tipoPelaUrl('https://outro.com/api/v3/report/list')).toBeNull();
    expect(tipoPelaUrl('nada')).toBeNull();
  });

  it('dinheiro e sub_ids da Shopee', () => {
    expect(dinheiroShopee(4800000)).toBe('48.00');
    expect(dinheiroShopee('2728000')).toBe('27.28');
    expect(dinheiroShopee(-1)).toBeNull();
    expect(chaveDoUtm('----')).toBeNull();
    expect(chaveDoUtm('c1-wa-20261112-555-0815')).toBe('c1-wa-20261112-555-0815');
  });

  it('conversões viram vendas por item, com situação e sem dados da compradora', () => {
    const r = conversoesShopee(relatorio([
      conversao({ utm_content: 'c1-wa-20261112-555-0815' }),
      conversao({}, [item({ display_item_status: 'Cancelled', qty: 0, actual_amount: 0, item_commission: 0, item_price: 4800000 })], 'PED2'),
      conversao({}, [item({ display_item_status: 'Completed' }), item({ display_item_status: 'Completed', qty: 2, actual_amount: 5980000, item_commission: 358800 })], 'PED3'),
    ], 38));
    expect(r.pagina).toEqual({ pagina: 1, tamanho: 20, total: 38 });
    expect(r.vendas.map((v) => [v.pedidoId, v.produtoId, v.situacao, v.valor, v.comissao, v.quantidade, v.chaveRastreio])).toEqual([
      ['PED1', '555', 'pendente', '29.90', '1.79', 1, 'c1-wa-20261112-555-0815'],
      ['PED2', '555', 'cancelada', '48.00', '0.00', 1, null],
      ['PED3', '555', 'validada', '89.70', '5.38', 3, null],
    ]);
    expect(r.vendas[0]!.dataPedido!.toISOString()).toBe('2026-11-12T15:15:00.000Z');
    expect(JSON.stringify(r.vendas)).not.toContain('nao-guardar');
  });

  it('recusa resposta fora do formato', () => {
    expect(() => conversoesShopee({ code: 1 })).toThrow(/formato/);
    expect(() => cliquesShopee({ code: 0, data: {} })).toThrow(/formato/);
  });

  it('cliques e link da Amazon', () => {
    const c = cliquesShopee(relatorio([
      { click_id: 'a', click_time: 1794453521, sub_id: '----' },
      { click_id: 'b', click_time: 1794453521, sub_id: 'c1-wa-20261112-555-0815' },
      { click_id: '', click_time: 1 },
    ], 88));
    expect(c.cliques.map((x) => x.chaveRastreio)).toEqual([CHAVE_SEM_SUB_ID, 'c1-wa-20261112-555-0815']);
    expect(c.pagina.total).toBe(88);
    expect(linkAmazon(URL_AMZ, { isOk: true, ok: true, longUrl: 'https://www.amazon.com.br/Algo/dp/B0DMTGP55X?ref=x', shortUrl: 'https://link.amazon/B04ld' }))
      .toEqual({ asin: 'B0DMTGP55X', urlProduto: 'https://www.amazon.com.br/dp/B0DMTGP55X', urlCurta: 'https://link.amazon/B04ld', trackingId: 'loja-20' });
    expect(linkAmazon(URL_AMZ, { ok: false })).toBeNull();
    expect(linkAmazon(URL_AMZ, { ok: true, longUrl: 'https://www.amazon.com.br/x', shortUrl: 'https://link.amazon/a' })).toBeNull();
  });
});

describe.skipIf(!BANCO_HABILITADO)('extensão → painel (banco)', () => {
  let sql: Sql;
  let cliente: Cliente;
  beforeAll(async () => { sql = await bancoLimpo(); cliente = await buscarCliente(sql, 'c1'); });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate vendas, cliques, cliques_shopee, links, ofertas, recebimentos_extensao, pareamentos_extensao cascade`; });

  it('pareamento: código novo vale, o antigo deixa de valer', async () => {
    const a = await gerarPareamento(sql, 'c1');
    expect((await clientePareado(sql, a))?.codigo).toBe('c1');
    const b = await gerarPareamento(sql, 'c1');
    expect(await clientePareado(sql, a)).toBeNull();
    expect((await clientePareado(sql, b))?.codigo).toBe('c1');
    expect(await clientePareado(sql, undefined)).toBeNull();
    const [linha] = await sql`select codigo_hash from pareamentos_extensao`;
    expect(linha!.codigo_hash).not.toContain(b);
  });

  it('conversões viram vendas atribuídas; reenvio atualiza a situação', async () => {
    const quando = new Date('2026-11-12T10:00:00Z');
    const o = await importarPlanilhaShopee(sql, cliente, 'link;titulo;preco\nhttps://shopee.com.br/P-i.9.555;Organizador;29,90', { quando });
    const l = await registrarLinkManual(sql, { cliente, ofertaId: o.ofertas[0]!.id, link: 'https://s.shopee.com.br/L555', quando });
    const cap = (status: string) => ({ tipo: 'resposta', url: URL_CONV, resposta: { json: relatorio([conversao({ utm_content: l.chaveRastreio }, [item({ display_item_status: status })])]) } });
    const r1 = await receberCapturas(sql, cliente, [cap('Pending'), { tipo: 'visita', url: 'x' }, { tipo: 'resposta', url: 'https://affiliate.shopee.com.br/api/v3/dashboard/detail' }]);
    expect(r1.usados).toBe(1);
    await receberCapturas(sql, cliente, [cap('Completed')]);
    const vendas = await sql`select situacao, link_id, comissao::text from vendas`;
    expect(vendas.map((v) => [v.situacao, v.link_id, v.comissao])).toEqual([['validada', l.id, '1.79']]);
    const u = await ultimosRecebimentos(sql, cliente);
    expect(u.ultimos.map((x) => x.tipo)).toEqual(['shopee.conversoes']);
  });

  it('cliques: páginas repetidas não contam duas vezes', async () => {
    const pag = { tipo: 'resposta', url: URL_CLIQ, resposta: { json: relatorio([
      { click_id: 'a', click_time: 1794453521, sub_id: '----' },
      { click_id: 'b', click_time: 1794453600, sub_id: '----' },
    ]) } };
    await receberCapturas(sql, cliente, [pag, pag]);
    await receberCapturas(sql, cliente, [{ ...pag, resposta: { json: relatorio([{ click_id: 'c', click_time: 1794453700, sub_id: '----' }]) } }]);
    const cl = await sql`select chave_rastreio, to_char(dia, 'YYYY-MM-DD') as dia, cliques from cliques`;
    expect(cl.map((c) => [c.chave_rastreio, c.dia, c.cliques])).toEqual([[CHAVE_SEM_SUB_ID, '2026-11-12', 3]]);
  });

  it('link da Amazon vira link (uma vez só); erro fica registrado', async () => {
    const cap = { tipo: 'resposta', url: URL_AMZ, resposta: { json: { ok: true, longUrl: 'https://www.amazon.com.br/x/dp/B0DMTGP55X', shortUrl: 'https://link.amazon/B04ld' } } };
    await receberCapturas(sql, cliente, [cap, cap]);
    const links = await sql`select plataforma, produto_id, chave_rastreio, url_afiliado from links`;
    expect(links.map((l) => [l.plataforma, l.produto_id, l.chave_rastreio, l.url_afiliado])).toEqual([['amazon', 'B0DMTGP55X', 'loja-20', 'https://link.amazon/B04ld']]);
    const r = await receberCapturas(sql, cliente, [{ tipo: 'resposta', url: URL_CONV, resposta: { json: { code: 9 } } }]);
    expect(r.falhas[0]).toMatch(/formato/);
    const [e] = await sql`select erro from recebimentos_extensao where erro is not null`;
    expect(e!.erro).toMatch(/formato/);
  });
});
