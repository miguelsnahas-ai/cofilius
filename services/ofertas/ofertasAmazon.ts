/**
 * Ofertas da Amazon vistas pela afiliada no próprio site (não há página de ofertas para associados):
 * a extensão lê a página do produto e manda os dados; aqui viram ofertas do dia, com o nicho achado
 * pelas palavras-chave do cliente. Sem foto (as Políticas do Programa de Associados não deixam guardar
 * as imagens) e sem comissão (a Amazon não mostra na página; depende da categoria).
 */
import type { Sql } from '../../harness/db.ts';
import type { Cliente } from '../../db/clientes.ts';
import { dataLocal } from '../lista/lista.ts';

export interface ProdutoAmazon {
  asin: string;
  titulo: string;
  /** Preço em texto decimal ("69.99"). */
  preco: string;
  precoAntes: string | null;
  descontoPct: string | null;
  nota: string | null;
  avaliacoes: number | null;
  categoria: string[];
}

const ASIN = /^[A-Z0-9]{10}$/;

/** "R$1.234,56" → "1234.56"; null se não for preço. */
export function precoDoTexto(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.replace(/\s/g, '').match(/R\$?([\d.]+(?:,\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]!.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

/** Confere e normaliza o que a extensão mandou. null = descartar. */
export function produtoAmazonValido(d: unknown): ProdutoAmazon | null {
  const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const asin = typeof o.asin === 'string' ? o.asin.trim().toUpperCase() : '';
  const titulo = typeof o.titulo === 'string' ? o.titulo.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const preco = precoDoTexto(o.preco);
  if (!ASIN.test(asin) || titulo.length < 3 || !preco) return null;
  const antes = precoDoTexto(o.precoAntes);
  const desc = typeof o.desconto === 'string' ? Number(o.desconto.replace(/[^\d]/g, '')) : NaN;
  const descontoPct = Number.isFinite(desc) && desc > 0 && desc < 100 ? desc.toFixed(2)
    : antes && Number(antes) > Number(preco) ? (100 * (1 - Number(preco) / Number(antes))).toFixed(2) : null;
  const notaM = typeof o.nota === 'string' ? o.nota.match(/(\d+(?:[.,]\d+)?)\s*de\s*5/) : null;
  const nota = notaM ? Number(notaM[1]!.replace(',', '.')) : NaN;
  const aval = typeof o.avaliacoes === 'string' ? Number(o.avaliacoes.replace(/[^\d]/g, '')) : NaN;
  return {
    asin, titulo, preco,
    precoAntes: antes && Number(antes) > Number(preco) ? antes : null,
    descontoPct,
    nota: nota > 0 && nota <= 5 ? nota.toFixed(2) : null,
    avaliacoes: Number.isInteger(aval) && aval >= 0 ? aval : null,
    categoria: Array.isArray(o.categoria) ? o.categoria.filter((c): c is string => typeof c === 'string').map((c) => c.trim()).filter(Boolean).slice(0, 6) : [],
  };
}

const semAcento = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Grava (ou atualiza) a oferta do dia. Devolve o id e se é nova. */
export async function gravarOfertaAmazon(sql: Sql, cliente: Cliente, p: ProdutoAmazon, quando = new Date()) {
  const [c] = await sql`select nichos from clientes where cliente_id = ${cliente.clienteId}`;
  const texto = semAcento(`${p.titulo} ${p.categoria.join(' ')}`);
  const nichos = (c?.nichos ?? []) as { slug: string; palavras_chave?: string[] }[];
  const achado = nichos.map((n) => ({ n, p: (n.palavras_chave ?? []).map(semAcento).find((w) => w && texto.includes(w)) })).find((x) => x.p);
  const [o] = await sql`
    insert into ofertas (cliente_id, plataforma, produto_id, nicho, palavra_chave, titulo, url_produto, preco, preco_maximo,
                         desconto_pct, avaliacao, vendas, data_coleta, preco_conferido_em, dados_brutos)
    values (${cliente.clienteId}, 'amazon', ${p.asin}, ${achado?.n.slug ?? null}, ${achado?.p ?? null}, ${p.titulo},
            ${`https://www.amazon.com.br/dp/${p.asin}`}, ${p.preco}, ${p.precoAntes}, ${p.descontoPct}, ${p.nota}, null,
            ${dataLocal(quando, cliente.fusoHorario)}, ${quando},
            ${sql.json({ fonte: 'extensao.pagina_produto', avaliacoes: p.avaliacoes, categoria: p.categoria })})
    on conflict (cliente_id, plataforma, produto_id, data_coleta) do update set
      titulo = excluded.titulo, preco = excluded.preco, preco_maximo = excluded.preco_maximo,
      desconto_pct = excluded.desconto_pct, avaliacao = coalesce(excluded.avaliacao, ofertas.avaliacao),
      nicho = coalesce(ofertas.nicho, excluded.nicho), palavra_chave = coalesce(ofertas.palavra_chave, excluded.palavra_chave),
      preco_conferido_em = excluded.preco_conferido_em, dados_brutos = ofertas.dados_brutos || excluded.dados_brutos
    returning id, (xmax = 0) as nova, nicho`;
  return { id: o!.id as string, nova: !!o!.nova, nicho: o!.nicho as string | null };
}

// ---------------------------------------------------------------------------
// Links: endereço do produto com o tracking ID do canal
// ---------------------------------------------------------------------------

const TRACKING = /^[a-z0-9-]{3,40}-2[0-9]$/i;

export async function trackingAmazon(sql: Sql, cliente: Cliente): Promise<Record<string, string>> {
  const [c] = await sql`select amazon_tracking from clientes where cliente_id = ${cliente.clienteId}`;
  const t = (c?.amazon_tracking ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(t).filter(([, v]) => typeof v === 'string' && TRACKING.test(v))) as Record<string, string>;
}

export async function definirTrackingAmazon(sql: Sql, cliente: Cliente, valores: { wa?: string | null; ig?: string | null }): Promise<Record<string, string>> {
  const atual = await trackingAmazon(sql, cliente);
  for (const canal of ['wa', 'ig'] as const) {
    const v = valores[canal];
    if (v === undefined) continue;
    if (v === null || v.trim() === '') { delete atual[canal]; continue; }
    if (!TRACKING.test(v.trim())) throw new Error(`Tracking ID inválido: "${v}". Ele termina com -20 (ex.: silgoncalve05-20).`);
    atual[canal] = v.trim().toLowerCase();
  }
  await sql`update clientes set amazon_tracking = ${sql.json(atual)} where cliente_id = ${cliente.clienteId}`;
  return atual;
}

/**
 * Link de afiliado de uma oferta da Amazon no canal: https://www.amazon.com.br/dp/ASIN?tag=TRACKING.
 * É o formato de link que a própria Amazon gera (sem encurtador). Sem tracking ID do canal: null.
 * O link do Instagram usa o tracking "ig" se houver; senão não é criado (não mistura com o WhatsApp).
 */
export async function linkAmazonDaOferta(sql: Sql, cliente: Cliente, ofertaId: string, canal: 'wa' | 'ig'): Promise<{ id: string; url: string } | null> {
  const tracking = (await trackingAmazon(sql, cliente))[canal];
  if (!tracking) return null;
  const [o] = await sql`select id, produto_id, nicho, url_produto from ofertas where cliente_id = ${cliente.clienteId} and id = ${ofertaId} and plataforma = 'amazon'`;
  if (!o) return null;
  const url = `https://www.amazon.com.br/dp/${o.produto_id}?tag=${tracking}`;
  const [existe] = await sql`select id, url_afiliado from links where cliente_id = ${cliente.clienteId} and oferta_id = ${ofertaId} and canal = ${canal} and url_afiliado = ${url}`;
  if (existe) return { id: existe.id, url: existe.url_afiliado };
  const [l] = await sql`
    insert into links (cliente_id, oferta_id, plataforma, url_origem, url_afiliado, chave_rastreio, canal, nicho, produto_id, contexto)
    values (${cliente.clienteId}, ${ofertaId}, 'amazon', ${o.url_produto}, ${url}, ${tracking}, ${canal}, ${o.nicho}, ${o.produto_id},
            ${sql.json({ origem: 'tracking_do_canal' })})
    returning id`;
  return { id: l!.id, url };
}
