/**
 * Conversores dos dados que a extensão manda ao painel: pegam a resposta JSON que a própria página
 * da plataforma carregou e devolvem o formato do Cofilius. Funções puras (sem banco).
 *
 * Formatos confirmados pela gravação de 13/11/2026 (extensão 0.2.0). O que ainda é suposição está
 * marcado com TODO(confirmar).
 */
import { chaveShopee, type Situacao, type VendaNormalizada } from '../vendas/atribuicao.ts';
import type { OfertaShopee } from '../shopee/parser.ts';

export type TipoRecebido = 'shopee.conversoes' | 'shopee.cliques' | 'amazon.link' | 'shopee.ofertas' | 'shopee.link';

/** Operação GraphQL do painel da Shopee que gera o link personalizado (com os 5 sub_ids). */
export const OPERACAO_LINK_SHOPEE = 'batchGetCustomLink';

/**
 * Tipo da captura pelo endereço e, no GraphQL da Shopee (um endereço para tudo), pela operação do pedido.
 * null = não interessa ao painel.
 */
export function tipoDaCaptura(endereco: string, pedidoJson?: unknown): TipoRecebido | null {
  const pelaUrl = tipoPelaUrl(endereco);
  if (pelaUrl) return pelaUrl;
  let u: URL;
  try { u = new URL(endereco); } catch { return null; }
  if (u.protocol === 'https:' && u.hostname === 'affiliate.shopee.com.br' && u.pathname === '/api/v3/gql'
      && obj(pedidoJson)?.operationName === OPERACAO_LINK_SHOPEE) return 'shopee.link';
  return null;
}

/** Qual dado é, pelo endereço da chamada. null = não interessa ao painel. */
export function tipoPelaUrl(endereco: string): TipoRecebido | null {
  let u: URL;
  try { u = new URL(endereco); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.hostname === 'affiliate.shopee.com.br') {
    if (u.pathname === '/api/v3/report/list') return 'shopee.conversoes';
    if (u.pathname === '/api/v1/click_report/list') return 'shopee.cliques';
    if (u.pathname === '/api/v3/offer/product/list') return 'shopee.ofertas';
  }
  if (u.hostname === 'www.amazon.com.br' && u.pathname === '/associates/sitestripe/getShortUrl') return 'amazon.link';
  return null;
}

type Obj = Record<string, any>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

/**
 * Valores em dinheiro da Shopee vêm inteiros, em centésimos de milésimo de real (4800000 = R$ 48,00).
 * TODO(confirmar): escala 100000 deduzida de item_price e da taxa (3000 = 3%), conferir com o painel.
 */
export const ESCALA_SHOPEE = 100000;

export function dinheiroShopee(v: unknown): string | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return (n / ESCALA_SHOPEE).toFixed(2);
}

/** Sub_ids da Shopee chegam unidos por "-" em utm_content (ou sub_id, no relatório de cliques). */
export function chaveDoUtm(utm: unknown): string | null {
  if (typeof utm !== 'string') return null;
  return chaveShopee(utm.split('-'));
}

/**
 * Situação do item: "Cancelled" → cancelada; "Completed" → validada; o resto (Pending...) → pendente.
 * TODO(confirmar): se "Completed" na Shopee já é comissão validada ou só pedido concluído aguardando validação.
 */
export function situacaoShopee(item: Obj): Situacao {
  const s = String(item.display_item_status ?? item.item_status ?? '').toLowerCase();
  if (s.startsWith('cancel') || s === 'invalid') return 'cancelada';
  if (s === 'completed') return 'validada';
  return 'pendente';
}

export interface Pagina { pagina: number; tamanho: number; total: number }

function paginaDe(data: Obj): Pagina {
  return { pagina: Number(data.page_num) || 1, tamanho: Number(data.page_size) || 0, total: Number(data.total_count) || 0 };
}

