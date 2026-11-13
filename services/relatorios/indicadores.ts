/**
 * Indicadores do período, calculados em código a partir do banco (nunca pela IA).
 *
 * Base: mensagens enviadas no período, com os cliques e as vendas (não canceladas) ligados ao link de cada uma.
 * Cada linha tem uma referência estável ("nicho:casa", "horario:08", "post:1a2b3c4d"...) que o Analista
 * usa para apontar o dado que sustenta cada leitura.
 */
import type { Sql } from '../../harness/db.ts';
import type { Cliente } from '../../db/clientes.ts';

export type Dimensao = 'nicho' | 'horario' | 'plataforma' | 'faixa_preco' | 'postagem';

export interface Indicador {
  ref: string;
  dimensao: Dimensao;
  rotulo: string;
  mensagens: number;
  cliques: number;
  pedidos: number;
  /** Comissão pendente + validada, em R$ (cancelada fora). */
  comissao: number;
}

export interface Indicadores {
  inicio: string;
  fim: string;
  linhas: Indicador[];
  totais: { mensagens: number; cliques: number; pedidos: number; comissao: number };
}

export const FAIXAS_PRECO: [number, number, string][] = [
  [0, 50, 'até R$ 50'], [50, 100, 'R$ 50 a R$ 100'], [100, 200, 'R$ 100 a R$ 200'], [200, Infinity, 'acima de R$ 200'],
];
export const MAX_POSTAGENS = 30;

function faixa(preco: number): [string, string] {
  const f = FAIXAS_PRECO.find(([de, ate]) => preco >= de && preco < ate) ?? FAIXAS_PRECO.at(-1)!;
  return [`preco:${f[0]}-${f[1] === Infinity ? 'mais' : f[1]}`, f[2]];
}

const arred = (n: number) => Math.round(n * 100) / 100;

export async function calcularIndicadores(sql: Sql, cliente: Cliente, inicio: string, fim: string): Promise<Indicadores> {
  const fuso = cliente.fusoHorario;
  const base = await sql`
    select m.id, o.nicho, o.plataforma, o.preco::float8 as preco, o.titulo,
           extract(hour from m.enviada_em at time zone ${fuso})::int as hora,
           coalesce((select sum(c.cliques) from cliques c
                     where c.cliente_id = m.cliente_id and c.link_id = m.link_id and c.dia between ${inicio} and ${fim}), 0)::int as cliques,
           (select count(*) from vendas v
             where v.cliente_id = m.cliente_id and v.link_id = m.link_id and v.situacao <> 'cancelada')::int as pedidos,
           coalesce((select sum(v.comissao) from vendas v
                     where v.cliente_id = m.cliente_id and v.link_id = m.link_id and v.situacao <> 'cancelada'), 0)::float8 as comissao
    from mensagens m
    join ofertas o on o.cliente_id = m.cliente_id and o.id = m.oferta_id
    where m.cliente_id = ${cliente.clienteId} and m.estado in ('enviada', 'medida')
      and (m.enviada_em at time zone ${fuso})::date between ${inicio} and ${fim}
    order by m.enviada_em`;

  const grupos = new Map<string, Indicador>();
  const somar = (ref: string, dimensao: Dimensao, rotulo: string, b: (typeof base)[number]) => {
    const g = grupos.get(ref) ?? { ref, dimensao, rotulo, mensagens: 0, cliques: 0, pedidos: 0, comissao: 0 };
    g.mensagens++;
    g.cliques += b.cliques;
    g.pedidos += b.pedidos;
    g.comissao = arred(g.comissao + b.comissao);
    grupos.set(ref, g);
  };
  for (const b of base) {
    somar(`nicho:${b.nicho ?? 'sem'}`, 'nicho', b.nicho ?? 'sem nicho', b);
    somar(`horario:${String(b.hora).padStart(2, '0')}`, 'horario', `${String(b.hora).padStart(2, '0')}h`, b);
    somar(`plataforma:${b.plataforma}`, 'plataforma', b.plataforma, b);
    const [ref, rotulo] = faixa(b.preco);
    somar(ref, 'faixa_preco', rotulo, b);
  }
  const postagens = base
    .map((b) => ({ ref: `post:${String(b.id).slice(0, 8)}`, dimensao: 'postagem' as const, rotulo: String(b.titulo).slice(0, 120),
      mensagens: 1, cliques: b.cliques, pedidos: b.pedidos, comissao: arred(b.comissao) }))
    .sort((a, b) => b.comissao - a.comissao || b.cliques - a.cliques)
    .slice(0, MAX_POSTAGENS);

  return {
    inicio, fim,
    linhas: [...grupos.values()].sort((a, b) => a.ref.localeCompare(b.ref)).concat(postagens),
    totais: {
      mensagens: base.length,
      cliques: base.reduce((s, b) => s + b.cliques, 0),
      pedidos: base.reduce((s, b) => s + b.pedidos, 0),
      comissao: arred(base.reduce((s, b) => s + b.comissao, 0)),
    },
  };
}
