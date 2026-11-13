/**
 * Analista: fecha o ciclo de aprendizado.
 * Lê os indicadores do período (calculados em código) e devolve:
 * - propostas de diretriz por nicho (gravadas como "proposta"; só valem com aprovação do operador);
 * - 3 leituras, cada uma ligada às linhas de indicador que a sustentam (os números vêm do banco).
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import { carregarContrato, executarAgente, type ContratoAgente, type ModeloIA, type PrecoModelo } from '../../harness/agentes.ts';
import type { Cliente } from '../../db/clientes.ts';
import { regrasAnalista, type EntradaAnalista, type SaidaAnalista } from '../../agents/analista/regras.ts';
import { diretrizesVigentes, proporDiretriz, type Diretriz } from '../curadoria/diretrizes.ts';
import { calcularIndicadores, type Indicador, type Indicadores } from './indicadores.ts';

const PASTA = join(dirname(fileURLToPath(import.meta.url)), '../../agents/analista');

export function contratoAnalista(ambiente: Record<string, string | undefined> = process.env) {
  return carregarContrato<EntradaAnalista, SaidaAnalista>(PASTA, regrasAnalista, ambiente);
}

export interface Leitura {
  texto: string;
  evidencias: Indicador[];
}

export interface ResultadoAnalise {
  indicadores: Indicadores;
  leituras: Leitura[];
  propostas: Diretriz[];
  /** true quando não houve mensagem enviada no período (o modelo nem é chamado). */
  semDados: boolean;
}

export async function analisarPeriodo(
  sql: Sql,
  p: {
    cliente: Cliente;
    inicio: string;
    fim: string;
    modelo: ModeloIA;
    contrato?: ContratoAgente<EntradaAnalista, SaidaAnalista>;
    precos?: Record<string, PrecoModelo>;
    tarefaId?: string;
  },
): Promise<ResultadoAnalise> {
  const indicadores = await calcularIndicadores(sql, p.cliente, p.inicio, p.fim);
  if (!indicadores.totais.mensagens) {
    log.warn('analise.sem_dados', { cliente: p.cliente.codigo, inicio: p.inicio, fim: p.fim });
    return { indicadores, leituras: [], propostas: [], semDados: true };
  }
  const vigentes = await diretrizesVigentes(sql, p.cliente);
  const entrada: EntradaAnalista = {
    periodo: { inicio: p.inicio, fim: p.fim },
    nichos: p.cliente.nichos.map((n) => n.slug),
    diretrizes_atuais: Object.fromEntries(Object.entries(vigentes).map(([n, d]) => [n, d.texto])),
    indicadores: indicadores.linhas,
    totais: indicadores.totais,
  };
  const contrato = p.contrato ?? (await contratoAnalista());
  const r = await executarAgente(sql, {
    contrato, clienteId: p.cliente.clienteId, entrada, modelo: p.modelo, precos: p.precos, tarefaId: p.tarefaId,
  });
  const porRef = new Map(indicadores.linhas.map((l) => [l.ref, l]));
  const leituras = r.saida.insights.map((i) => ({ texto: i.texto, evidencias: i.refs.map((ref) => porRef.get(ref)!) }));
  const propostas: Diretriz[] = [];
  for (const d of r.saida.diretrizes) {
    // Proposta igual à diretriz em vigor não vira nova versão.
    if (vigentes[d.nicho]?.texto.trim() === d.texto.trim()) continue;
    propostas.push(await proporDiretriz(sql, p.cliente, d.nicho, d.texto, 'analista'));
  }
  log.info('analise.feita', { cliente: p.cliente.codigo, inicio: p.inicio, fim: p.fim, propostas: propostas.length });
  return { indicadores, leituras, propostas, semDados: false };
}
