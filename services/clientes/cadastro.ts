/**
 * Cadastro de clientes e nichos (Fase 2: operação para vários clientes).
 * O código curto do cliente ("c1", "ana") entra nos sub_ids da Shopee: não muda depois de criado.
 */
import type { Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import { normalizar } from '../etiquetas/etiquetas.ts';
import type { Nicho } from '../../db/clientes.ts';

export interface DadosCliente {
  nome?: string;
  /** WhatsApp com DDI e DDD, só números (ex.: 5511999998888). */
  whatsapp?: string | null;
  tomGrupo?: string | null;
  /** HH:MM */
  horarioEnvio?: string | null;
  limiteMensagensDia?: number;
  fusoHorario?: string;
}

export interface ClienteCadastrado {
  clienteId: string;
  codigo: string;
  nome: string;
  whatsapp: string | null;
  tomGrupo: string | null;
  horarioEnvio: string | null;
  limiteMensagensDia: number;
  fusoHorario: string;
  ativo: boolean;
  nichos: Nicho[];
}

const paraCliente = (r: Record<string, any>): ClienteCadastrado => ({
  clienteId: r.cliente_id, codigo: r.codigo, nome: r.nome, whatsapp: r.whatsapp, tomGrupo: r.tom_grupo,
  horarioEnvio: r.horario_envio ? String(r.horario_envio).slice(0, 5) : null, limiteMensagensDia: r.limite_mensagens_dia,
  fusoHorario: r.fuso_horario, ativo: r.ativo, nichos: r.nichos ?? [],
});

export function normalizarWhatsapp(numero: string): string {
  const digitos = numero.replace(/\D/g, '');
  const completo = digitos.length === 10 || digitos.length === 11 ? `55${digitos}` : digitos;
  if (!/^\d{12,15}$/.test(completo)) throw new Error(`WhatsApp inválido: "${numero}" (use DDI + DDD + número, ex.: 5511999998888)`);
  return completo;
}

function conferir(d: DadosCliente): Record<string, unknown> {
  const campos: Record<string, unknown> = {};
  if (d.nome !== undefined) {
    if (!d.nome.trim()) throw new Error('Nome vazio.');
    campos.nome = d.nome.trim();
  }
  if (d.whatsapp !== undefined) campos.whatsapp = d.whatsapp ? normalizarWhatsapp(d.whatsapp) : null;
  if (d.tomGrupo !== undefined) campos.tom_grupo = d.tomGrupo?.trim() ? d.tomGrupo.trim().slice(0, 500) : null;
  if (d.horarioEnvio !== undefined) {
    if (d.horarioEnvio && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.horarioEnvio)) throw new Error(`Horário inválido: "${d.horarioEnvio}" (use HH:MM)`);
    campos.horario_envio = d.horarioEnvio || null;
  }
  if (d.limiteMensagensDia !== undefined) {
    if (!Number.isInteger(d.limiteMensagensDia) || d.limiteMensagensDia < 1 || d.limiteMensagensDia > 100) throw new Error('Limite por dia deve ser de 1 a 100.');
    campos.limite_mensagens_dia = d.limiteMensagensDia;
  }
  if (d.fusoHorario !== undefined) {
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: d.fusoHorario }); } catch { throw new Error(`Fuso horário desconhecido: ${d.fusoHorario}`); }
    campos.fuso_horario = d.fusoHorario;
  }
  return campos;
}

export async function criarCliente(sql: Sql, codigo: string, dados: DadosCliente & { nome: string }): Promise<ClienteCadastrado> {
  if (!/^[a-z0-9]{1,12}$/.test(codigo)) throw new Error('Código do cliente: de 1 a 12 letras minúsculas ou números (vai nos links de rastreio).');
  const campos = conferir(dados);
  try {
    const [r] = await sql`insert into clientes ${sql({ codigo, ...campos } as never)} returning *`;
    log.info('clientes.criado', { codigo });
    return paraCliente(r!);
  } catch (erro) {
    if ((erro as { code?: string }).code === '23505') throw new Error(`Já existe um cliente com o código "${codigo}".`);
    throw erro;
  }
}

export async function atualizarCliente(sql: Sql, codigo: string, dados: DadosCliente): Promise<ClienteCadastrado> {
  const campos = conferir(dados);
  if (!Object.keys(campos).length) throw new Error('Nada para atualizar.');
  const [r] = await sql`update clientes set ${sql(campos as never)} where codigo = ${codigo} returning *`;
  if (!r) throw new Error(`Cliente "${codigo}" não encontrado.`);
  return paraCliente(r);
}

export async function definirAtivo(sql: Sql, codigo: string, ativo: boolean): Promise<void> {
  const r = await sql`update clientes set ativo = ${ativo} where codigo = ${codigo} returning 1`;
  if (!r.length) throw new Error(`Cliente "${codigo}" não encontrado.`);
  log.info(ativo ? 'clientes.ativado' : 'clientes.pausado', { codigo });
}

export async function listarCadastro(sql: Sql, incluirInativos = true): Promise<ClienteCadastrado[]> {
  const r = incluirInativos
    ? await sql`select * from clientes order by codigo`
    : await sql`select * from clientes where ativo order by codigo`;
  return r.map(paraCliente);
}

/** Cria ou substitui um nicho (slug normalizado) com nome e palavras-chave para a coleta. */
export async function salvarNicho(sql: Sql, codigo: string, nicho: { nome: string; palavrasChave: string[]; slug?: string }): Promise<Nicho[]> {
  const slug = normalizar(nicho.slug ?? nicho.nome);
  if (!slug) throw new Error('Nome de nicho inválido.');
  const palavras = [...new Set(nicho.palavrasChave.map((p) => p.trim()).filter(Boolean))];
  if (!palavras.length) throw new Error('Informe ao menos uma palavra-chave para a coleta de ofertas.');
  return sql.begin(async (tx) => {
    const [c] = await tx`select nichos from clientes where codigo = ${codigo} for update`;
    if (!c) throw new Error(`Cliente "${codigo}" não encontrado.`);
    const atuais = (c.nichos as Nicho[]).filter((n) => n.slug !== slug);
    const novos = [...atuais, { slug, nome: nicho.nome.trim(), palavras_chave: palavras }];
    await tx`update clientes set nichos = ${tx.json(novos as never)} where codigo = ${codigo}`;
    return novos;
  });
}

export async function removerNicho(sql: Sql, codigo: string, slug: string): Promise<Nicho[]> {
  return sql.begin(async (tx) => {
    const [c] = await tx`select nichos from clientes where codigo = ${codigo} for update`;
    if (!c) throw new Error(`Cliente "${codigo}" não encontrado.`);
    const atuais = c.nichos as Nicho[];
    const novos = atuais.filter((n) => n.slug !== normalizar(slug));
    if (novos.length === atuais.length) throw new Error(`Nicho "${slug}" não existe para este cliente.`);
    await tx`update clientes set nichos = ${tx.json(novos as never)} where codigo = ${codigo}`;
    return novos;
  });
}
