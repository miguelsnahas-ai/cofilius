/**
 * Resultados do período para a aba Resultados do painel: comissão e cliques por dia, totais,
 * produtos que mais renderam e vendas recentes. Tudo vem do banco (vendas e cliques); nada é estimado.
 *
 * Regras de soma (iguais às do fechamento):
 * - comissão pendente e validada nunca somam juntas nos totais; a cancelada fica à parte;
 * - o gráfico por dia mostra a comissão não cancelada (pendente + validada), separada no detalhe;
 * - datas no fuso do cliente.
 */
import type { Sql } from '../../harness/db.ts';
import type { Cliente } from '../../db/clientes.ts';

export type FiltroPlataforma = 'shopee' | 'mercado_livre' | 'amazon' | null;

export interface DiaResultado { dia: string; pendente: string; validada: string; pedidos: number; cliques: number }

export interface Resultados {
  inicio: string;
  fim: string;
  plataforma: FiltroPlataforma;
  totais: {
    comissaoPendente: string; comissaoValidada: string; comissaoCancelada: string;
    pedidos: number; pedidosCancelados: number; cliques: number; vendido: string;
    naoAtribuidas: number;
  };
  dias: DiaResultado[];
  produtos: { plataforma: string; produtoId: string; nome: string | null; pedidos: number; comissao: string }[];
  recentes: {
    plataforma: string; pedidoId: string; nome: string | null; valor: string | null; comissao: string | null;
    situacao: string; data: string | null; atribuida: boolean;
  }[];
  /** Quando a última venda e o último clique chegaram (de qualquer origem). */
  atualizado: { vendas: string | null; cliques: string | null; extensao: string | null };
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;

export async function resultadosPeriodo(sql: Sql, cliente: Cliente, inicio: string, fim: string, plataforma: FiltroPlataforma = null): Promise<Resultados> {
  if (!DATA.test(inicio) || !DATA.test(fim)) throw new Error('Período no formato AAAA-MM-DD.');
  if (inicio > fim) throw new Error('A data inicial é depois da final.');
  const id = cliente.clienteId;
  const fuso = cliente.fusoHorario;
  const daPlataforma = (alias: string) => (plataforma ? sql`and ${sql(alias)}.plataforma = ${plataforma}` : sql``);
  const noPeriodo = sql`v.cliente_id = ${id} and (v.data_pedido at time zone ${fuso})::date between ${inicio} and ${fim} ${daPlataforma('v')}`;

  const [t] = await sql`
    select coalesce(sum(comissao) filter (where situacao = 'pendente'), 0)::numeric(12,2)::text as pendente,
           coalesce(sum(comissao) filter (where situacao = 'validada'), 0)::numeric(12,2)::text as validada,
           coalesce(sum(comissao) filter (where situacao = 'cancelada'), 0)::numeric(12,2)::text as cancelada,
           count(distinct (plataforma, pedido_id)) filter (where situacao <> 'cancelada')::int as pedidos,
           count(distinct (plataforma, pedido_id)) filter (where situacao = 'cancelada')::int as cancelados,
           coalesce(sum(valor) filter (where situacao <> 'cancelada'), 0)::numeric(12,2)::text as vendido,
           count(*) filter (where link_id is null and situacao <> 'cancelada')::int as nao_atribuidas
    from vendas v where ${noPeriodo}`;

  const dias = await sql`
    with dias as (select d::date as dia from generate_series(${inicio}::date, ${fim}::date, interval '1 day') d),
    v as (
      select (v.data_pedido at time zone ${fuso})::date as dia,
             sum(comissao) filter (where situacao = 'pendente') as pendente,
             sum(comissao) filter (where situacao = 'validada') as validada,
             count(distinct pedido_id) filter (where situacao <> 'cancelada') as pedidos
      from vendas v where ${noPeriodo} group by 1),
    c as (
      select dia, sum(cliques) as cliques from cliques k
      where k.cliente_id = ${id} and dia between ${inicio} and ${fim} ${daPlataforma('k')} group by 1)
    select to_char(dias.dia, 'YYYY-MM-DD') as dia,
           coalesce(v.pendente, 0)::numeric(12,2)::text as pendente, coalesce(v.validada, 0)::numeric(12,2)::text as validada,
           coalesce(v.pedidos, 0)::int as pedidos, coalesce(c.cliques, 0)::int as cliques
    from dias left join v on v.dia = dias.dia left join c on c.dia = dias.dia
    order by dias.dia`;

  const produtos = await sql`
    select plataforma, produto_id, max(produto_nome) as nome, count(distinct pedido_id)::int as pedidos,
           coalesce(sum(comissao), 0)::numeric(12,2)::text as comissao
    from vendas v where ${noPeriodo} and situacao <> 'cancelada'
    group by plataforma, produto_id
    order by sum(comissao) desc nulls last, count(*) desc, produto_id limit 10`;

  const recentes = await sql`
    select plataforma, pedido_id, produto_nome, valor::text, comissao::text, situacao,
           to_char(data_pedido at time zone ${fuso}, 'YYYY-MM-DD"T"HH24:MI') as data, link_id is not null as atribuida
    from vendas v where ${noPeriodo}
    order by data_pedido desc nulls last, pedido_id, produto_id limit 20`;

  const [a] = await sql`
    select (select max(atualizado_em) from vendas where cliente_id = ${id}) as vendas,
           (select max(atualizado_em) from cliques where cliente_id = ${id}) as cliques,
           (select max(criado_em) from recebimentos_extensao where cliente_id = ${id} and erro is null) as extensao`;

  const [cl] = await sql`
    select coalesce(sum(cliques), 0)::int as n from cliques k
    where k.cliente_id = ${id} and dia between ${inicio} and ${fim} ${daPlataforma('k')}`;

  return {
    inicio, fim, plataforma,
    totais: {
      comissaoPendente: t!.pendente, comissaoValidada: t!.validada, comissaoCancelada: t!.cancelada,
      pedidos: t!.pedidos, pedidosCancelados: t!.cancelados, cliques: cl!.n, vendido: t!.vendido, naoAtribuidas: t!.nao_atribuidas,
    },
    dias: dias.map((d) => ({ dia: d.dia, pendente: d.pendente, validada: d.validada, pedidos: d.pedidos, cliques: d.cliques })),
    produtos: produtos.map((p) => ({ plataforma: p.plataforma, produtoId: p.produto_id, nome: p.nome, pedidos: p.pedidos, comissao: p.comissao })),
    recentes: recentes.map((r) => ({
      plataforma: r.plataforma, pedidoId: r.pedido_id, nome: r.produto_nome, valor: r.valor, comissao: r.comissao,
      situacao: r.situacao, data: r.data, atribuida: r.atribuida,
    })),
    atualizado: {
      vendas: a!.vendas ? new Date(a!.vendas).toISOString() : null,
      cliques: a!.cliques ? new Date(a!.cliques).toISOString() : null,
      extensao: a!.extensao ? new Date(a!.extensao).toISOString() : null,
    },
  };
}
