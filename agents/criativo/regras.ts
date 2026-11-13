/**
 * Regras do Criativo além do esquema: cada texto passa na conferência de marcadores (sem preço,
 * percentual, link ou número escrito; sem {{link}}, que no Instagram vai no sticker ou na bio),
 * {{desconto}} só com desconto, e o número de telas pedido.
 */
import { descreverProblema, verificarTextoModelo } from '../../services/lista/marcadores.ts';

export type FormatoCriativo = 'carrossel' | 'stories' | 'reels';

export interface EntradaCriativo {
  formato: FormatoCriativo;
  oferta: { titulo: string; nicho: string; tem_desconto: boolean };
  tom: string;
  telas: number;
}

export interface SaidaCriativo {
  gancho: string;
  telas: { titulo: string; texto: string }[];
  cta: string;
  legenda: string;
}

/** Cada campo de texto do roteiro, com um nome para a mensagem de erro. */
export function textosDoRoteiro(s: SaidaCriativo): [string, string][] {
  return [
    ['gancho', s.gancho],
    ...s.telas.flatMap((t, i): [string, string][] => [[`tela ${i + 1} (título)`, t.titulo], [`tela ${i + 1} (texto)`, t.texto]]),
    ['cta', s.cta],
    ['legenda', s.legenda],
  ];
}

export function regrasCriativo(entrada: EntradaCriativo, saida: SaidaCriativo): string[] {
  const problemas: string[] = [];
  for (const [campo, texto] of textosDoRoteiro(saida)) {
    for (const p of verificarTextoModelo(texto, { exigirLink: false, proibirLink: true })) problemas.push(`${campo}: ${descreverProblema(p)}`);
    if (!entrada.oferta.tem_desconto && /\{\{\s*desconto\s*\}\}/i.test(texto)) problemas.push(`${campo}: usou {{desconto}} numa oferta sem desconto`);
  }
  if (saida.telas.length !== entrada.telas) problemas.push(`escreva exatamente ${entrada.telas} telas (vieram ${saida.telas.length})`);
  const hashtags = saida.legenda.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length > 5) problemas.push(`legenda com ${hashtags.length} hashtags (no máximo cinco)`);
  return problemas;
}
