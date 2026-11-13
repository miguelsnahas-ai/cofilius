/**
 * Atendente: porta de entrada do afiliado.
 *
 * Cada mensagem recebida vira um pedido (`pedidos_afiliado`). O agente só classifica e extrai dados;
 * o que acontece depois é código:
 * - quanto_ganhei: responde na hora com números do banco;
 * - transformar_link: gera o link pela Open API da Shopee quando houver; senão, vira tarefa do operador;
 * - rastrear_produto, mudar_nicho, pausar: viram tarefa do operador (nada muda sem você);
 * - desconhecida: vai para o operador com a mensagem original, sem resposta improvisada.
 * As respostas ao afiliado são textos fixos daqui, nunca texto do modelo.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import { carregarContrato, executarAgente, type ContratoAgente, type ModeloIA, type PrecoModelo } from '../../harness/agentes.ts';
import { enfileirar } from '../../harness/fila.ts';
import type { Cliente } from '../../db/clientes.ts';
import { extrairLinks, regrasAtendente, type EntradaAtendente, type Intencao, type SaidaAtendente } from '../../agents/atendente/regras.ts';
import { dataLocal } from '../lista/lista.ts';
import { formatarPreco } from '../lista/marcadores.ts';
import { resumoPeriodo } from '../vendas/atribuicao.ts';
import { gerarLinkShopee, validarUrlShopee } from '../links/gerarLinkShopee.ts';
import type { ClienteShopee } from '../shopee/client.ts';

const PASTA = join(dirname(fileURLToPath(import.meta.url)), '../../agents/atendente');

export function contratoAtendente(ambiente: Record<string, string | undefined> = process.env) {
  return carregarContrato<EntradaAtendente, SaidaAtendente>(PASTA, regrasAtendente, ambiente);
}

export interface ResultadoAtendimento {
  pedidoId: string;
  intencao: Intencao;
  situacao: 'resolvido' | 'encaminhado_operador';
  /** Texto para mandar ao afiliado agora (null: o operador responde). */
  resposta: string | null;
  tarefaId: string | null;
}

const reais = (v: string) => formatarPreco(v);

