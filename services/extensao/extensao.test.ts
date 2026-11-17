import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { chaveDoUtm, cliquesShopee, conversoesShopee, dinheiroShopee, linkAmazon, linksPersonalizados, ofertasShopee, tipoDaCaptura, tipoPelaUrl, CHAVE_SEM_SUB_ID } from './conversores.ts';
import { criarCriativo, criativosDoDia } from '../criativos/criativos.ts';
import type { ModeloIA } from '../../harness/agentes.ts';
import { linksPendentes } from '../../painel/api.ts';
import { curarDia } from '../curadoria/curador.ts';
import { precoDoTexto, produtoAmazonValido, definirTrackingAmazon, linkAmazonDaOferta, trackingAmazon } from '../ofertas/ofertasAmazon.ts';
import { painelDoDia } from '../../painel/api.ts';
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
const URL_OFERTAS = 'https://affiliate.shopee.com.br/api/v3/offer/product/list?list_type=7&sort_type=1&page_offset=0&page_limit=20';
const URL_GQL = 'https://affiliate.shopee.com.br/api/v3/gql';
function itemOferta(o: Record<string, unknown> = {}, i: Record<string, unknown> = {}) {
  return { item_id: '555', default_commission_rate: '7%', seller_commission_rate: '4%', max_commission_rate: '0%',
    batch_item_for_item_card_full: { itemid: '555', shopid: '9', name: 'Organizador de Gaveta', price: 2990000, price_min: 2990000, price_max: 3490000,
      raw_discount: 25, image: 'br-11134207-abc', shop_name: 'Loja', historical_sold: 1520, stock: 10, item_rating: { rating_star: 4.8 }, ...i }, ...o };
}
const listaOfertas = (list: unknown[]) => ({ code: 0, data: { list, page_offset: 0, page_limit: 20, total_count: 396 } });
const pedidoLink = (subs: string[], origem = 'https://shopee.com.br/Organizador-i.9.555') => ({ json: { operationName: 'batchGetCustomLink',
  variables: { linkParams: [{ originalLink: origem, advancedLinkParams: { subId1: subs[0], subId2: subs[1], subId3: subs[2], subId4: subs[3], subId5: subs[4] } }] } } });
