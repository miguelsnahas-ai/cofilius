/**
 * Log estruturado em JSON, uma linha por evento, na saída de erro (stderr).
 * A saída padrão fica livre para o resultado dos comandos.
 *
 * Campos com nome sensível são mascarados antes de escrever.
 */

export type NivelLog = 'debug' | 'info' | 'warn' | 'error';

const ORDEM: Record<NivelLog, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSIVEIS = /secret|senha|password|token|chave|authorization|signature|app_?id/i;

let nivelMinimo: NivelLog = (process.env.LOG_NIVEL as NivelLog) in ORDEM
  ? (process.env.LOG_NIVEL as NivelLog)
  : 'info';

export function definirNivelLog(nivel: NivelLog): void {
  nivelMinimo = nivel;
}

export function mascarar(valor: unknown, profundidade = 0): unknown {
  if (profundidade > 6 || valor === null || typeof valor !== 'object') return valor;
  if (Array.isArray(valor)) return valor.map((v) => mascarar(v, profundidade + 1));
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor)) {
    saida[k] = SENSIVEIS.test(k) ? '***' : mascarar(v, profundidade + 1);
  }
  return saida;
}

function escrever(nivel: NivelLog, evento: string, dados?: Record<string, unknown>): void {
  if (ORDEM[nivel] < ORDEM[nivelMinimo]) return;
  const linha = { ts: new Date().toISOString(), nivel, evento, ...(mascarar(dados ?? {}) as object) };
  process.stderr.write(JSON.stringify(linha) + '\n');
}

export const log = {
  debug: (evento: string, dados?: Record<string, unknown>) => escrever('debug', evento, dados),
  info: (evento: string, dados?: Record<string, unknown>) => escrever('info', evento, dados),
  warn: (evento: string, dados?: Record<string, unknown>) => escrever('warn', evento, dados),
  error: (evento: string, dados?: Record<string, unknown>) => escrever('error', evento, dados),
};
