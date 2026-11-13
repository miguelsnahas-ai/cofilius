/**
 * A esteira diária (docs/arquitetura.md, "Um dia na esteira"): as etapas que já existem em código,
 * com horário no fuso de cada cliente, e o que cada tipo de tarefa executa.
 *
 * Etapas ainda sem código (Curador, Redator, Disparador...) entram aqui quando existirem.
 * Uma etapa que depende de algo que o cliente não tem (ex.: Open API da Shopee) é pulada e informada.
 */
import type { Sql } from './db.ts';
import { log } from './log.ts';
import { enfileirar, type Executor } from './fila.ts';
import { buscarCliente, type Cliente } from '../db/clientes.ts';
import { horarioLocalParaData } from '../services/etiquetas/etiquetas.ts';
import { coletarOfertasShopee } from '../services/ofertas/coletarOfertasShopee.ts';
import { validarDia } from '../services/lista/lista.ts';
import { redigirSelecionadas } from '../services/lista/redator.ts';
import { curarDia, selecionadasDoDia } from '../services/curadoria/curador.ts';
import { analisarPeriodo } from '../services/relatorios/analista.ts';
import { montarFechamento } from '../services/relatorios/fechamento.ts';
import { resumoPeriodo } from '../services/vendas/atribuicao.ts';
import { marcarMedidas } from '../services/lista/medicao.ts';
import { gerarLinkShopee } from '../services/links/gerarLinkShopee.ts';
import type { ClienteShopee } from '../services/shopee/client.ts';
import type { ModeloIA, PrecoModelo } from './agentes.ts';

export interface Etapa {
  tipo: string;
  /** HH:MM no fuso do cliente. */
  horario: string;
  /** Uma tarefa por nicho do cliente. */
  porNicho?: boolean;
  /** Pré-requisito do cliente. */
  precisa?: 'shopee_open_api';
  /** Só neste dia da semana (0 = domingo). */
  diaSemana?: number;
  descricao: string;
}

export const ETAPAS: Etapa[] = [
  { tipo: 'lista.medir', horario: '05:00', descricao: 'Marca como medidas as mensagens enviadas há mais de 7 dias' },
  { tipo: 'ofertas.shopee.coletar', horario: '05:30', porNicho: true, precisa: 'shopee_open_api', descricao: 'Conector de ofertas (Shopee, via Open API)' },
  { tipo: 'curadoria.curar', horario: '06:00', descricao: 'Curador escolhe as ofertas do dia' },
  { tipo: 'links.shopee.gerar', horario: '06:15', precisa: 'shopee_open_api', descricao: 'Links com rastreio das escolhidas (Shopee, via Open API)' },
  { tipo: 'redacao.redigir', horario: '06:30', descricao: 'Redator escreve as mensagens das escolhidas com link' },
  { tipo: 'lista.validar', horario: '06:45', descricao: 'Validadores da lista do dia' },
  { tipo: 'analise.semanal', horario: '20:00', diaSemana: 0, descricao: 'Fechamento da semana e Analista (propõe diretrizes)' },
];

/** Segunda a domingo da semana que termina na data informada (um domingo). */
export function semanaAte(domingo: string): { inicio: string; fim: string } {
  const fim = new Date(`${domingo}T12:00:00Z`);
  const inicio = new Date(fim.getTime() - 6 * 86_400_000);
  return { inicio: inicio.toISOString().slice(0, 10), fim: domingo };
}

export interface DepsEsteira {
  sql: Sql;
  /** Monta o cliente da Shopee de um cliente (lê a credencial cifrada). */
  shopeeDoCliente: (cliente: Cliente) => Promise<Pick<ClienteShopee, 'buscarOfertas' | 'gerarLinkCurto'>>;
  /** Modelo de IA dos agentes (Curador, Redator). Sem ele, as etapas de agente falham com aviso. */
  modelo?: () => ModeloIA;
  precos?: Record<string, PrecoModelo>;
}

