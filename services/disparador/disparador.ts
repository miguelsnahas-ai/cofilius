/**
 * Disparador: envia ao afiliado as mensagens aprovadas e registra entrega e leitura.
 *
 * Canais:
 * - manual: o operador copia o texto e envia pelo WhatsApp Business (hoje). O envio só é registrado.
 * - whatsapp: envio pela Cloud API (services/disparador/whatsapp.ts), quando o número estiver aprovado.
 *
 * Antes de cada envio roda a conferência da lista (preço conferido há até 30 min, preço igual, sem repetição).
 * Sem aprovação, nada sai: só mensagens "aprovada" são enviadas.
 * Janela de 24 horas: texto livre só depois de o afiliado escrever. Por isso a lista sai quando ela pede
 * ("mandar a lista de hoje"), em resposta à mensagem dela.
 */
import type { Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import type { Cliente } from '../../db/clientes.ts';
import { conferirAntesDoEnvio } from '../lista/lista.ts';
import { enviarTextoWhatsapp, ErroWhatsapp, ERRO_FORA_DA_JANELA, type ConfigWhatsapp } from './whatsapp.ts';

export interface Canal {
  nome: 'manual' | 'whatsapp';
  /** Envia e devolve o id da mensagem no canal (null no manual). */
  enviar(para: string, texto: string): Promise<string | null>;
}

export const canalManual: Canal = { nome: 'manual', enviar: async () => null };

export function canalWhatsapp(cfg: ConfigWhatsapp): Canal {
  return { nome: 'whatsapp', enviar: (para, texto) => enviarTextoWhatsapp(cfg, para, texto) };
}

export class ErroForaDaJanela extends Error {
  constructor() {
    super('Fora da janela de 24 horas do WhatsApp: a lista só pode sair depois que a afiliada mandar uma mensagem (ex.: tocar em "mandar a lista de hoje").');
    this.name = 'ErroForaDaJanela';
  }
}

export interface ResultadoEnvio {
  mensagemId: string;
  enviada: boolean;
  motivo: string;
  idExterno: string | null;
}

export async function enviarMensagem(
  sql: Sql, cliente: Cliente, mensagemId: string, canal: Canal, agora = new Date(),
): Promise<ResultadoEnvio> {
  const conf = await conferirAntesDoEnvio(sql, cliente, mensagemId, agora);
  if (!conf.podeEnviar) return { mensagemId, enviada: false, motivo: conf.motivo, idExterno: null };
  const [m] = await sql`
    select m.texto_final, c.whatsapp from mensagens m join clientes c on c.cliente_id = m.cliente_id where m.id = ${mensagemId}`;
  if (canal.nome === 'whatsapp' && !m!.whatsapp) {
    return { mensagemId, enviada: false, motivo: 'cliente sem WhatsApp cadastrado (editar-cliente --whatsapp)', idExterno: null };
  }
  let idExterno: string | null;
  try {
    idExterno = await canal.enviar(m!.whatsapp ?? '', m!.texto_final);
  } catch (erro) {
    if (erro instanceof ErroWhatsapp && erro.codigo === ERRO_FORA_DA_JANELA) throw new ErroForaDaJanela();
    throw erro;
  }
  await sql`
    update mensagens set estado = 'enviada', enviada_em = ${agora}, canal = ${canal.nome}, id_externo = ${idExterno}
    where id = ${mensagemId} and estado = 'aprovada'`;
  log.info('disparador.enviada', { cliente: cliente.codigo, mensagemId, canal: canal.nome });
  return { mensagemId, enviada: true, motivo: 'ok', idExterno };
}

/** Envia, na ordem da curadoria, todas as aprovadas do dia. Para tudo se cair fora da janela. */
export async function enviarListaDoDia(
  sql: Sql, cliente: Cliente, data: string, canal: Canal, agora = new Date(),
): Promise<ResultadoEnvio[]> {
  const ids = await sql<{ id: string }[]>`
    select m.id from mensagens m left join ofertas o on o.cliente_id = m.cliente_id and o.id = m.oferta_id
    where m.cliente_id = ${cliente.clienteId} and m.data_lista = ${data} and m.estado = 'aprovada'
    order by (o.curadoria ->> 'posicao')::int nulls last, m.criado_em`;
  const saida: ResultadoEnvio[] = [];
  for (const { id } of ids) saida.push(await enviarMensagem(sql, cliente, id, canal, agora));
  return saida;
}

/** Avisos de entrega e leitura do canal (pelo id externo). */
export async function registrarStatus(sql: Sql, avisos: { id: string; status: string; em: Date }[]): Promise<number> {
  let n = 0;
  for (const a of avisos) {
    if (a.status === 'delivered') {
      n += (await sql`update mensagens set entregue_em = coalesce(entregue_em, ${a.em}) where canal = 'whatsapp' and id_externo = ${a.id} returning 1`).length;
    } else if (a.status === 'read') {
      n += (await sql`update mensagens set entregue_em = coalesce(entregue_em, ${a.em}), lida_em = coalesce(lida_em, ${a.em})
                     where canal = 'whatsapp' and id_externo = ${a.id} returning 1`).length;
    } else if (a.status === 'failed') {
      log.error('disparador.falha_entrega', { idExterno: a.id });
    }
  }
  return n;
}
