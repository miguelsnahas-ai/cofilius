/**
 * Fila de tarefas (tabela `tarefas`) — o Agendador.
 *
 * - Cada etapa da esteira vira uma tarefa com horário, por cliente.
 * - Vários processos podem consumir a fila ao mesmo tempo: cada tarefa é pega por um só (SKIP LOCKED).
 * - Falhou: nova tentativa com espera crescente (1, 2, 4 min...). `max_tentativas` (padrão 3) é o número
 *   de NOVAS tentativas depois da primeira; esgotadas, a tarefa fica "falhou" com o erro gravado.
 * - Uma tarefa que falha não segura as outras: cada cliente e cada etapa seguem independentes.
 * - Tarefa presa em "executando" (processo caiu) volta para a fila depois de um tempo.
 * - Tarefas "operador.*" são trabalho humano (ex.: gerar um link no painel a pedido do afiliado): a fila
 *   automática não as pega; o operador as conclui no painel ou no terminal.
 */
import type { Sql } from './db.ts';
import { log } from './log.ts';

export interface Tarefa {
  id: string;
  clienteId: string;
  tipo: string;
  entrada: Record<string, unknown>;
  tentativas: number;
  maxTentativas: number;
  agendadaPara: Date;
  chave: string | null;
}

export interface TarefaNova {
  clienteId: string;
  tipo: string;
  entrada?: Record<string, unknown>;
  agendadaPara?: Date;
  maxTentativas?: number;
  /** Evita agendar a mesma etapa duas vezes (ex.: "lista.validar:2026-11-12"). */
  chave?: string;
}

export const ESPERA_BASE_MS = 60_000;
export const MINUTOS_PRESA = 15;

const paraTarefa = (r: Record<string, any>): Tarefa => ({
  id: r.id, clienteId: r.cliente_id, tipo: r.tipo, entrada: r.entrada ?? {}, tentativas: r.tentativas,
  maxTentativas: r.max_tentativas, agendadaPara: r.agendada_para, chave: r.chave,
});

/** Enfileira. Com `chave` repetida, não cria outra e devolve { criada: false }. */
export async function enfileirar(sql: Sql, t: TarefaNova): Promise<{ id: string; criada: boolean }> {
  const [r] = await sql`
    insert into tarefas (cliente_id, tipo, entrada, agendada_para, max_tentativas, chave)
    values (${t.clienteId}, ${t.tipo}, ${sql.json((t.entrada ?? {}) as never)}, ${t.agendadaPara ?? new Date()},
            ${t.maxTentativas ?? 3}, ${t.chave ?? null})
    on conflict (cliente_id, chave) where chave is not null do nothing
    returning id`;
  if (r) return { id: r.id, criada: true };
  const [existente] = await sql`select id from tarefas where cliente_id = ${t.clienteId} and chave = ${t.chave!}`;
  return { id: existente!.id, criada: false };
}

/** Pega a próxima tarefa vencida e a marca como "executando". */
export async function pegarProxima(sql: Sql, agora = new Date()): Promise<Tarefa | null> {
  const [r] = await sql`
    update tarefas set estado = 'executando', tentativas = tentativas + 1, iniciada_em = ${agora}, erro = null
    where id = (
      select id from tarefas
      where estado = 'pendente' and agendada_para <= ${agora} and tipo not like 'operador.%'
      order by agendada_para, criado_em
      for update skip locked
      limit 1
    )
    returning *`;
  return r ? paraTarefa(r) : null;
}

export async function concluir(sql: Sql, id: string, resultado: unknown, agora = new Date()): Promise<void> {
  await sql`
    update tarefas set estado = 'concluida', resultado = ${sql.json((resultado ?? null) as never)}, concluida_em = ${agora}
    where id = ${id}`;
}