export function criarExecutores(deps: DepsEsteira): Record<string, Executor> {
  const { sql } = deps;
  return {
    'ofertas.shopee.coletar': async (t) => {
      const cliente = await buscarCliente(sql, t.clienteId);
      const nicho = String(t.entrada.nicho ?? '');
      if (!nicho) throw new Error('tarefa sem nicho');
      // A coleta pertence ao dia da tarefa (não ao relógio de quem executa, que pode ser outro dia em atraso).
      const quando = t.entrada.dataLista
        ? horarioLocalParaData(`${String(t.entrada.dataLista)} 12:00`, cliente.fusoHorario)
        : undefined;
      const r = await coletarOfertasShopee({ sql, shopee: await deps.shopeeDoCliente(cliente) }, {
        cliente, nicho, limite: Number(t.entrada.limite ?? 30), quando,
      });
      return { dataColeta: r.dataColeta, total: r.ofertas.length, novas: r.novas, descartadas: r.descartadas };
    },
    'curadoria.curar': async (t) => {
      const cliente = await buscarCliente(sql, t.clienteId);
      if (!deps.modelo) throw new Error('modelo de IA não configurado');
      const r = await curarDia(sql, { cliente, data: String(t.entrada.dataLista), modelo: deps.modelo(), precos: deps.precos, tarefaId: t.id });
      return { candidatas: r.candidatas, escolhidas: r.escolhas.length };
    },
    'links.shopee.gerar': async (t) => {
      const cliente = await buscarCliente(sql, t.clienteId);
      const shopee = await deps.shopeeDoCliente(cliente);
      const pendentes = (await selecionadasDoDia(sql, cliente, String(t.entrada.dataLista)))
        .filter((s) => s.plataforma === 'shopee' && !s.linkId);
      let gerados = 0;
      for (const s of pendentes) {
        await gerarLinkShopee({ sql, shopee }, { cliente, ofertaId: s.ofertaId, contexto: { origem: 'esteira', tarefa: t.id } });
        gerados++;
      }
      return { gerados };
    },
    'redacao.redigir': async (t) => {
      const cliente = await buscarCliente(sql, t.clienteId);
      if (!deps.modelo) throw new Error('modelo de IA não configurado');
      const r = await redigirSelecionadas(sql, { cliente, data: String(t.entrada.dataLista), modelo: deps.modelo(), precos: deps.precos, tarefaId: t.id });
      if (r.falhas.length && !r.redigidas.length) throw new Error(`nenhuma mensagem redigida: ${r.falhas.map((f) => f.erro).join('; ')}`);
      return { redigidas: r.redigidas.length, semLink: r.semLink.length, jaTinhamMensagem: r.jaTinhamMensagem, falhas: r.falhas };
    },
    'analise.semanal': async (t) => {
      const cliente = await buscarCliente(sql, t.clienteId);
      if (!deps.modelo) throw new Error('modelo de IA não configurado');
      const { inicio, fim } = semanaAte(String(t.entrada.dataLista));
      const analise = await analisarPeriodo(sql, { cliente, inicio, fim, modelo: deps.modelo(), precos: deps.precos, tarefaId: t.id });
      const resumo = await resumoPeriodo(sql, cliente, inicio, fim);
      // O texto fica no resultado da tarefa até existir o Disparador (WhatsApp).
      return {
        inicio, fim, semDados: analise.semDados,
        propostas: analise.propostas.map((d) => ({ id: d.id, nicho: d.nicho, versao: d.versao })),
        fechamento: montarFechamento(cliente.nome, resumo, analise),
      };
    },
    'lista.medir': async (t) => ({ medidas: await marcarMedidas(sql, t.clienteId) }),
    'lista.validar': async (t) => {
      const cliente = await buscarCliente(sql, t.clienteId);
      const r = await validarDia(sql, cliente, String(t.entrada.dataLista));
      return { validadas: r.filter((x) => x.ok).length, barradas: r.filter((x) => !x.ok).length };
    },
  };
}

export interface Agendamento {
  cliente: string;
  tipo: string;
  nicho?: string;
  horario: Date;
  situacao: 'agendada' | 'ja_existia' | 'pulada';
  motivo?: string;
}

/** Agenda as etapas de um dia (AAAA-MM-DD) para todos os clientes ativos. Rodar de novo não duplica. */
export async function agendarDia(sql: Sql, data: string): Promise<Agendamento[]> {
  const clientes = await sql`
    select c.cliente_id, c.codigo,
           exists (select 1 from credenciais k where k.cliente_id = c.cliente_id and k.plataforma = 'shopee' and k.nome = 'open_api') as shopee_api
    from clientes c where c.ativo order by c.codigo`;
  const saida: Agendamento[] = [];
  for (const c of clientes) {
    const cliente = await buscarCliente(sql, c.cliente_id);
    const diaDaSemana = new Date(`${data}T12:00:00Z`).getUTCDay();
    for (const etapa of ETAPAS) {
      if (etapa.diaSemana !== undefined && etapa.diaSemana !== diaDaSemana) continue;
      const horario = horarioLocalParaData(`${data} ${etapa.horario}`, cliente.fusoHorario);
      if (etapa.precisa === 'shopee_open_api' && !c.shopee_api) {
        saida.push({ cliente: c.codigo, tipo: etapa.tipo, horario, situacao: 'pulada', motivo: 'sem credencial da Open API da Shopee (usar modo manual)' });
        continue;
      }
      const nichos = etapa.porNicho ? cliente.nichos.map((n) => n.slug) : [undefined];
      if (etapa.porNicho && !nichos.length) {
        saida.push({ cliente: c.codigo, tipo: etapa.tipo, horario, situacao: 'pulada', motivo: 'cliente sem nichos cadastrados' });
        continue;
      }
      for (const nicho of nichos) {
        const r = await enfileirar(sql, {
          clienteId: cliente.clienteId,
          tipo: etapa.tipo,
          agendadaPara: horario,
          entrada: { dataLista: data, ...(nicho ? { nicho } : {}) },
          chave: [etapa.tipo, data, nicho].filter(Boolean).join(':'),
        });
        saida.push({ cliente: c.codigo, tipo: etapa.tipo, nicho, horario, situacao: r.criada ? 'agendada' : 'ja_existia' });
      }
    }
  }
  log.info('esteira.dia_agendado', { data, agendadas: saida.filter((s) => s.situacao === 'agendada').length });
  return saida;
}
