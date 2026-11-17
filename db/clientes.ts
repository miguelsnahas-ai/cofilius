import type { Sql } from '../harness/db.ts';

export interface Nicho {
  slug: string;
  nome?: string;
  palavras_chave?: string[];
}

export interface Cliente {
  clienteId: string;
  codigo: string;
  nome: string;
  nichos: Nicho[];
  fusoHorario: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Busca o cliente pelo código curto ("c1") ou pelo cliente_id. */
export async function buscarCliente(sql: Sql, codigoOuId: string): Promise<Cliente> {
  const linhas = UUID.test(codigoOuId)
    ? await sql`select cliente_id, codigo, nome, nichos, fuso_horario, ativo from clientes where cliente_id = ${codigoOuId}`
    : await sql`select cliente_id, codigo, nome, nichos, fuso_horario, ativo from clientes where codigo = ${codigoOuId}`;
  const c = linhas[0];
  if (!c) throw new Error(`Cliente "${codigoOuId}" não encontrado.`);
  if (c.ativo === false) throw new Error(`Cliente "${codigoOuId}" está inativo.`);
  return {
    clienteId: c.cliente_id,
    codigo: c.codigo,
    nome: c.nome,
    nichos: Array.isArray(c.nichos) ? (c.nichos as Nicho[]) : [],
    fusoHorario: c.fuso_horario,
  };
}

export function acharNicho(cliente: Cliente, slug: string): Nicho | undefined {
  return cliente.nichos.find((n) => n.slug === slug);
}
