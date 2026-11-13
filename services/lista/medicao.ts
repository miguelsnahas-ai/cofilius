/**
 * Fecha o ciclo da mensagem: enviada → medida, depois de 7 dias (tempo para cliques e pedidos chegarem
 * nos relatórios). Uma mensagem medida entra nos indicadores como as enviadas; o estado só diz que a janela fechou.
 */
import type { Sql } from '../../harness/db.ts';

export const DIAS_PARA_MEDIR = 7;

export async function marcarMedidas(sql: Sql, clienteId: string, agora = new Date()): Promise<number> {
  const limite = new Date(agora.getTime() - DIAS_PARA_MEDIR * 86_400_000);
  const r = await sql`
    update mensagens set estado = 'medida'
    where cliente_id = ${clienteId} and estado = 'enviada' and enviada_em < ${limite}
    returning id`;
  return r.length;
}
