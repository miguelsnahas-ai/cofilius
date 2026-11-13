/**
 * Desempenho por postagem: quantos cliques e vendas cada mensagem enviada gerou, pelo link dela.
 * Tudo calculado em código a partir do banco (cliques e vendas ligados ao link da mensagem).
 *
 * Usado em dois lugares:
 * - na lista do dia, ao lado de cada mensagem enviada;
 * - na entrada do Curador ("desempenho_recente"), para ele aprender o que funciona no grupo.
 *
 * Observação: na Shopee o clique e a venda chegam ligados à postagem pelos Sub_ids. Na Amazon e no
 * Mercado Livre a venda casa por etiqueta e produto, e os cliques não chegam por postagem.
 */
import type { Sql } from '../../harness/db.ts';
import type { Cliente } from '../../db/clientes.ts';
import { FAIXAS_PRECO } from './indicadores.ts';

export interface DesempenhoPostagem {
  mensagemId: string;
  enviadaEm: string | null;
  titulo: string | null;
  nicho: string | null;
  plataforma: string | null;
  preco: number | null;
  /** O link da postagem tem rastreio por postagem (Shopee): cliques valem. */
  medivel: boolean;
  cliques: number;
  pedidos: number;
  cancelados: number;
  comissaoPendente: number;
  comissaoValidada: number;
}

const arred = (n: number) => Math.round(n * 100) / 100;

/** Desempenho das mensagens enviadas: pelos ids ou pelo período de envio (AAAA-MM-DD, fuso do cliente). */
export async function desempenhoPostagens(
  sql: Sql, cliente: Cliente, filtro: { ids: string[] } | { de: string; ate: string },
): Promise<DesempenhoPostagem[]> {
  if ('ids' in filtro && !filtro.ids.length) return [];
  const onde = 'ids' in filtro
    ? sql`m.id in ${sql(filtro.ids)}`
    : sql`(m.enviada_em at time zone ${cliente.fusoHorario})::date between ${filtro.de} and ${filtro.ate}`;
  const linhas = await sql`
    select m.id, m.enviada_em, o.titulo, o.nicho, coalesce(l.plataforma, o.plataforma) as plataforma, o.preco::float8 as preco,
           l.plataforma = 'shopee' as medivel,
           coalesce((select sum(c.cliques) from cliques c where c.cliente_id = m.cliente_id and c.link_id = m.link_id), 0)::int as cliques,
           (select count(distinct v.pedido_id) from vendas v
             where v.cliente_id = m.cliente_id and v.link_id = m.link_id and v.situacao <> 'cancelada')::int as pedidos,
           (select count(distinct v.pedido_id) from vendas v
             where v.cliente_id = m.cliente_id and v.link_id = m.link_id and v.situacao = 'cancelada')::int as cancelados,
           coalesce((select sum(v.comissao) from vendas v
             where v.cliente_id = m.cliente_id and v.link_id = m.link_id and v.situacao = 'pendente'), 0)::float8 as pendente,
           coalesce((select sum(v.comissao) from vendas v
             where v.cliente_id = m.cliente_id and v.link_id = m.link_id and v.situacao = 'validada'), 0)::float8 as validada
    from mensagens m
    left join ofertas o on o.cliente_id = m.cliente_id and o.id = m.oferta_id
    left join links l on l.cliente_id = m.cliente_id and l.id = m.link_id
    where m.cliente_id = ${cliente.clienteId} and m.estado in ('enviada', 'medida') and ${onde}
    order by m.enviada_em, m.id`;
  return linhas.map((l) => ({
    mensagemId: l.id, enviadaEm: l.enviada_em ? new Date(l.enviada_em).toISOString() : null,
    titulo: l.titulo, nicho: l.nicho, plataforma: l.plataforma, preco: l.preco, medivel: !!l.medivel,
    cliques: l.cliques, pedidos: l.pedidos, cancelados: l.cancelados,
    comissaoPendente: arred(l.pendente), comissaoValidada: arred(l.validada),
  }));
}

