/**
 * Modelos e preços padrão de cada provedor de IA (sem dependências: usado pelo harness e pelos clientes).
 * Gemini: modelos com nível gratuito, conforme a documentação do Gemini (nov/2026).
 */
import type { PrecoModelo } from './agentes.ts';

export type Provedor = 'gemini' | 'claude';

export const MODELOS_PADRAO: Record<Provedor, { pequeno: string; forte: string }> = {
  gemini: { pequeno: 'gemini-3.5-flash-lite', forte: 'gemini-4-hydrogen' },
  claude: { pequeno: 'claude-haiku-5-5', forte: 'claude-haiku-5-5' },
};

/** Preço por milhão de tokens (US$). Gemini no nível gratuito: zero. */
export const PRECOS_PADRAO: Record<string, PrecoModelo> = {
  'gemini-3.5-flash-lite': { entradaPorMilhao: 0, saidaPorMilhao: 0 },
  'gemini-4-hydrogen': { entradaPorMilhao: 0, saidaPorMilhao: 0 },
  'claude-haiku-5-5': { entradaPorMilhao: 0.1, saidaPorMilhao: 0.5 },
};

export function provedorAtual(ambiente: Record<string, string | undefined> = process.env): Provedor {
  return ambiente.IA_PROVEDOR?.trim().toLowerCase() === 'claude' ? 'claude' : 'gemini';
}
