/**
 * Sincronizador de ganhos · núcleo (independe do formato de cada plataforma).
 *
 * Cada relatório (Shopee, Mercado Livre, Amazon) é convertido para VendaNormalizada por um importador
 * próprio. Daqui para a frente o caminho é o mesmo:
 *
 * - Shopee: a chave de rastreio (os 5 sub_ids) identifica a postagem. Casa com o link pela chave.
 *   Se o produto vendido for outro (o comprador clicou num e levou outro), a venda continua atribuída
 *   à postagem e fica marcada como produto_diferente.
 * - Mercado Livre e Amazon: a etiqueta identifica canal e nicho, não a postagem. Casa pela etiqueta
 *   E pelo produto, com o link mais recente criado antes do pedido.
 * - Sem par: a venda é gravada como NÃO ATRIBUÍDA (link_id nulo). Nunca some.
 * - A situação da comissão (pendente, validada, cancelada) é atualizada a cada importação.
 */
import { conectarTransacao, type Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import type { Cliente } from '../../db/clientes.ts';

export type Plataforma = 'shopee' | 'mercado_livre' | 'amazon';
export type Situacao = 'pendente' | 'validada' | 'cancelada';

export interface VendaNormalizada {
  plataforma: Plataforma;
  pedidoId: string;
  produtoId: string;
  produtoNome?: string | null;
  quantidade?: number;
  /** Valores em texto decimal ("29.90"). */
  valor?: string | null;
  comissao?: string | null;
  situacao: Situacao;
  /** Shopee: sub_ids unidos por "-" (use chaveShopee). Mercado Livre: etiqueta. Amazon: tracking ID. */
  chaveRastreio: string | null;
  dataPedido: Date | null;
  bruto?: Record<string, unknown>;
}

/** Monta a chave da Shopee a partir dos 5 sub_ids do relatório (vazios viram ""). */
export function chaveShopee(subIds: (string | null | undefined)[]): string | null {
  const partes = [0, 1, 2, 3, 4].map((i) => (subIds[i] ?? '').trim());
  return partes.some(Boolean) ? partes.join('-') : null;
}

export interface Atribuicao {
  linkId: string | null;
  por: 'chave_rastreio' | 'etiqueta_produto' | null;
  produtoDiferente: boolean;
}

export async function acharLink(sql: Sql, clienteId: string, v: VendaNormalizada): Promise<Atribuicao> {
  const nada: Atribuicao = { linkId: null, por: null, produtoDiferente: false };
  if (!v.chaveRastreio) return nada;
  if (v.plataforma === 'shopee') {
    const [l] = await sql`
      select id, produto_id from links
      where cliente_id = ${clienteId} and plataforma = 'shopee' and chave_rastreio = ${v.chaveRastreio}
      order by criado_em desc limit 1`;
    if (!l) return nada;
    return { linkId: l.id, por: 'chave_rastreio', produtoDiferente: !!l.produto_id && l.produto_id !== v.produtoId };
  }
  const [l] = v.dataPedido
    ? await sql`
        select id from links
        where cliente_id = ${clienteId} and plataforma = ${v.plataforma} and chave_rastreio = ${v.chaveRastreio}
          and produto_id = ${v.produtoId} and criado_em <= ${v.dataPedido}
        order by criado_em desc limit 1`
    : await sql`
        select id from links
        where cliente_id = ${clienteId} and plataforma = ${v.plataforma} and chave_rastreio = ${v.chaveRastreio}
          and produto_id = ${v.produtoId}
        order by criado_em desc limit 1`;
  return l ? { linkId: l.id, por: 'etiqueta_produto', produtoDiferente: false } : nada;
}

export interface ResultadoImportacaoVendas {
  total: number;
  novas: number;
  atualizadas: number;
  atribuidas: number;
  naoAtribuidas: number;
  mudancasSituacao: { pedidoId: string; produtoId: string; de: Situacao; para: Situacao }[];
}

function validarVenda(v: VendaNormalizada): void {
  if (!v.pedidoId?.trim() || !v.produtoId?.trim()) throw new Error(`Venda sem pedido ou produto: ${JSON.stringify(v)}`);
  if (!['pendente', 'validada', 'cancelada'].includes(v.situacao)) throw new Error(`Situação inválida: ${v.situacao}`);
  for (const [campo, valor] of [['valor', v.valor], ['comissao', v.comissao]] as const) {
    if (valor != null && !(Number(valor) >= 0)) throw new Error(`${campo} inválido no pedido ${v.pedidoId}: ${valor}`);
  }
}

export async function importarVendas(sql: Sql, cliente: Cliente, vendas: VendaNormalizada[]): Promise<ResultadoImportacaoVendas> {
  vendas.forEach(validarVenda);
  const r: ResultadoImportacaoVendas = { total: vendas.length, novas: 0, atualizadas: 0, atribuidas: 0, naoAtribuidas: 0, mudancasSituacao: [] };
  await conectarTransacao(sql, 'vendas.importar', async (tx) => {
    Object.assign(r, { novas: 0, atualizadas: 0, atribuidas: 0, naoAtribuidas: 0, mudancasSituacao: [] });
    for (const v of vendas) {
      const a = await acharLink(tx as unknown as Sql, cliente.clienteId, v);
      const [antes] = await tx`
        select situacao from vendas
        where cliente_id = ${cliente.clienteId} and plataforma = ${v.plataforma} and pedido_id = ${v.pedidoId} and produto_id = ${v.produtoId}`;
      await tx`
        insert into vendas (cliente_id, plataforma, pedido_id, produto_id, produto_nome, quantidade, valor, comissao, situacao,
                            chave_rastreio, link_id, atribuida_por, produto_diferente, data_pedido, dados_brutos)
        values (${cliente.clienteId}, ${v.plataforma}, ${v.pedidoId}, ${v.produtoId}, ${v.produtoNome ?? null}, ${v.quantidade ?? 1},
                ${v.valor ?? null}, ${v.comissao ?? null}, ${v.situacao}, ${v.chaveRastreio}, ${a.linkId}, ${a.por},
                ${a.produtoDiferente}, ${v.dataPedido}, ${tx.json((v.bruto ?? {}) as never)})
        on conflict (cliente_id, plataforma, pedido_id, produto_id) do update set
          produto_nome = coalesce(excluded.produto_nome, vendas.produto_nome),
          quantidade = excluded.quantidade,
          valor = coalesce(excluded.valor, vendas.valor),
          comissao = coalesce(excluded.comissao, vendas.comissao),
          situacao = excluded.situacao,
          chave_rastreio = coalesce(excluded.chave_rastreio, vendas.chave_rastreio),
          -- uma venda já atribuída continua atribuída; uma não atribuída ganha nova chance a cada importação
          link_id = coalesce(vendas.link_id, excluded.link_id),
          atribuida_por = case when vendas.link_id is not null then vendas.atribuida_por else excluded.atribuida_por end,
          produto_diferente = case when vendas.link_id is not null then vendas.produto_diferente else excluded.produto_diferente end,
          data_pedido = coalesce(excluded.data_pedido, vendas.data_pedido),
          dados_brutos = vendas.dados_brutos || excluded.dados_brutos`;
      const [depois] = await tx`
        select link_id from vendas
        where cliente_id = ${cliente.clienteId} and plataforma = ${v.plataforma} and pedido_id = ${v.pedidoId} and produto_id = ${v.produtoId}`;
      if (antes) {
        r.atualizadas++;
        if (antes.situacao !== v.situacao) r.mudancasSituacao.push({ pedidoId: v.pedidoId, produtoId: v.produtoId, de: antes.situacao, para: v.situacao });
      } else r.novas++;
      if (depois!.link_id) r.atribuidas++;
      else r.naoAtribuidas++;
    }
  });
  log.info('vendas.importadas', { cliente: cliente.codigo, ...r, mudancasSituacao: r.mudancasSituacao.length });
  return r;
}

export interface CliquesNormalizados {
  plataforma: Plataforma;
  chaveRastreio: string;
  /** AAAA-MM-DD */
  dia: string;
  cliques: number;
}

/** Grava cliques por chave e dia. Na Shopee a chave aponta para um link; nas outras, para canal e nicho. */
export async function registrarCliques(sql: Sql, cliente: Cliente, linhas: CliquesNormalizados[]): Promise<number> {
  for (const c of linhas) {
    if (!Number.isInteger(c.cliques) || c.cliques < 0) throw new Error(`Cliques inválidos: ${c.cliques}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.dia)) throw new Error(`Dia inválido: ${c.dia}`);
  }
  await conectarTransacao(sql, 'cliques.registrar', async (tx) => {
    for (const c of linhas) {
      const [l] = c.plataforma === 'shopee'
        ? await tx`select id from links where cliente_id = ${cliente.clienteId} and plataforma = 'shopee'
                   and chave_rastreio = ${c.chaveRastreio} order by criado_em desc limit 1`
        : [];
      await tx`
        insert into cliques (cliente_id, plataforma, link_id, chave_rastreio, dia, cliques, origem)
        values (${cliente.clienteId}, ${c.plataforma}, ${l?.id ?? null}, ${c.chaveRastreio}, ${c.dia}, ${c.cliques}, 'plataforma')
        on conflict (cliente_id, plataforma, chave_rastreio, dia, origem) do update set
          cliques = excluded.cliques, link_id = coalesce(cliques.link_id, excluded.link_id)`;
    }
  });
  return linhas.length;
}

// ---------------------------------------------------------------------------
// Resumo do período (base do fechamento semanal)
// ---------------------------------------------------------------------------

export interface LinhaResumo {
  plataforma: string;
  situacao: Situacao;
  pedidos: number;
  valor: string;
  comissao: string;
}

export interface ResumoPeriodo {
  inicio: string;
  fim: string;
  porPlataformaESituacao: LinhaResumo[];
  /** Comissão separada: pendente e validada nunca somam juntas. Cancelada fica à parte. */
  comissao: { pendente: string; validada: string; cancelada: string };
  naoAtribuidas: { pedidos: number; comissao: string };
  cliques: number;
  melhoresPostagens: { linkId: string; chaveRastreio: string; titulo: string | null; pedidos: number; comissao: string }[];
}

/** Resumo de [inicio, fim], datas AAAA-MM-DD inclusivas, no fuso do cliente. */
export async function resumoPeriodo(sql: Sql, cliente: Cliente, inicio: string, fim: string): Promise<ResumoPeriodo> {
  const id = cliente.clienteId;
  const fuso = cliente.fusoHorario;
  const noPeriodo = sql`v.cliente_id = ${id} and (v.data_pedido at time zone ${fuso})::date between ${inicio} and ${fim}`;
  const porPS = await sql`
    select v.plataforma, v.situacao, count(*)::int as pedidos,
           coalesce(sum(v.valor), 0)::numeric(12,2)::text as valor, coalesce(sum(v.comissao), 0)::numeric(12,2)::text as comissao
    from vendas v where ${noPeriodo}
    group by 1, 2 order by 1, 2`;
  const [com] = await sql`
    select coalesce(sum(comissao) filter (where situacao = 'pendente'), 0)::numeric(12,2)::text as pendente,
           coalesce(sum(comissao) filter (where situacao = 'validada'), 0)::numeric(12,2)::text as validada,
           coalesce(sum(comissao) filter (where situacao = 'cancelada'), 0)::numeric(12,2)::text as cancelada
    from vendas v where ${noPeriodo}`;
  const [na] = await sql`
    select count(*)::int as pedidos, coalesce(sum(comissao) filter (where situacao <> 'cancelada'), 0)::numeric(12,2)::text as comissao
    from vendas v where ${noPeriodo} and v.link_id is null`;
  const [cl] = await sql`
    select coalesce(sum(cliques), 0)::int as n from cliques
    where cliente_id = ${id} and dia between ${inicio} and ${fim}`;
  const melhores = await sql`
    select l.id, l.chave_rastreio, o.titulo, count(*)::int as pedidos,
           coalesce(sum(v.comissao), 0)::numeric(12,2)::text as comissao
    from vendas v
    join links l on l.cliente_id = v.cliente_id and l.id = v.link_id
    left join ofertas o on o.cliente_id = l.cliente_id and o.id = l.oferta_id
    where ${noPeriodo} and v.situacao <> 'cancelada'
    group by l.id, l.chave_rastreio, o.titulo
    order by sum(v.comissao) desc nulls last limit 5`;
  return {
    inicio, fim,
    porPlataformaESituacao: porPS.map((p) => ({ plataforma: p.plataforma, situacao: p.situacao, pedidos: p.pedidos, valor: p.valor, comissao: p.comissao })),
    comissao: { pendente: com!.pendente, validada: com!.validada, cancelada: com!.cancelada },
    naoAtribuidas: { pedidos: na!.pedidos, comissao: na!.comissao },
    cliques: cl!.n,
    melhoresPostagens: melhores.map((m) => ({ linkId: m.id, chaveRastreio: m.chave_rastreio, titulo: m.titulo, pedidos: m.pedidos, comissao: m.comissao })),
  };
}
