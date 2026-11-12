/**
 * Redator: escreve a mensagem de uma oferta e cria o rascunho na lista do dia.
 *
 * O agente recebe só título, nicho, se tem desconto, o tom do grupo e até 3 mensagens antigas com
 * mais cliques (o texto com marcadores, nunca com preço ou link). Ele devolve o texto com marcadores;
 * o rascunho é criado por criarRascunho, que preenche preço, desconto e link a partir do banco.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from '../../harness/db.ts';
import { carregarAgente, executarAgente, resolverModelo, type ContratoAgente, type ModeloIA, type PrecoModelo } from '../../harness/agentes.ts';
import type { Cliente } from '../../db/clientes.ts';
import { regrasRedator, type EntradaRedator, type SaidaRedator } from '../../agents/redator/regras.ts';
import { criarRascunho, type MensagemCriada } from './lista.ts';

const PASTA_REDATOR = join(dirname(fileURLToPath(import.meta.url)), '../../agents/redator');

/** Contrato do Redator lido de agents/redator, com o modelo resolvido pelo ambiente. */
export async function contratoRedator(
  ambiente: Record<string, string | undefined> = process.env,
): Promise<ContratoAgente<EntradaRedator, SaidaRedator>> {
  const { contrato } = await carregarAgente(PASTA_REDATOR);
  return { ...contrato, modelo: resolverModelo(contrato.modelo, ambiente), regrasSaida: regrasRedator };
}

export async function montarEntradaRedator(sql: Sql, cliente: Cliente, ofertaId: string): Promise<EntradaRedator> {
  const [o] = await sql`
    select o.titulo, o.nicho, o.desconto_pct, c.tom_grupo
    from ofertas o join clientes c on c.cliente_id = o.cliente_id
    where o.cliente_id = ${cliente.clienteId} and o.id = ${ofertaId}`;
  if (!o) throw new Error(`Oferta ${ofertaId} não encontrada para este cliente.`);
  // Exemplos: mensagens já enviadas, do mesmo nicho primeiro, com mais cliques.
  const exemplos = await sql<{ texto_modelo: string }[]>`
    select m.texto_modelo
    from mensagens m
    left join ofertas om on om.cliente_id = m.cliente_id and om.id = m.oferta_id
    left join (select link_id, sum(cliques) as total from cliques where cliente_id = ${cliente.clienteId} group by link_id) k
      on k.link_id = m.link_id
    where m.cliente_id = ${cliente.clienteId} and m.estado in ('enviada', 'medida')
    order by (om.nicho is not distinct from ${o.nicho}) desc, coalesce(k.total, 0) desc, m.enviada_em desc
    limit 3`;
  return {
    oferta: {
      titulo: o.titulo.slice(0, 300),
      nicho: o.nicho ?? 'geral',
      tem_desconto: o.desconto_pct !== null && Number(o.desconto_pct) > 0,
    },
    tom: (o.tom_grupo ?? '').slice(0, 500),
    exemplos: exemplos.map((e) => e.texto_modelo.slice(0, 1000)),
  };
}

export interface ResultadoRedacao {
  mensagem: MensagemCriada;
  textoModelo: string;
  tentativas: number;
  versaoPrompt: string;
}

export async function redigirMensagem(
  sql: Sql,
  p: {
    cliente: Cliente;
    ofertaId: string;
    modelo: ModeloIA;
    contrato?: ContratoAgente<EntradaRedator, SaidaRedator>;
    precos?: Record<string, PrecoModelo>;
    dataLista?: string;
    tarefaId?: string;
  },
): Promise<ResultadoRedacao> {
  const contrato = p.contrato ?? (await contratoRedator());
  const entrada = await montarEntradaRedator(sql, p.cliente, p.ofertaId);
  const r = await executarAgente(sql, {
    contrato, clienteId: p.cliente.clienteId, entrada, modelo: p.modelo, precos: p.precos, tarefaId: p.tarefaId,
  });
  const mensagem = await criarRascunho(sql, {
    cliente: p.cliente, ofertaId: p.ofertaId, textoModelo: r.saida.texto_modelo, dataLista: p.dataLista,
  });
  return { mensagem, textoModelo: r.saida.texto_modelo, tentativas: r.tentativas, versaoPrompt: r.versaoPrompt };
}
