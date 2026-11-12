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
import type { ClienteShopee } from '../services/shopee/client.ts';

export interface Etapa {
  tipo: string;
  /** HH:MM no fuso do cliente. */
  horario: string;
  /** Uma tarefa por nicho do cliente. */
  porNicho?: boolean;
  /** Pré-requisito do cliente. */
  precisa?: 'shopee_open_api';
  descricao: string;
}

export const ETAPAS: Etapa[] = [
  { tipo: 'ofertas.shopee.coletar', horario: '05:30', porNicho: true, precisa: 'shopee_open_api', descricao: 'Conector de ofertas (Shopee, via Open API)' },
  { tipo: 'lista.validar', horario: '06:45', descricao: 'Validadores da lista do dia' },
];

export interface DepsEsteira {
  sql: Sql;
  /** Monta o cliente da Shopee de um cliente (lê a credencial cifrada). */
  shopeeDoCliente: (cliente: Cliente) => Promise<Pick<ClienteShopee, 'buscarOfertas'>>;
}

export function criarExecutores(deps: DepsEsteira): Record<string, Executor> {
  const { sql } = deps;
  return {
    'ofertas.shopee.coletar': async (t) => {
      const cliente = await buscarCliente(sql, t.clienteId);
      const nicho = String(t.entrada.nicho ?? '');
      if (!nicho) throw new Error('tarefa sem nicho');
      const r = await coletarOfertasShopee({ sql, shopee: await deps.shopeeDoCliente(cliente) }, {
        cliente, nicho, limite: Number(t.entrada.limite ?? 30),
      });
      return { dataColeta: r.dataColeta, total: r.ofertas.length, novas: r.novas, descartadas: r.descartadas };
    },
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
    for (const etapa of ETAPAS) {
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
