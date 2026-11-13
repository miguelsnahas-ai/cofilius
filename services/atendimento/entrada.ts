/**
 * Entrada de mensagens do afiliado (WhatsApp ou simulação pelo painel).
 *
 * 1. Identifica o cliente pelo número.
 * 2. "Mandar a lista de hoje" (botão ou texto parecido) é tratado em código, sem IA: envia as aprovadas
 *    do dia, aproveitando a janela de 24 horas aberta pela mensagem dela.
 * 3. O resto vai para o Atendente; a resposta pronta (se houver) volta pelo mesmo canal.
 */
import type { Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import type { ModeloIA, PrecoModelo } from '../../harness/agentes.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { dataLocal } from '../lista/lista.ts';
import { enviarListaDoDia, type Canal, type ResultadoEnvio } from '../disparador/disparador.ts';
import { atender, ErroPedidoRepetido, type ResultadoAtendimento } from './atendente.ts';
import type { ClienteShopee } from '../shopee/client.ts';

/** Texto do botão que pede a lista do dia (também vale digitado, com pequenas variações). */
export const BOTAO_LISTA = 'Mandar a lista de hoje';

export function pedeALista(texto: string): boolean {
  const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(me )?(manda|mandar|envia|enviar)( a)? lista( de hoje| do dia)?( por favor)?$/.test(t);
}

export interface DepsEntrada {
  sql: Sql;
  canal: Canal;
  modelo?: () => ModeloIA;
  precos?: Record<string, PrecoModelo>;
  shopeeDoCliente?: (cliente: Cliente) => Promise<Pick<ClienteShopee, 'gerarLinkCurto'> | null>;
}

export type ResultadoEntrada =
  | { tipo: 'lista'; envios: ResultadoEnvio[]; resposta: string | null }
  | { tipo: 'atendimento'; resultado: ResultadoAtendimento }
  | { tipo: 'repetida' }
  | { tipo: 'numero_desconhecido' };

export async function clientePorWhatsapp(sql: Sql, numero: string): Promise<Cliente | null> {
  const digitos = numero.replace(/\D/g, '');
  const [c] = await sql`select cliente_id from clientes where whatsapp = ${digitos} and ativo`;
  return c ? buscarCliente(sql, c.cliente_id) : null;
}

export async function receberMensagem(
  deps: DepsEntrada,
  m: { cliente: Cliente; texto: string; idExterno?: string; em?: Date; canalEntrada: 'painel' | 'whatsapp' },
): Promise<ResultadoEntrada> {
  const { sql } = deps;
  const agora = m.em ?? new Date();

  if (pedeALista(m.texto)) {
    const [p] = await sql`
      insert into pedidos_afiliado (cliente_id, mensagem_original, intencao, situacao, recebido_em, canal, id_externo)
      values (${m.cliente.clienteId}, ${m.texto}, 'pedir_lista', 'em_andamento', ${agora}, ${m.canalEntrada}, ${m.idExterno ?? null})
      on conflict (canal, id_externo) where id_externo is not null do nothing returning id`;
    if (!p) return { tipo: 'repetida' };
    const envios = await enviarListaDoDia(sql, m.cliente, dataLocal(agora, m.cliente.fusoHorario), deps.canal, agora);
    const enviadas = envios.filter((e) => e.enviada).length;
    const resposta = enviadas ? null : 'A lista de hoje ainda não está pronta. Assim que estiver, te aviso! 😉';
    await sql`update pedidos_afiliado set situacao = 'resolvido', resolvido_em = now(),
              resposta = ${resposta ?? `${enviadas} ofertas enviadas`} where id = ${p.id}`;
    if (resposta) await responder(deps, m.cliente, resposta);
    return { tipo: 'lista', envios, resposta };
  }

  if (!deps.modelo) throw new Error('IA não configurada: o Atendente precisa de ANTHROPIC_API_KEY.');
  try {
    const resultado = await atender(sql, {
      cliente: m.cliente, mensagem: m.texto, modelo: deps.modelo(), precos: deps.precos, agora,
      shopee: deps.shopeeDoCliente ? await deps.shopeeDoCliente(m.cliente) : null,
      canal: m.canalEntrada, idExterno: m.idExterno,
    });
    if (resultado.resposta) await responder(deps, m.cliente, resultado.resposta);
    return { tipo: 'atendimento', resultado };
  } catch (erro) {
    if (erro instanceof ErroPedidoRepetido) return { tipo: 'repetida' };
    throw erro;
  }
}

/** Responde ao afiliado pelo canal (falha ao responder não desfaz o atendimento; fica no log). */
async function responder(deps: DepsEntrada, cliente: Cliente, texto: string): Promise<void> {
  const [c] = await deps.sql`select whatsapp from clientes where cliente_id = ${cliente.clienteId}`;
  try {
    await deps.canal.enviar(c?.whatsapp ?? '', texto);
  } catch (erro) {
    log.warn('entrada.resposta_falhou', { cliente: cliente.codigo, erro: (erro as Error).message });
  }
}