function periodoDe(p: SaidaAtendente['periodo'], hoje: string): { inicio: string; fim: string; nome: string } {
  if (p === 'hoje') return { inicio: hoje, fim: hoje, nome: 'Hoje' };
  if (p === 'mes') return { inicio: `${hoje.slice(0, 8)}01`, fim: hoje, nome: 'Neste mês' };
  const inicio = new Date(new Date(`${hoje}T12:00:00Z`).getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  return { inicio, fim: hoje, nome: 'Nos últimos 7 dias' };
}

async function respostaGanhos(sql: Sql, cliente: Cliente, periodo: SaidaAtendente['periodo'], agora: Date): Promise<string> {
  const p = periodoDe(periodo, dataLocal(agora, cliente.fusoHorario));
  const r = await resumoPeriodo(sql, cliente, p.inicio, p.fim);
  const pedidos = r.porPlataformaESituacao.filter((x) => x.situacao !== 'cancelada').reduce((s, x) => s + x.pedidos, 0);
  return [
    `${p.nome}: ${pedidos} ${pedidos === 1 ? 'pedido' : 'pedidos'}.`,
    `Comissão validada: ${reais(r.comissao.validada)}`,
    `Comissão pendente: ${reais(r.comissao.pendente)} (ainda pode mudar se algum pedido for cancelado)`,
  ].join('\n');
}

const RESPOSTAS = {
  linkManual: 'Recebi! Vou gerar o seu link com rastreio e já te mando. 😉',
  rastrear: 'Anotado! Vou acompanhar esse produto e, quando valer a pena, ele entra na sua lista. 👀',
  mudarNicho: 'Anotado! Vou ver essa mudança de nicho e te confirmo antes de mudar a sua lista.',
  pausar: 'Combinado! Vou pausar as suas listas e te confirmo por aqui.',
};

export async function atender(
  sql: Sql,
  p: {
    cliente: Cliente;
    mensagem: string;
    modelo: ModeloIA;
    contrato?: ContratoAgente<EntradaAtendente, SaidaAtendente>;
    precos?: Record<string, PrecoModelo>;
    /** Cliente da Open API da Shopee do afiliado, se houver (gera link na hora). */
    shopee?: Pick<ClienteShopee, 'gerarLinkCurto'> | null;
    agora?: Date;
  },
): Promise<ResultadoAtendimento> {
  const mensagem = p.mensagem.trim().slice(0, 2000);
  if (!mensagem) throw new Error('Mensagem vazia.');
  const agora = p.agora ?? new Date();
  const [pedido] = await sql`
    insert into pedidos_afiliado (cliente_id, mensagem_original, situacao, recebido_em)
    values (${p.cliente.clienteId}, ${mensagem}, 'em_andamento', ${agora}) returning id`;
  const pedidoId = pedido!.id as string;

  const entrada: EntradaAtendente = {
    mensagem, links_na_mensagem: extrairLinks(mensagem), nichos_do_cliente: p.cliente.nichos.map((n) => n.slug),
  };
  let saida: SaidaAtendente;
  try {
    const r = await executarAgente(sql, {
      contrato: p.contrato ?? (await contratoAtendente()), clienteId: p.cliente.clienteId, entrada, modelo: p.modelo, precos: p.precos,
    });
    saida = r.saida;
  } catch (erro) {
    // Se a IA falhar, o pedido não se perde: vai para o operador.
    log.warn('atendimento.ia_falhou', { pedidoId, erro: (erro as Error).message });
    saida = { intencao: 'desconhecida', url: null, periodo: null, nicho: null, resumo: `IA indisponível: ${(erro as Error).message}`.slice(0, 200) };
  }

  const paraOperador = async (tipo: string, resposta: string | null): Promise<ResultadoAtendimento> => {
    const t = await enfileirar(sql, {
      clienteId: p.cliente.clienteId, tipo: `operador.${tipo}`, agendadaPara: agora, maxTentativas: 0,
      entrada: { pedidoId, mensagem, intencao: saida.intencao, resumo: saida.resumo, url: saida.url, nicho: saida.nicho },
    });
    await sql`update pedidos_afiliado set intencao = ${saida.intencao}, situacao = 'encaminhado_operador', tarefa_id = ${t.id}, resposta = ${resposta}
              where id = ${pedidoId}`;
    log.info('atendimento.encaminhado', { pedidoId, intencao: saida.intencao });
    return { pedidoId, intencao: saida.intencao, situacao: 'encaminhado_operador', resposta, tarefaId: t.id };
  };
  const resolver = async (resposta: string): Promise<ResultadoAtendimento> => {
    await sql`update pedidos_afiliado set intencao = ${saida.intencao}, situacao = 'resolvido', resposta = ${resposta}, resolvido_em = ${agora}
              where id = ${pedidoId}`;
    log.info('atendimento.resolvido', { pedidoId, intencao: saida.intencao });
    return { pedidoId, intencao: saida.intencao, situacao: 'resolvido', resposta, tarefaId: null };
  };

  switch (saida.intencao) {
    case 'quanto_ganhei':
      return resolver(await respostaGanhos(sql, p.cliente, saida.periodo, agora));
    case 'transformar_link': {
      let urlShopee: string | null = null;
      try { urlShopee = saida.url ? validarUrlShopee(saida.url) : null; } catch { urlShopee = null; }
      if (urlShopee && p.shopee) {
        try {
          const l = await gerarLinkShopee({ sql, shopee: p.shopee }, {
            cliente: p.cliente, url: urlShopee, quando: agora, contexto: { origem: 'atendente', pedidoId },
          });
          return resolver(`Aqui está o seu link com rastreio:\n${l.urlAfiliado}`);
        } catch (erro) {
          log.warn('atendimento.link_falhou', { pedidoId, erro: (erro as Error).message });
        }
      }
      return paraOperador('gerar_link', RESPOSTAS.linkManual);
    }
    case 'rastrear_produto':
      return paraOperador('rastrear_produto', RESPOSTAS.rastrear);
    case 'mudar_nicho':
      return paraOperador('mudar_nicho', RESPOSTAS.mudarNicho);
    case 'pausar':
      return paraOperador('pausar', RESPOSTAS.pausar);
    default:
      return paraOperador('responder', null);
  }
}

export interface PedidoAberto {
  pedidoId: string;
  tarefaId: string | null;
  recebidoEm: Date;
  mensagem: string;
  intencao: string | null;
  resumo: string | null;
  respostaEnviada: string | null;
  tipoTarefa: string | null;
}

/** Pedidos que esperam o operador. */
export async function pedidosAbertos(sql: Sql, cliente: Cliente): Promise<PedidoAberto[]> {
  const r = await sql`
    select p.id, p.tarefa_id, p.recebido_em, p.mensagem_original, p.intencao, p.resposta, t.tipo, t.entrada ->> 'resumo' as resumo
    from pedidos_afiliado p left join tarefas t on t.cliente_id = p.cliente_id and t.id = p.tarefa_id
    where p.cliente_id = ${cliente.clienteId} and p.situacao in ('aberto', 'em_andamento', 'encaminhado_operador')
    order by p.recebido_em`;
  return r.map((x) => ({
    pedidoId: x.id, tarefaId: x.tarefa_id, recebidoEm: x.recebido_em, mensagem: x.mensagem_original, intencao: x.intencao,
    resumo: x.resumo, respostaEnviada: x.resposta, tipoTarefa: x.tipo,
  }));
}

/** O operador conclui o pedido (e a tarefa ligada a ele), com a resposta que deu ao afiliado. */
export async function concluirPedido(sql: Sql, cliente: Cliente, pedidoId: string, resposta: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [p] = await tx`
      update pedidos_afiliado set situacao = 'resolvido', resposta = ${resposta.trim() || null}, resolvido_em = now()
      where id = ${pedidoId} and cliente_id = ${cliente.clienteId} and situacao <> 'resolvido'
      returning tarefa_id`;
    if (!p) throw new Error('Pedido não encontrado ou já resolvido.');
    if (p.tarefa_id) {
      await tx`update tarefas set estado = 'concluida', concluida_em = now(), resultado = ${tx.json({ resposta } as never)}
               where id = ${p.tarefa_id} and estado = 'pendente'`;
    }
  });
}