// ---------------------------------------------------------------------------
// Resumo para o Curador
// ---------------------------------------------------------------------------

export const DIAS_APRENDIZADO = 28;
/** Abaixo disso, o resumo vai marcado como amostra pequena (o prompt manda pesar pouco). */
export const AMOSTRA_MINIMA = 10;

interface Grupo { grupo: string; postagens: number; cliques_por_postagem: number; pedidos: number; comissao: number }

export interface DesempenhoRecente {
  periodo: { de: string; ate: string };
  postagens: number;
  amostra_pequena: boolean;
  por_nicho: Grupo[];
  por_faixa_preco: Grupo[];
  melhores: { titulo: string; nicho: string | null; preco: number | null; cliques: number; pedidos: number; comissao: number }[];
  sem_resultado: { titulo: string; nicho: string | null; preco: number | null; cliques: number }[];
}

function diaAntes(data: string, dias: number): string {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

function agrupar(posts: DesempenhoPostagem[], chave: (p: DesempenhoPostagem) => string): Grupo[] {
  const m = new Map<string, { n: number; cliques: number; pedidos: number; comissao: number }>();
  for (const p of posts) {
    const k = chave(p);
    const g = m.get(k) ?? { n: 0, cliques: 0, pedidos: 0, comissao: 0 };
    g.n++; g.cliques += p.cliques; g.pedidos += p.pedidos; g.comissao += p.comissaoPendente + p.comissaoValidada;
    m.set(k, g);
  }
  return [...m.entries()]
    .map(([grupo, g]) => ({ grupo, postagens: g.n, cliques_por_postagem: arred(g.cliques / g.n), pedidos: g.pedidos, comissao: arred(g.comissao) }))
    .sort((a, b) => b.comissao - a.comissao || b.cliques_por_postagem - a.cliques_por_postagem || a.grupo.localeCompare(b.grupo));
}

function faixaDe(preco: number | null): string {
  if (preco == null) return 'sem preço';
  return (FAIXAS_PRECO.find(([de, ate]) => preco >= de && preco < ate) ?? FAIXAS_PRECO.at(-1)!)[2];
}

/**
 * O que funcionou no grupo nos últimos 28 dias antes de `data` (o dia de hoje não entra: ainda não mediu).
 * Só postagens medíveis (rastreio por postagem). null se não houver nenhuma.
 */
export async function desempenhoParaCurador(sql: Sql, cliente: Cliente, data: string): Promise<DesempenhoRecente | null> {
  const de = diaAntes(data, DIAS_APRENDIZADO);
  const ate = diaAntes(data, 1);
  const posts = (await desempenhoPostagens(sql, cliente, { de, ate })).filter((p) => p.medivel && p.titulo);
  if (!posts.length) return null;
  const comissao = (p: DesempenhoPostagem) => arred(p.comissaoPendente + p.comissaoValidada);
  const ordenados = [...posts].sort((a, b) => comissao(b) - comissao(a) || b.cliques - a.cliques || a.mensagemId.localeCompare(b.mensagemId));
  return {
    periodo: { de, ate },
    postagens: posts.length,
    amostra_pequena: posts.length < AMOSTRA_MINIMA,
    por_nicho: agrupar(posts, (p) => p.nicho ?? 'sem nicho'),
    por_faixa_preco: agrupar(posts, (p) => faixaDe(p.preco)),
    melhores: ordenados.filter((p) => p.pedidos > 0).slice(0, 5).map((p) => ({
      titulo: p.titulo!.slice(0, 120), nicho: p.nicho, preco: p.preco, cliques: p.cliques, pedidos: p.pedidos, comissao: comissao(p),
    })),
    sem_resultado: ordenados.filter((p) => p.pedidos === 0).sort((a, b) => a.cliques - b.cliques).slice(0, 5).map((p) => ({
      titulo: p.titulo!.slice(0, 120), nicho: p.nicho, preco: p.preco, cliques: p.cliques,
    })),
  };
}
