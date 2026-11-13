/**
 * Diretrizes de curadoria por nicho (tabela `diretrizes_nicho`).
 *
 * Texto curto e versionado que o Curador lê todo dia. Regras da arquitetura:
 * - O Analista só PROPÕE; nada vale sem aprovação do operador.
 * - Aprender muda as diretrizes, nunca o código nem o prompt dos agentes.
 * - Uma diretriz aprovada por nicho por vez: aprovar uma nova substitui a anterior (que fica no histórico).
 */
import { conectarTransacao, type Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import type { Cliente } from '../../db/clientes.ts';
import { normalizar } from '../etiquetas/etiquetas.ts';

export interface Diretriz {
  id: string;
  nicho: string;
  versao: number;
  texto: string;
  situacao: 'proposta' | 'aprovada' | 'substituida' | 'descartada';
  propostaPor: string;
  criadoEm: Date;
  aprovadaEm: Date | null;
}

const TAMANHO_MAXIMO = 1000;

const paraDiretriz = (r: Record<string, any>): Diretriz => ({
  id: r.id, nicho: r.nicho, versao: r.versao, texto: r.texto, situacao: r.situacao,
  propostaPor: r.proposta_por, criadoEm: r.criado_em, aprovadaEm: r.aprovada_em,
});

function conferirNicho(cliente: Cliente, nicho: string): string {
  const slug = normalizar(nicho);
  if (!cliente.nichos.some((n) => n.slug === slug)) {
    throw new Error(`Nicho "${nicho}" não está no cadastro do cliente (${cliente.nichos.map((n) => n.slug).join(', ')}).`);
  }
  return slug;
}

/** Registra uma nova versão como proposta. */
export async function proporDiretriz(
  sql: Sql, cliente: Cliente, nicho: string, texto: string, por: 'operador' | 'analista',
): Promise<Diretriz> {
  const slug = conferirNicho(cliente, nicho);
  const limpo = texto.trim();
  if (!limpo) throw new Error('Diretriz vazia.');
  if (limpo.length > TAMANHO_MAXIMO) throw new Error(`Diretriz longa demais (máximo ${TAMANHO_MAXIMO} caracteres).`);
  return conectarTransacao(sql, 'diretrizes.propor', async (tx) => {
    const [r] = await tx`
      insert into diretrizes_nicho (cliente_id, nicho, versao, texto, proposta_por)
      values (${cliente.clienteId}, ${slug},
              (select coalesce(max(versao), 0) + 1 from diretrizes_nicho where cliente_id = ${cliente.clienteId} and nicho = ${slug}),
              ${limpo}, ${por})
      returning *`;
    log.info('diretrizes.proposta', { cliente: cliente.codigo, nicho: slug, versao: r!.versao, por });
    return paraDiretriz(r!);
  });
}

/** Aprova uma proposta; a aprovada anterior do mesmo nicho vira "substituida". */
export async function aprovarDiretriz(sql: Sql, cliente: Cliente, id: string): Promise<Diretriz> {
  return conectarTransacao(sql, 'diretrizes.aprovar', async (tx) => {
    const [d] = await tx`select * from diretrizes_nicho where id = ${id} and cliente_id = ${cliente.clienteId} for update`;
    if (!d) throw new Error(`Diretriz ${id} não encontrada para este cliente.`);
    if (d.situacao !== 'proposta') throw new Error(`Só uma proposta pode ser aprovada (esta está ${d.situacao}).`);
    await tx`update diretrizes_nicho set situacao = 'substituida'
             where cliente_id = ${cliente.clienteId} and nicho = ${d.nicho} and situacao = 'aprovada'`;
    const [r] = await tx`update diretrizes_nicho set situacao = 'aprovada', aprovada_em = now() where id = ${id} returning *`;
    log.info('diretrizes.aprovada', { cliente: cliente.codigo, nicho: d.nicho, versao: d.versao });
    return paraDiretriz(r!);
  });
}

export async function descartarDiretriz(sql: Sql, cliente: Cliente, id: string): Promise<void> {
  const r = await sql`update diretrizes_nicho set situacao = 'descartada'
                      where id = ${id} and cliente_id = ${cliente.clienteId} and situacao = 'proposta' returning id`;
  if (!r.length) throw new Error(`Proposta ${id} não encontrada para este cliente.`);
}

/** Diretrizes em vigor (aprovadas), por nicho. */
export async function diretrizesVigentes(sql: Sql, cliente: Cliente): Promise<Record<string, Diretriz>> {
  const linhas = await sql`select * from diretrizes_nicho where cliente_id = ${cliente.clienteId} and situacao = 'aprovada'`;
  return Object.fromEntries(linhas.map((l) => [l.nicho, paraDiretriz(l)]));
}

export async function listarDiretrizes(sql: Sql, cliente: Cliente, nicho?: string): Promise<Diretriz[]> {
  const linhas = nicho
    ? await sql`select * from diretrizes_nicho where cliente_id = ${cliente.clienteId} and nicho = ${normalizar(nicho)} order by nicho, versao desc`
    : await sql`select * from diretrizes_nicho where cliente_id = ${cliente.clienteId} order by nicho, versao desc`;
  return linhas.map(paraDiretriz);
}
