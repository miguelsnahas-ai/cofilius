/** Conformidade de um cliente: texto de identificação e a lista de conferência (o que ela já fez). */
import type { Sql } from '../../harness/db.ts';
import type { Cliente } from '../../db/clientes.ts';
import { IDENTIFICACAO_PADRAO, lerConformidade, REGRAS, VERIFICADO_EM } from './regras.ts';

export async function conformidadeDoCliente(sql: Sql, cliente: Cliente) {
  const [c] = await sql`select conformidade from clientes where cliente_id = ${cliente.clienteId}`;
  const conf = lerConformidade(c?.conformidade);
  const regras = REGRAS.map((r) => ({ ...r, feitoEm: r.tipo === 'checklist' ? conf.checklist[r.id] ?? null : null }));
  return {
    identificacao: conf.identificacao,
    verificadoEm: VERIFICADO_EM,
    regras,
    pendentes: regras.filter((r) => r.tipo === 'checklist' && !r.feitoEm).length,
  };
}

/** Texto de identificação: curto, visível, sem link nem número solto que confunda com preço. */
export async function definirIdentificacao(sql: Sql, cliente: Cliente, texto: string): Promise<string> {
  const t = texto.trim();
  if (t.length < 3 || t.length > 40) throw new Error('A identificação precisa ter de 3 a 40 caracteres (ex.: #publi, Publicidade, Link de afiliado).');
  if (!/(publi|publicidade|afiliad|parceria|patrocinad)/i.test(t)) {
    throw new Error('Use um termo que o público entenda como publicidade: "#publi", "Publicidade" ou "Link de afiliado".');
  }
  await sql`update clientes set conformidade = jsonb_set(conformidade, '{identificacao}', to_jsonb(${t}::text)) where cliente_id = ${cliente.clienteId}`;
  return t;
}

export async function marcarItem(sql: Sql, cliente: Cliente, item: string, feito: boolean): Promise<void> {
  const regra = REGRAS.find((r) => r.id === item && r.tipo === 'checklist');
  if (!regra) throw new Error('Item da lista de conferência desconhecido.');
  if (feito) {
    await sql`update clientes set conformidade = jsonb_set(conformidade, ${['checklist', item]}::text[], to_jsonb(${new Date().toISOString()}::text), true)
              where cliente_id = ${cliente.clienteId}`;
  } else {
    await sql`update clientes set conformidade = conformidade #- ${['checklist', item]}::text[] where cliente_id = ${cliente.clienteId}`;
  }
}

export { IDENTIFICACAO_PADRAO };