/** Registra a falha: agenda nova tentativa ou, esgotadas, marca "falhou". */
export async function falhar(sql: Sql, t: Tarefa, erro: unknown, agora = new Date()): Promise<'nova_tentativa' | 'falhou'> {
  const msg = erro instanceof Error ? erro.message : String(erro);
  if (t.tentativas <= t.maxTentativas) {
    const proxima = new Date(agora.getTime() + ESPERA_BASE_MS * 2 ** (t.tentativas - 1));
    await sql`update tarefas set estado = 'pendente', agendada_para = ${proxima}, erro = ${msg} where id = ${t.id}`;
    log.warn('fila.nova_tentativa', { tarefa: t.id, tipo: t.tipo, tentativa: t.tentativas, proxima: proxima.toISOString(), erro: msg });
    return 'nova_tentativa';
  }
  await sql`update tarefas set estado = 'falhou', erro = ${msg}, concluida_em = ${agora} where id = ${t.id}`;
  // TODO(aviso): quando houver canal (WhatsApp do operador), avisar aqui. Por enquanto, log de erro e `fila-status`.
  log.error('fila.falhou', { tarefa: t.id, tipo: t.tipo, cliente: t.clienteId, tentativas: t.tentativas, erro: msg });
  return 'falhou';
}

/** Devolve à fila tarefas presas em "executando" há mais de MINUTOS_PRESA. */
export async function devolverPresas(sql: Sql, agora = new Date()): Promise<number> {
  const limite = new Date(agora.getTime() - MINUTOS_PRESA * 60_000);
  const r = await sql`
    update tarefas set estado = 'pendente', erro = 'devolvida à fila: processo parou no meio'
    where estado = 'executando' and iniciada_em < ${limite}
    returning id`;
  if (r.length) log.warn('fila.presas_devolvidas', { quantidade: r.length });
  return r.length;
}

export type Executor = (tarefa: Tarefa) => Promise<unknown>;

export interface ResumoFila {
  executadas: number;
  concluidas: number;
  novasTentativas: number;
  falharam: number;
}

/** Processa as tarefas vencidas, uma a uma, até esvaziar ou chegar ao limite. */
export async function processarFila(
  sql: Sql,
  executores: Record<string, Executor>,
  opcoes: { agora?: () => Date; limite?: number } = {},
): Promise<ResumoFila> {
  const agora = opcoes.agora ?? (() => new Date());
  const resumo: ResumoFila = { executadas: 0, concluidas: 0, novasTentativas: 0, falharam: 0 };
  await devolverPresas(sql, agora());
  while (resumo.executadas < (opcoes.limite ?? 100)) {
    const t = await pegarProxima(sql, agora());
    if (!t) break;
    resumo.executadas++;
    const executor = executores[t.tipo];
    try {
      if (!executor) throw new Error(`tipo de tarefa sem executor: ${t.tipo}`);
      log.info('fila.executando', { tarefa: t.id, tipo: t.tipo, tentativa: t.tentativas });
      await concluir(sql, t.id, await executor(t), agora());
      resumo.concluidas++;
    } catch (erro) {
      // Tipo sem executor não melhora repetindo.
      if (!executor) t.tentativas = t.maxTentativas + 1;
      const r = await falhar(sql, t, erro, agora());
      if (r === 'falhou') resumo.falharam++;
      else resumo.novasTentativas++;
    }
  }
  return resumo;
}

export interface LinhaStatus {
  id: string;
  cliente: string;
  tipo: string;
  estado: string;
  tentativas: number;
  agendadaPara: Date;
  erro: string | null;
  /** Etapa que não rodou por falta de algo (ex.: IA não configurada). */
  pulada: string | null;
}

export async function statusFila(sql: Sql, desde: Date): Promise<LinhaStatus[]> {
  const r = await sql`
    select t.id, c.codigo, t.tipo, t.estado, t.tentativas, t.agendada_para, t.erro, t.resultado ->> 'pulada' as pulada
    from tarefas t join clientes c on c.cliente_id = t.cliente_id
    where t.criado_em >= ${desde} or t.estado in ('pendente', 'executando', 'falhou')
    order by t.agendada_para`;
  return r.map((x) => ({ id: x.id, cliente: x.codigo, tipo: x.tipo, estado: x.estado, tentativas: x.tentativas, agendadaPara: x.agendada_para, erro: x.erro, pulada: x.pulada }));
}
