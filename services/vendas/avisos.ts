/**
 * Avisos de cancelamento: vendas que o painel já conhecia (pendentes ou validadas) e que a plataforma
 * passou a cancelada. Gravados pela importação (eventos_vendas); ficam no Dia até o operador dar ciência.
 */
import type { Sql } from '../../harness/db.ts';
import type { Cliente } from '../../db/clientes.ts';

export interface AvisoCancelamento {
  id: string;
  plataforma: string;
  pedidoId: string;
  produtoNome: string | null;
  /** Situação antes de cair (pendente ou validada). */
  de: string;
  /** Comissão que se esperava (R$, texto decimal). */
  comissao: string | null;
  dataPedido: string | null;
  canceladaEm: string;
  /** Postagem que gerou a venda, quando atribuída. */
  postagem: { titulo: string | null; enviadaEm: string | null } | null;
}

/** Avisos ainda não vistos, mais recentes primeiro (até 50). */
export async function avisosCancelamento(sql: Sql, cliente: Cliente): Promise<AvisoCancelamento[]> {
  const linhas = await sql`
    select e.id, e.plataforma, e.pedido_id, e.produto_nome, e.de, e.comissao::text as comissao, e.data_pedido, e.criado_em,
           e.link_id, o.titulo, m.enviada_em
    from eventos_vendas e
    left join links l on l.cliente_id = e.cliente_id and l.id = e.link_id
    left join ofertas o on o.cliente_id = l.cliente_id and o.id = l.oferta_id
    left join lateral (
      select enviada_em from mensagens m where m.cliente_id = e.cliente_id and m.link_id = e.link_id and m.enviada_em is not null
      order by m.enviada_em limit 1) m on true
    where e.cliente_id = ${cliente.clienteId} and e.para = 'cancelada' and e.visto_em is null
    order by e.criado_em desc, e.pedido_id limit 50`;
  return linhas.map((e) => ({
    id: e.id, plataforma: e.plataforma, pedidoId: e.pedido_id, produtoNome: e.produto_nome, de: e.de, comissao: e.comissao,
    dataPedido: e.data_pedido ? new Date(e.data_pedido).toISOString() : null,
    canceladaEm: new Date(e.criado_em).toISOString(),
    postagem: e.link_id ? { titulo: e.titulo ?? null, enviadaEm: e.enviada_em ? new Date(e.enviada_em).toISOString() : null } : null,
  }));
}

/** Dá ciência: todos os não vistos do cliente (ou só os ids informados). Devolve quantos. */
export async function marcarAvisosVistos(sql: Sql, cliente: Cliente, ids?: string[]): Promise<number> {
  const r = ids?.length
    ? await sql`update eventos_vendas set visto_em = now() where cliente_id = ${cliente.clienteId} and visto_em is null and id in ${sql(ids)}`
    : await sql`update eventos_vendas set visto_em = now() where cliente_id = ${cliente.clienteId} and visto_em is null`;
  return r.count;
}

/**
 * Cancelamentos que chegaram no período mas são de pedidos feitos antes dele (não aparecem nos números
 * da semana, que contam pela data do pedido). Para o fechamento avisar o que caiu.
 */
export async function canceladosDePedidosAnteriores(
  sql: Sql, cliente: Cliente, inicio: string, fim: string,
): Promise<{ pedidos: number; comissao: number }> {
  const fuso = cliente.fusoHorario;
  const [r] = await sql`
    select count(distinct (plataforma, pedido_id))::int as pedidos, coalesce(sum(comissao), 0)::float8 as comissao
    from eventos_vendas
    where cliente_id = ${cliente.clienteId} and para = 'cancelada'
      and (criado_em at time zone ${fuso})::date between ${inicio} and ${fim}
      and (data_pedido at time zone ${fuso})::date < ${inicio}`;
  return { pedidos: r!.pedidos, comissao: Math.round(r!.comissao * 100) / 100 };
}
