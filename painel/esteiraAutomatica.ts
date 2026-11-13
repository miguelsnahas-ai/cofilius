/**
 * Esteira automática dentro do painel: enquanto o painel está aberto, a cada poucos minutos agenda as
 * etapas do dia (sem duplicar) e executa as que já venceram. Dispensa cron ou agendador externo.
 * Pode ser desligada na Configuração (PAINEL_ESTEIRA=desligada).
 */
import { log } from '../harness/log.ts';
import { processarFila, statusFila, type ResumoFila } from '../harness/fila.ts';
import { agendarDia, criarExecutores } from '../harness/esteira.ts';
import { dataLocal } from '../services/lista/lista.ts';
import type { DepsApi } from './api.ts';

export interface EstadoEsteira {
  ligada: boolean;
  rodando: boolean;
  ultima: { em: Date; dia: string; agendadas: number; resumo: ResumoFila | null; erro: string | null } | null;
}

export function criarEsteiraAutomatica(deps: DepsApi, opcoes: { intervaloMs?: number; fuso?: string } = {}) {
  const estado: EstadoEsteira = { ligada: process.env.PAINEL_ESTEIRA !== 'desligada', rodando: false, ultima: null };
  let timer: NodeJS.Timeout | null = null;

  async function rodarAgora(): Promise<EstadoEsteira> {
    if (estado.rodando) return estado;
    estado.rodando = true;
    const dia = dataLocal(new Date(), opcoes.fuso ?? 'America/Sao_Paulo');
    try {
      const agendamentos = await agendarDia(deps.sql, dia);
      const executores = criarExecutores({
        sql: deps.sql,
        shopeeDoCliente: async (c) => {
          const s = await deps.shopeeDoCliente?.(c);
          if (!s) throw new Error('cliente sem credencial da Open API da Shopee');
          return s;
        },
        modelo: deps.modelo,
        precos: deps.precos,
      });
      const resumo = await processarFila(deps.sql, executores);
      estado.ultima = { em: new Date(), dia, agendadas: agendamentos.filter((a) => a.situacao === 'agendada').length, resumo, erro: null };
      if (resumo.executadas) log.info('esteira.automatica', { ...resumo });
    } catch (erro) {
      estado.ultima = { em: new Date(), dia, agendadas: 0, resumo: null, erro: (erro as Error).message };
      log.error('esteira.automatica_falhou', { erro: (erro as Error).message });
    } finally {
      estado.rodando = false;
    }
    return estado;
  }

  return {
    estado,
    rodarAgora,
    iniciar() {
      if (timer) return;
      timer = setInterval(() => { if (estado.ligada) void rodarAgora(); }, opcoes.intervaloMs ?? 5 * 60_000);
      timer.unref();
      if (estado.ligada) void rodarAgora();
    },
    parar() { if (timer) clearInterval(timer); timer = null; },
    definirLigada(ligada: boolean) { estado.ligada = ligada; },
    async status() {
      const tarefas = await statusFila(deps.sql, new Date(Date.now() - 36 * 3_600_000));
      return {
        ligada: estado.ligada, rodando: estado.rodando, ultima: estado.ultima,
        tarefas: tarefas.filter((t) => !t.tipo.startsWith('operador.')).slice(-40),
      };
    },
  };
}

export type EsteiraAutomatica = ReturnType<typeof criarEsteiraAutomatica>;
