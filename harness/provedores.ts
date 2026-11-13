/**
 * Qual IA os agentes usam: Gemini (padrão, nível gratuito) ou Claude.
 *
 *   IA_PROVEDOR=gemini | claude        (sem valor: gemini)
 *   GEMINI_API_KEY / ANTHROPIC_API_KEY  a chave do provedor escolhido
 *   MODELO_IA_PEQUENO / MODELO_IA_FORTE opcional: troca o modelo de cada porte
 *
 * O resto do sistema só conhece a interface ModeloIA: trocar de provedor não muda agente nem regra.
 */
import type { ModeloIA } from './agentes.ts';
import { MODELOS_PADRAO, provedorAtual, type Provedor } from './modelosPadrao.ts';
import { criarModeloClaude } from './modeloClaude.ts';
import { criarModeloGemini } from './modeloGemini.ts';

export { provedorAtual, type Provedor } from './modelosPadrao.ts';

type Ambiente = Record<string, string | undefined>;

export const NOMES_PROVEDOR: Record<Provedor, string> = { gemini: 'Gemini (Google)', claude: 'Claude (Anthropic)' };

/** Modelo de um porte ("pequeno" ou "forte"): o do .env, ou o padrão do provedor. */
export function modeloDoPorte(porte: 'pequeno' | 'forte', ambiente: Ambiente = process.env): string {
  const variavel = porte === 'pequeno' ? 'MODELO_IA_PEQUENO' : 'MODELO_IA_FORTE';
  return ambiente[variavel]?.trim() || MODELOS_PADRAO[provedorAtual(ambiente)][porte];
}

/** A chave do provedor atual está configurada? */
export function iaConfigurada(ambiente: Ambiente = process.env): boolean {
  const p = provedorAtual(ambiente);
  if (p === 'claude') return !!(ambiente.ANTHROPIC_API_KEY || ambiente.ANTHROPIC_AUTH_TOKEN);
  return !!ambiente.GEMINI_API_KEY;
}

/** Cliente de IA do provedor atual. */
export function criarModeloDoAmbiente(ambiente: Ambiente = process.env): ModeloIA {
  return provedorAtual(ambiente) === 'claude' ? criarModeloClaude() : criarModeloGemini({ apiKey: ambiente.GEMINI_API_KEY });
}