/** Relatório de conversões (api/v3/report/list) → vendas, uma por item de pedido. */
export function conversoesShopee(json: unknown): { vendas: VendaNormalizada[]; pagina: Pagina; ignorados: number } {
  const data = obj(obj(json)?.data);
  if (obj(json)?.code !== 0 || !data || !Array.isArray(data.list)) throw new Error('Resposta da Shopee fora do formato esperado (conversões).');
  const porChave = new Map<string, VendaNormalizada>();
  let ignorados = 0;
  for (const conv of data.list) {
    const c = obj(conv);
    if (!c || !Array.isArray(c.orders)) { ignorados++; continue; }
    const chave = chaveDoUtm(c.utm_content);
    const dataPedido = Number(c.purchase_time) > 0 ? new Date(Number(c.purchase_time) * 1000) : null;
    for (const ped of c.orders) {
      const p = obj(ped);
      const pedidoId = String(p?.order_sn || p?.order_id || '').trim();
      if (!p || !pedidoId || !Array.isArray(p.items)) { ignorados++; continue; }
      for (const it of p.items) {
        const i = obj(it);
        const produtoId = i && i.item_id != null ? String(i.item_id) : '';
        if (!i || !produtoId) { ignorados++; continue; }
        const qtd = Number(i.qty) > 0 ? Number(i.qty) : 1;
        const valor = Number(i.actual_amount) > 0 ? dinheiroShopee(i.actual_amount) : dinheiroShopee(Number(i.item_price) * qtd);
        const comissao = dinheiroShopee(i.item_commission) ?? '0.00';
        const k = `${pedidoId}|${produtoId}`;
        const antes = porChave.get(k);
        if (antes) {
          // Mesmo produto em variações diferentes no mesmo pedido: soma.
          antes.quantidade = (antes.quantidade ?? 1) + qtd;
          antes.valor = (Number(antes.valor ?? 0) + Number(valor ?? 0)).toFixed(2);
          antes.comissao = (Number(antes.comissao ?? 0) + Number(comissao)).toFixed(2);
          continue;
        }
        porChave.set(k, {
          plataforma: 'shopee',
          pedidoId,
          produtoId,
          produtoNome: typeof i.item_name === 'string' ? i.item_name : null,
          quantidade: qtd,
          valor,
          comissao,
          situacao: situacaoShopee(i),
          chaveRastreio: chave,
          dataPedido,
          // Só o que ajuda a conferir; nada da compradora.
          bruto: {
            fonte: 'extensao', checkout_id: c.checkout_id ?? null, status_item: i.display_item_status ?? null,
            status_checkout: c.checkout_status ?? null, taxa_plataforma: i.platform_commission_rate ?? null,
            categoria: i.global_category_lv1_name ?? null, loja: i.shop_id ?? null,
          },
        });
      }
    }
  }
  return { vendas: [...porChave.values()], pagina: paginaDe(data), ignorados };
}

export interface CliqueShopee { clickId: string; chaveRastreio: string; clicadoEm: Date }

/** Sem sub_id (link genérico): os cliques são contados numa chave própria. */
export const CHAVE_SEM_SUB_ID = 'sem-sub-id';

/** Relatório de cliques (api/v1/click_report/list) → cliques individuais. */
export function cliquesShopee(json: unknown): { cliques: CliqueShopee[]; pagina: Pagina } {
  const data = obj(obj(json)?.data);
  if (obj(json)?.code !== 0 || !data || !Array.isArray(data.list)) throw new Error('Resposta da Shopee fora do formato esperado (cliques).');
  const cliques: CliqueShopee[] = [];
  for (const x of data.list) {
    const c = obj(x);
    if (!c || !c.click_id || !(Number(c.click_time) > 0)) continue;
    cliques.push({
      clickId: String(c.click_id),
      chaveRastreio: chaveDoUtm(c.sub_id) ?? CHAVE_SEM_SUB_ID,
      clicadoEm: new Date(Number(c.click_time) * 1000),
    });
  }
  return { cliques, pagina: paginaDe(data) };
}

export interface LinkAmazon { asin: string; urlProduto: string; urlCurta: string; trackingId: string }

/** SiteStripe (getShortUrl): o link curto que a Amazon acabou de gerar para um produto. */
export function linkAmazon(endereco: string, json: unknown): LinkAmazon | null {
  const r = obj(json);
  if (!r || !(r.ok === true || r.isOk === true)) return null;
  const longa = typeof r.longUrl === 'string' ? r.longUrl : '';
  const curta = typeof r.shortUrl === 'string' ? r.shortUrl : '';
  const asin = longa.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/)?.[1];
  let tracking = '';
  try { tracking = new URL(endereco).searchParams.get('storeId') ?? ''; } catch { /* sem tracking */ }
  if (!asin || !/^https:\/\/(link\.amazon|amzn\.to)\//.test(curta)) return null;
  if (!tracking) {
    try { tracking = new URL(longa).searchParams.get('tag') ?? ''; } catch { /* idem */ }
  }
  if (!tracking) return null;
  return { asin, urlProduto: `https://www.amazon.com.br/dp/${asin}`, urlCurta: curta, trackingId: tracking };
}

// ---------------------------------------------------------------------------
// Lista de ofertas do painel de afiliados (api/v3/offer/product/list)
// ---------------------------------------------------------------------------

/** Endereço da foto a partir do código da imagem. TODO(confirmar): domínio das imagens no Brasil. */
export const BASE_IMAGEM_SHOPEE = 'https://down-br.img.susercontent.com/file/';

