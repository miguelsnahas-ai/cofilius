/**
 * Curador: escolhe as ofertas do dia de um cliente.
 *
 * Entrada do agente: candidatas do dia (sem produtos enviados nos últimos 7 dias), diretrizes aprovadas
 * por nicho e títulos enviados recentemente. Saída: IDs em ordem, com um motivo cada.
 * Regra garantida em código: nunca devolve oferta fora da lista de candidatas.
 * A escolha é gravada na própria oferta (posição, motivo, versão do prompt).
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarTransacao, type Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import { carregarContrato, executarAgente, type ContratoAgente, type ModeloIA, type PrecoModelo } from '../../harness/agentes.ts';
import type { Cliente } from '../../db/clientes.ts';
import { regrasCurador, type EntradaCurador, type SaidaCurador } from '../../agents/curador/regras.ts';
import { DIAS_SEM_REPETIR } from '../lista/lista.ts';
import { diretrizesVigentes } from './diretrizes.ts';
import { desempenhoParaCurador } from '../relatorios/desempenho.ts';

const PASTA = join(dirname(fileURLToPath(import.meta.url)), '../../agents/curador');
export const QUANTIDADE_PADRAO = 5;
export const MAX_CANDIDATAS = 40;

export function contratoCurador(ambiente: Record<string, string | undefined> = process.env) {
  return carregarContrato<EntradaCurador, SaidaCurador>(PASTA, regrasCurador, ambiente);
}

const num = (v: string | null) => (v === null ? null : Number(v));

export async function montarEntradaCurador(
  sql: Sql, cliente: Cliente, data: string, quantidade: number,
): Promise<EntradaCurador> {
  const desde = new Date(new Date(`${data}T12:00:00Z`).getTime() - DIAS_SEM_REPETIR * 86_400_000);
  const enviados = await sql<{ plataforma: string; produto_id: string; titulo: string }[]>`
    select distinct o.plataforma, o.produto_id, o.titulo
    from mensagens m join ofertas o on o.cliente_id = m.cliente_id and o.id = m.oferta_id
    where m.cliente_id = ${cliente.clienteId} and m.estado in ('enviada', 'medida') and m.enviada_em > ${desde}`;
  const jaEnviado = new Set(enviados.map((e) => `${e.plataforma}:${e.produto_id}`));
  // Candidatas: ofertas coletadas no dia; as de maior comissão primeiro, se houver muitas.
  const linhas = await sql`
    select id, plataforma, produto_id, nicho, titulo, preco::text, desconto_pct::text, comissao_pct::text,
           comissao_valor::text, vendas, avaliacao::text
    from ofertas
    where cliente_id = ${cliente.clienteId} and data_coleta = ${data}
    order by comissao_valor desc nulls last, vendas desc nulls last, criado_em, produto_id`;
  const candidatas = linhas
    .filter((l) => !jaEnviado.has(`${l.plataforma}:${l.produto_id}`))
    .slice(0, MAX_CANDIDATAS)
    .map((l) => ({
      id: l.id as string, plataforma: l.plataforma as string, nicho: l.nicho as string | null,
      titulo: (l.titulo as string).slice(0, 200), preco: Number(l.preco), desconto_pct: num(l.desconto_pct),
      comissao_pct: num(l.comissao_pct), comissao_valor: num(l.comissao_valor), vendas: l.vendas as number | null,
      avaliacao: num(l.avaliacao),
    }));
  const vigentes = await diretrizesVigentes(sql, cliente);
  return {
    data,
    quantidade,
    candidatas,
    diretrizes: Object.fromEntries(Object.entries(vigentes).map(([n, d]) => [n, d.texto])),
    enviados_recentes: enviados.map((e) => e.titulo.slice(0, 200)).slice(0, 50),
    desempenho_recente: await desempenhoParaCurador(sql, cliente, data),
  };
}

export interface ResultadoCuradoria {
  data: string;
  candidatas: number;
  escolhas: { ofertaId: string; posicao: number; motivo: string; titulo: string }[];
}

export async function curarDia(
  sql: Sql,
  p: {
    cliente: Cliente;
    data: string;
    modelo: ModeloIA;
    contrato?: ContratoAgente<EntradaCurador, SaidaCurador>;
    quantidade?: number;
    precos?: Record<string, PrecoModelo>;
    tarefaId?: string;
  },
): Promise<ResultadoCuradoria> {
  const [c] = await sql`select limite_mensagens_dia from clientes where cliente_id = ${p.cliente.clienteId}`;
  const quantidade = Math.min(p.quantidade ?? QUANTIDADE_PADRAO, c!.limite_mensagens_dia);
  const entrada = await montarEntradaCurador(sql, p.cliente, p.data, quantidade);
  if (!entrada.candidatas.length) {
    log.warn('curadoria.sem_candidatas', { cliente: p.cliente.codigo, data: p.data });
    return { data: p.data, candidatas: 0, escolhas: [] };
  }
  const contrato = p.contrato ?? (await contratoCurador());
  const r = await executarAgente(sql, {
    contrato, clienteId: p.cliente.clienteId, entrada, modelo: p.modelo, precos: p.precos, tarefaId: p.tarefaId,
  });
  const titulos = new Map(entrada.candidatas.map((x) => [x.id, x.titulo]));
  const escolhas = r.saida.escolhas.map((e, i) => ({ ofertaId: e.oferta_id, posicao: i + 1, motivo: e.motivo, titulo: titulos.get(e.oferta_id)! }));
  await conectarTransacao(sql, 'curadoria.gravar', async (tx) => {
    await tx`update ofertas set selecionada_em = null, curadoria = null
             where cliente_id = ${p.cliente.clienteId} and data_coleta = ${p.data} and selecionada_em is not null`;
    for (const e of escolhas) {
      await tx`update ofertas set selecionada_em = now(),
                 curadoria = ${tx.json({ posicao: e.posicao, motivo: e.motivo, versao_prompt: r.versaoPrompt } as never)}
               where cliente_id = ${p.cliente.clienteId} and id = ${e.ofertaId}`;
    }
  });
  log.info('curadoria.feita', { cliente: p.cliente.codigo, data: p.data, escolhidas: escolhas.length });
  return { data: p.data, candidatas: entrada.candidatas.length, escolhas };
}

export interface Selecionada {
  ofertaId: string;
  posicao: number;
  motivo: string;
  titulo: string;
  plataforma: string;
  linkId: string | null;
  mensagemId: string | null;
}

/** Ofertas escolhidas no dia, em ordem, com link e mensagem (se já existirem). */
export async function selecionadasDoDia(sql: Sql, cliente: Cliente, data: string): Promise<Selecionada[]> {
  const linhas = await sql`
    select o.id, (o.curadoria ->> 'posicao')::int as posicao, o.curadoria ->> 'motivo' as motivo, o.titulo, o.plataforma,
           (select l.id from links l where l.cliente_id = o.cliente_id and l.oferta_id = o.id order by l.criado_em desc limit 1) as link_id,
           (select m.id from mensagens m where m.cliente_id = o.cliente_id and m.oferta_id = o.id
              and m.data_lista = ${data} and m.estado <> 'descartada' limit 1) as mensagem_id
    from ofertas o
    where o.cliente_id = ${cliente.clienteId} and o.data_coleta = ${data} and o.selecionada_em is not null
    order by 2`;
  return linhas.map((l) => ({
    ofertaId: l.id, posicao: l.posicao, motivo: l.motivo, titulo: l.titulo, plataforma: l.plataforma,
    linkId: l.link_id, mensagemId: l.mensagem_id,
  }));
}
