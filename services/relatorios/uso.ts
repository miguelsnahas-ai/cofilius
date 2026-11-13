/**
 * Registro de uso: ações do operador, minutos estimados e custo por cliente.
 *
 * Minutos: ações do mesmo cliente com até 10 minutos de intervalo formam uma sessão; cada sessão conta
 * do primeiro ao último clique, mais 1 minuto (o tempo de ler antes do primeiro clique).
 * É uma estimativa: tempo olhando a tela sem clicar não aparece.
 */
import type { Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';

export const INTERVALO_SESSAO_MIN = 10;

export async function registrarAcao(
  sql: Sql, clienteId: string, acao: string, origem: 'painel' | 'cli', operador?: string, em?: Date,
): Promise<void> {
  try {
    await sql`insert into acoes_operador (cliente_id, acao, origem, operador, em)
              values (${clienteId}, ${acao}, ${origem}, ${operador ?? null}, ${em ?? new Date()})`;
  } catch (erro) {
    // Registrar uso nunca impede o trabalho.
    log.warn('uso.registro_falhou', { acao, erro: (erro as Error).message });
  }
}

/** Minutos estimados a partir dos horários das ações (ordenados ou não). */
export function minutosEstimados(horarios: Date[]): number {
  const t = horarios.map((d) => d.getTime()).sort((a, b) => a - b);
  if (!t.length) return 0;
  let total = 0;
  let inicio = t[0]!;
  let anterior = t[0]!;
  for (const x of t.slice(1)) {
    if (x - anterior > INTERVALO_SESSAO_MIN * 60_000) {
      total += (anterior - inicio) / 60_000 + 1;
      inicio = x;
    }
    anterior = x;
  }
  total += (anterior - inicio) / 60_000 + 1;
  return Math.round(total);
}

export interface UsoCliente {
  codigo: string;
  nome: string;
  mensagensEnviadas: number;
  acoes: number;
  minutosOperador: number;
  diasComAcao: number;
  minutosPorDia: number;
  chamadasIa: number;
  custoIaUsd: string;
}

/** Uso de [inicio, fim] (AAAA-MM-DD, inclusivo), por cliente. */
export async function usoPorCliente(sql: Sql, inicio: string, fim: string): Promise<UsoCliente[]> {
  const clientes = await sql`select cliente_id, codigo, nome, fuso_horario from clientes order by codigo`;
  const saida: UsoCliente[] = [];
  for (const c of clientes) {
    const fuso = c.fuso_horario;
    const acoes = await sql<{ em: Date; dia: string }[]>`
      select em, (em at time zone ${fuso})::date::text as dia from acoes_operador
      where cliente_id = ${c.cliente_id} and (em at time zone ${fuso})::date between ${inicio} and ${fim}`;
    const porDia = new Map<string, Date[]>();
    for (const a of acoes) porDia.set(a.dia, [...(porDia.get(a.dia) ?? []), a.em]);
    const minutos = [...porDia.values()].reduce((s, h) => s + minutosEstimados(h), 0);
    const [m] = await sql`
      select count(*)::int as n from mensagens
      where cliente_id = ${c.cliente_id} and estado in ('enviada', 'medida')
        and (enviada_em at time zone ${fuso})::date between ${inicio} and ${fim}`;
    const [ia] = await sql`
      select count(*)::int as n, coalesce(sum(custo_usd), 0)::numeric(12,4)::text as custo from execucoes_agente
      where cliente_id = ${c.cliente_id} and (criado_em at time zone ${fuso})::date between ${inicio} and ${fim}`;
    saida.push({
      codigo: c.codigo, nome: c.nome, mensagensEnviadas: m!.n, acoes: acoes.length, minutosOperador: minutos,
      diasComAcao: porDia.size, minutosPorDia: porDia.size ? Math.round(minutos / porDia.size) : 0,
      chamadasIa: ia!.n, custoIaUsd: ia!.custo,
    });
  }
  return saida;
}