const respostaLink = (curto: string, failCode = 0) => ({ data: { batchCustomLink: [{ shortLink: curto, longLink: 'https://shopee.com.br/x', failCode }] } });
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

  it('ofertas da lista do painel e link personalizado', () => {
    expect(tipoDaCaptura(URL_OFERTAS)).toBe('shopee.ofertas');
    expect(tipoDaCaptura(URL_GQL, pedidoLink(['c1', 'wa', '20261112', '555', '0815']).json)).toBe('shopee.link');
    expect(tipoDaCaptura(URL_GQL, { operationName: 'productsRankList' })).toBeNull();
    expect(tipoDaCaptura(URL_GQL)).toBeNull();
    const r = ofertasShopee(listaOfertas([itemOferta(), itemOferta({}, { item_rating: { rating_star: 0 }, raw_discount: 0 }), { item_id: 'x' }]));
    expect(r.total).toBe(396);
    expect(r.descartadas).toBe(1);
    expect(r.ofertas[0]).toMatchObject({ produtoId: '555', lojaId: '9', preco: '29.90', precoMaximo: '34.90', descontoPct: '25.00',
      comissaoPct: '11.00', comissaoValor: '3.29', vendas: 1520, avaliacao: '4.80', urlProduto: 'https://shopee.com.br/product/9/555',
      imagemUrl: 'https://down-br.img.susercontent.com/file/br-11134207-abc' });
    expect(r.ofertas[1]).toMatchObject({ avaliacao: null, descontoPct: null });
    expect(linksPersonalizados(pedidoLink(['c1', 'wa', '20261112', '555', '0815']).json, respostaLink('https://s.shopee.com.br/AB1')))
      .toEqual([{ urlOrigem: 'https://shopee.com.br/Organizador-i.9.555', subIds: ['c1', 'wa', '20261112', '555', '0815'], linkCurto: 'https://s.shopee.com.br/AB1' }]);
    expect(linksPersonalizados(pedidoLink(['c1', 'wa', '20261112', '555', '0815']).json, respostaLink('https://s.shopee.com.br/AB1', 7))).toEqual([]);
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

describe('produto da Amazon (página do site)', () => {
  it('lê preço em reais e valida o que a extensão mandou', () => {
    expect(precoDoTexto('R$69,99')).toBe('69.99');
    expect(precoDoTexto('R$ 1.234,56')).toBe('1234.56');
    expect(precoDoTexto('grátis')).toBeNull();
    expect(produtoAmazonValido({ asin: 'b0hdvzqpt6', titulo: 'Garrafa Térmica 1L', preco: 'R$69,99', precoAntes: 'R$94,99', desconto: '-26%',
      nota: '4,8 de 5 estrelas', avaliacoes: '5.944 Análises', categoria: ['Casa', ' Cozinha '] }))
      .toEqual({ asin: 'B0HDVZQPT6', titulo: 'Garrafa Térmica 1L', preco: '69.99', precoAntes: '94.99', descontoPct: '26.00', nota: '4.80', avaliacoes: 5944, categoria: ['Casa', 'Cozinha'] });
    // Desconto calculado quando a página não mostra a porcentagem.
    expect(produtoAmazonValido({ asin: 'B0HDVZQPT6', titulo: 'Garrafa', preco: 'R$75,00', precoAntes: 'R$100,00' })?.descontoPct).toBe('25.00');
    expect(produtoAmazonValido({ asin: 'curto', titulo: 'Garrafa', preco: 'R$1,00' })).toBeNull();
    expect(produtoAmazonValido({ asin: 'B0HDVZQPT6', titulo: 'Garrafa' })).toBeNull();
  });
});

describe.skipIf(!BANCO_HABILITADO)('extensão → painel (banco)', () => {
  let sql: Sql;
  let cliente: Cliente;
  beforeAll(async () => { sql = await bancoLimpo(); cliente = await buscarCliente(sql, 'c1'); });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate vendas, cliques, cliques_shopee, links, ofertas, criativos, recebimentos_extensao, pareamentos_extensao cascade`; });

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

  it('ofertas da lista viram ofertas do dia, com nicho pelas palavras-chave', async () => {
    await sql`update clientes set nichos = '[{"slug":"casa","nome":"Casa","palavras_chave":["organizador"]}]' where codigo = 'c1'`;
    const r = await receberCapturas(sql, cliente, [{ tipo: 'resposta', url: URL_OFERTAS,
      resposta: { json: listaOfertas([itemOferta(), itemOferta({ item_id: '556' }, { itemid: '556', name: 'Fone Bluetooth' })]) } }]);
    expect(r.usados).toBe(1);
    const ofertas = await sql`select produto_id, nicho, preco::text, comissao_pct::text, imagem_url from ofertas order by produto_id`;
    expect(ofertas.map((o) => [o.produto_id, o.nicho, o.preco, o.comissao_pct])).toEqual([['555', 'casa', '29.90', '11.0000'], ['556', null, '29.90', '11.0000']]);
  });

  it('link personalizado gerado no painel: registra pelo padrão de sub_ids e liga ao criativo do Instagram', async () => {
    await receberCapturas(sql, cliente, [{ tipo: 'resposta', url: URL_OFERTAS, resposta: { json: listaOfertas([itemOferta()]) } }]);
    const [oferta] = await sql`select id from ofertas where produto_id = '555'`;
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const modelo: ModeloIA = { async gerar() { return { texto: JSON.stringify({ gancho: 'Gaveta em ordem já', telas: [1, 2, 3, 4].map(() => ({ titulo: 'Tudo no lugar', texto: 'Cabe tudo.' })), cta: 'Comenta EU QUERO', legenda: 'Ordem na casa ✨' }), tokensEntrada: 1, tokensSaida: 1 }; } };
    const criativo = await criarCriativo(sql, { cliente, ofertaId: oferta!.id, formato: 'reels', dataLista: hoje, modelo });
    const cap = (subs: string[], curto: string) => ({ tipo: 'resposta', url: URL_GQL, pedido: pedidoLink(subs), resposta: { json: respostaLink(curto) } });
    const r = await receberCapturas(sql, cliente, [
      cap(['c1', 'wa', '20261113', '555', '0815'], 'https://s.shopee.com.br/WA1'),
      cap(['c1', 'ig', '20261113', '555', '0816'], 'https://s.shopee.com.br/IG1'),
      cap(['outro', 'wa', '20261113', '555', '0815'], 'https://s.shopee.com.br/X1'),
      cap(['c1', 'wa', '20261113', '555', '0815'], 'https://s.shopee.com.br/WA1'),
    ]);
    expect(r.resultados.map((x) => x.detalhe)).toEqual([
      'link registrado: https://s.shopee.com.br/WA1 (WhatsApp)',
      'link registrado: https://s.shopee.com.br/IG1 (Instagram)',
      'nenhum link registrado (https://s.shopee.com.br/X1: sub_ids fora do padrão do Cofilius)',
      'nenhum link registrado (https://s.shopee.com.br/WA1: já registrado)',
    ]);
    const links = await sql`select url_afiliado, canal, chave_rastreio, oferta_id from links order by url_afiliado`;
    expect(links.map((l) => [l.url_afiliado, l.canal, l.chave_rastreio, l.oferta_id === oferta!.id]))
      .toEqual([['https://s.shopee.com.br/IG1', 'ig', 'c1-ig-20261113-555-0816', true], ['https://s.shopee.com.br/WA1', 'wa', 'c1-wa-20261113-555-0815', true]]);
    const [c] = await criativosDoDia(sql, cliente, hoje);
    expect(c).toMatchObject({ id: criativo, link: 'https://s.shopee.com.br/IG1' });
  });

  it('pareamento guarda o id da extensão; links pendentes do dia (WhatsApp e Instagram) com os sub_ids da tela', async () => {
    const codigo = await gerarPareamento(sql, 'c1');
    await clientePareado(sql, codigo, 'abcdefghijklmnopabcdefghijklmnop');
    await clientePareado(sql, codigo, 'id-invalido'); // id fora do formato não apaga o bom
    const [p] = await sql`select extensao_id from pareamentos_extensao`;
    expect(p!.extensao_id).toBe('abcdefghijklmnopabcdefghijklmnop');

    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const quando = new Date();
    const { importarPlanilhaShopee } = await import('../ofertas/importarPlanilhaShopee.ts');
    await importarPlanilhaShopee(sql, cliente, 'link;titulo;preco\nhttps://shopee.com.br/A-i.9.555;Organizador;29,90\nhttps://shopee.com.br/B-i.9.556;Cesto;19,90', { quando });
    const modelo: ModeloIA = { async gerar(pp) {
      const e = JSON.parse(pp.entrada) as { candidatas: { id: string }[] };
      return { texto: JSON.stringify({ escolhas: e.candidatas.map((c) => ({ oferta_id: c.id, motivo: 'ok' })) }), tokensEntrada: 1, tokensSaida: 1 };
    } };
    await curarDia(sql, { cliente, data: hoje, modelo, quantidade: 2 });
    let r = await linksPendentes(sql, cliente);
    expect(r.links.map((l) => [l.canal, l.subIds[0], l.subIds[1], l.subIds[3]]).sort()).toEqual([['wa', 'c1', 'wa', '555'], ['wa', 'c1', 'wa', '556']]);
    // Link do Instagram não conta como link da mensagem do grupo.
    const [o] = await sql`select id from ofertas where produto_id = '555'`;
    await sql`insert into links (cliente_id, oferta_id, plataforma, url_origem, url_afiliado, sub_ids, chave_rastreio, canal, produto_id)
              values (${cliente.clienteId}, ${o!.id}, 'shopee', 'https://shopee.com.br/product/9/555', 'https://s.shopee.com.br/IGX', ${['c1', 'ig', '20261117', '555', '0900']}, 'c1-ig-20261117-555-0900', 'ig', '555')`;
    r = await linksPendentes(sql, cliente);
    expect(r.links.filter((l) => l.canal === 'wa').map((l) => l.subIds[3]).sort()).toEqual(['555', '556']);
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

  it('Amazon: produto aberto vira oferta; Curador escolhe; link com o tracking ID do canal; texto sem preço', async () => {
    await sql`update clientes set amazon_tracking = '{}' where cliente_id = ${cliente.clienteId}`;
    const dados = { asin: 'B0HDVZQPT6', titulo: 'Garrafa Térmica Inox 1L', preco: 'R$69,99', precoAntes: 'R$94,99', desconto: '-26%', nota: '4,8 de 5 estrelas', avaliacoes: '(5.944)', categoria: ['Cozinha'] };
    const cap = { tipo: 'oferta', plataforma: 'amazon', url: 'https://www.amazon.com.br/dp/B0HDVZQPT6', quando: new Date().toISOString(), dados };
    const r = await receberCapturas(sql, cliente, [cap, cap, { ...cap, dados: { asin: 'X' } }]);
    expect(r.usados).toBe(2);
    expect(r.falhas).toHaveLength(1);
    const ofertas = await sql`select id, plataforma, produto_id, preco::text, desconto_pct::text, url_produto, imagem_url from ofertas`;
    expect(ofertas).toHaveLength(1);
    expect(ofertas[0]).toMatchObject({ plataforma: 'amazon', produto_id: 'B0HDVZQPT6', preco: '69.99', desconto_pct: '26.0000', url_produto: 'https://www.amazon.com.br/dp/B0HDVZQPT6', imagem_url: null });

    // Sem tracking ID: o Curador escolhe, mas o link fica esperando o cadastro.
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const modelo: ModeloIA = { async gerar(pp) {
      const e = JSON.parse(pp.entrada) as { candidatas: { id: string; plataforma: string }[] };
      expect(e.candidatas[0]!.plataforma).toBe('amazon');
      return { texto: JSON.stringify({ escolhas: e.candidatas.map((c) => ({ oferta_id: c.id, motivo: 'ok' })) }), tokensEntrada: 1, tokensSaida: 1 };
    } };
    await curarDia(sql, { cliente, data: hoje, modelo, quantidade: 1 });
    expect(await sql`select id from links`).toHaveLength(0);
    let dia = await painelDoDia({ sql } as never, 'c1');
    expect(dia.selecionadas[0]).toMatchObject({ plataforma: 'amazon', linkUrl: null, faltaTrackingAmazon: true });

    // Tracking ID inválido é recusado; o válido gera o link na abertura do Dia.
    await expect(definirTrackingAmazon(sql, cliente, { wa: 'sem-sufixo' })).rejects.toThrow(/-20/);
    await definirTrackingAmazon(sql, cliente, { wa: 'Silvana-20' });
    expect(await trackingAmazon(sql, cliente)).toEqual({ wa: 'silvana-20' });
    dia = await painelDoDia({ sql } as never, 'c1');
    expect(dia.selecionadas[0]).toMatchObject({ linkUrl: 'https://www.amazon.com.br/dp/B0HDVZQPT6?tag=silvana-20', faltaTrackingAmazon: false });
    // Sem repetir o link; Instagram só com o tracking próprio.
    await painelDoDia({ sql } as never, 'c1');
    expect(await sql`select canal from links`).toEqual([{ canal: 'wa' }]);
    expect(await linkAmazonDaOferta(sql, cliente, ofertas[0]!.id, 'ig')).toBeNull();
    await definirTrackingAmazon(sql, cliente, { ig: 'silvanaig-20' });
    expect((await linkAmazonDaOferta(sql, cliente, ofertas[0]!.id, 'ig'))?.url).toBe('https://www.amazon.com.br/dp/B0HDVZQPT6?tag=silvanaig-20');
    await sql`update clientes set amazon_tracking = '{}' where cliente_id = ${cliente.clienteId}`;
  });
});
