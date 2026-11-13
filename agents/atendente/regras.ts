/**
 * Regras do Atendente além do esquema: o link extraído tem de ser exatamente um dos links da mensagem
 * (nunca inventado), e cada campo só aparece na intenção que o usa.
 */
export type Intencao = 'transformar_link' | 'rastrear_produto' | 'quanto_ganhei' | 'mudar_nicho' | 'pausar' | 'desconhecida';

export interface EntradaAtendente {
  mensagem: string;
  links_na_mensagem: string[];
  nichos_do_cliente: string[];
}

export interface SaidaAtendente {
  intencao: Intencao;
  url: string | null;
  periodo: 'hoje' | 'semana' | 'mes' | null;
  nicho: string | null;
  resumo: string;
}

/** Links http(s) que aparecem no texto (o código extrai; o modelo só escolhe entre eles). */
export function extrairLinks(texto: string): string[] {
  return [...new Set((texto.match(/https?:\/\/[^\s<>"']+/gi) ?? []).map((u) => u.replace(/[.,;:!?)\]]+$/, '')))];
}

export function regrasAtendente(entrada: EntradaAtendente, saida: SaidaAtendente): string[] {
  const p: string[] = [];
  const precisaUrl = saida.intencao === 'transformar_link' || saida.intencao === 'rastrear_produto';
  if (saida.url !== null && !entrada.links_na_mensagem.includes(saida.url)) p.push('url não é um dos links da mensagem');
  if (!precisaUrl && saida.url !== null) p.push(`url só vale para transformar_link ou rastrear_produto`);
  if (precisaUrl && saida.url === null && entrada.links_na_mensagem.length) p.push('a mensagem tem link: copie-o em "url"');
  if (saida.intencao !== 'quanto_ganhei' && saida.periodo !== null) p.push('periodo só vale para quanto_ganhei');
  if (saida.intencao === 'quanto_ganhei' && saida.periodo === null) p.push('informe o periodo (hoje, semana ou mes)');
  if (saida.intencao !== 'mudar_nicho' && saida.nicho !== null) p.push('nicho só vale para mudar_nicho');
  return p;
}