function pct(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace('%', '').replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Ofertas da lista do painel. Preços na mesma escala dos relatórios (÷ 100000).
 * Comissão = taxa padrão da Shopee + taxa do vendedor (TODO(confirmar): se o painel soma as duas, como
 * no selo "comissão até X%"; max_commission_rate veio 0% na gravação).
 */
export function ofertasShopee(json: unknown): { ofertas: OfertaShopee[]; descartadas: number; total: number } {
  const data = obj(obj(json)?.data);
  if (obj(json)?.code !== 0 || !data || !Array.isArray(data.list)) throw new Error('Resposta da Shopee fora do formato esperado (ofertas).');
  const ofertas: OfertaShopee[] = [];
  let descartadas = 0;
  for (const x of data.list) {
    const o = obj(x);
    const i = obj(o?.batch_item_for_item_card_full);
    const produtoId = String(i?.itemid ?? o?.item_id ?? '').trim();
    const lojaId = String(i?.shopid ?? '').trim();
    const preco = dinheiroShopee(i?.price_min ?? i?.price);
    if (!o || !i || !/^\d+$/.test(produtoId) || !/^\d+$/.test(lojaId) || !preco || typeof i.name !== 'string') { descartadas++; continue; }
    const base = pct(o.default_commission_rate) ?? 0;
    const vendedor = pct(o.seller_commission_rate) ?? 0;
    const comissao = base + vendedor > 0 ? base + vendedor : null;
    const desconto = pct(i.raw_discount ?? i.show_discount ?? i.discount);
    const nota = typeof obj(i.item_rating)?.rating_star === 'number' ? Number(obj(i.item_rating)!.rating_star) : null;
    ofertas.push({
      produtoId,
      lojaId,
      titulo: i.name.slice(0, 300),
      urlProduto: `https://shopee.com.br/product/${lojaId}/${produtoId}`,
      urlOferta: null,
      imagemUrl: typeof i.image === 'string' && /^[\w-]+$/.test(i.image) ? BASE_IMAGEM_SHOPEE + i.image : null,
      lojaNome: typeof i.shop_name === 'string' ? i.shop_name.slice(0, 120) : null,
      preco,
      precoMaximo: dinheiroShopee(i.price_max),
      descontoPct: desconto && desconto > 0 && desconto <= 100 ? desconto.toFixed(2) : null,
      comissaoPct: comissao !== null ? comissao.toFixed(2) : null,
      comissaoValor: comissao !== null ? ((Number(preco) * comissao) / 100).toFixed(2) : null,
      vendas: Number.isInteger(i.historical_sold) ? Number(i.historical_sold) : null,
      // Sem avaliações a Shopee manda 0 estrelas: vira "sem avaliação", não nota zero.
      avaliacao: nota !== null && nota > 0 && nota <= 5 ? nota.toFixed(2) : null,
      validadeInicio: null,
      validadeFim: null,
      bruto: { fonte: 'extensao', taxa_padrao: o.default_commission_rate ?? null, taxa_vendedor: o.seller_commission_rate ?? null,
        estoque: i.stock ?? null, oficial: i.is_official_shop ?? null },
    });
  }
  return { ofertas, descartadas, total: Number(data.total_count) || 0 };
}

// ---------------------------------------------------------------------------
// Link personalizado (GraphQL batchGetCustomLink): o que ela gerou no painel da Shopee
// ---------------------------------------------------------------------------

export interface LinkPersonalizado { urlOrigem: string; subIds: string[]; linkCurto: string }

export function linksPersonalizados(pedidoJson: unknown, respostaJson: unknown): LinkPersonalizado[] {
  const params = obj(obj(pedidoJson)?.variables)?.linkParams;
  const resps = obj(obj(respostaJson)?.data)?.batchCustomLink;
  if (!Array.isArray(params) || !Array.isArray(resps)) throw new Error('Resposta da Shopee fora do formato esperado (link personalizado).');
  const saida: LinkPersonalizado[] = [];
  params.forEach((p, i) => {
    const r = obj(resps[i]);
    const a = obj(obj(p)?.advancedLinkParams);
    const origem = obj(p)?.originalLink;
    if (!r || r.failCode !== 0 || typeof r.shortLink !== 'string' || typeof origem !== 'string' || !a) return;
    saida.push({
      urlOrigem: origem,
      subIds: [a.subId1, a.subId2, a.subId3, a.subId4, a.subId5].map((v) => (typeof v === 'string' ? v.trim() : '')),
      linkCurto: r.shortLink,
    });
  });
  return saida;
}
