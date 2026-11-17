/**
 * Regras do Analista além do esquema:
 * - exatamente 3 insights;
 * - toda ref citada existe nos indicadores, e todo item cita ao menos uma;
 * - diretriz só para nicho do cliente, no máximo uma por nicho;
 * - insight sem valor em reais nem percentual (os números vêm do banco, ao lado de cada leitura).
 */
import type { Indicador } from '../../services/relatorios/indicadores.ts';

export interface EntradaAnalista {
  periodo: { inicio: string; fim: string };
  nichos: string[];
  diretrizes_atuais: Record<string, string>;
  indicadores: (Omit<Indicador, 'dimensao'> & { dimensao: string })[];
  totais: { mensagens: number; cliques: number; pedidos: number; comissao: number };
}

export interface SaidaAnalista {
  diretrizes: { nicho: string; texto: string; refs: string[] }[];
  insights: { texto: string; refs: string[] }[];
}

const NUMERO_PROIBIDO = /(R\$\s*\d|\d[\d.,]*\s*(%|por\s*cento|reais\b))/i;

export function regrasAnalista(entrada: EntradaAnalista, saida: SaidaAnalista): string[] {
  const problemas: string[] = [];
  const refs = new Set(entrada.indicadores.map((i) => i.ref));
  const conferirRefs = (onde: string, lista: string[]) => {
    if (!lista.length) problemas.push(`${onde} sem refs`);
    for (const r of lista) if (!refs.has(r)) problemas.push(`${onde} cita ref inexistente: ${r}`);
  };
  if (saida.insights.length !== 3) problemas.push(`devem ser exatamente 3 insights (vieram ${saida.insights.length})`);
  saida.insights.forEach((ins, i) => {
    conferirRefs(`insight ${i + 1}`, ins.refs);
    if (NUMERO_PROIBIDO.test(ins.texto)) problemas.push(`insight ${i + 1} escreve valor em reais ou percentual`);
  });
  const nichos = new Set(entrada.nichos);
  const vistos = new Set<string>();
  saida.diretrizes.forEach((d, i) => {
    if (!nichos.has(d.nicho)) problemas.push(`diretriz ${i + 1} para nicho que não é do cliente: ${d.nicho}`);
    if (vistos.has(d.nicho)) problemas.push(`mais de uma diretriz para o nicho ${d.nicho}`);
    vistos.add(d.nicho);
    if (!d.texto.trim()) problemas.push(`diretriz ${i + 1} vazia`);
    conferirRefs(`diretriz ${i + 1}`, d.refs);
  });
  return problemas;
}
