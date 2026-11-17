/**
 * Regras do Curador além do esquema: só IDs da lista de candidatas, sem repetir,
 * e exatamente a quantidade pedida (ou todas, se houver menos).
 */
export interface CandidataCurador {
  id: string;
  plataforma: string;
  nicho: string | null;
  titulo: string;
  preco: number;
  desconto_pct: number | null;
  comissao_pct: number | null;
  comissao_valor: number | null;
  vendas: number | null;
  avaliacao: number | null;
}

export interface EntradaCurador {
  data: string;
  quantidade: number;
  candidatas: CandidataCurador[];
  diretrizes: Record<string, string>;
  enviados_recentes: string[];
  /** O que funcionou no grupo nas últimas 4 semanas (calculado pelo código). Ausente/null sem histórico. */
  desempenho_recente?: import('../../services/relatorios/desempenho.ts').DesempenhoRecente | null;
}

export interface SaidaCurador {
  escolhas: { oferta_id: string; motivo: string }[];
}

export function regrasCurador(entrada: EntradaCurador, saida: SaidaCurador): string[] {
  const problemas: string[] = [];
  const validos = new Set(entrada.candidatas.map((c) => c.id));
  const vistos = new Set<string>();
  for (const e of saida.escolhas) {
    if (!validos.has(e.oferta_id)) problemas.push(`ID fora da lista de candidatas: ${e.oferta_id}`);
    if (vistos.has(e.oferta_id)) problemas.push(`ID repetido: ${e.oferta_id}`);
    vistos.add(e.oferta_id);
  }
  const esperado = Math.min(entrada.quantidade, entrada.candidatas.length);
  if (saida.escolhas.length !== esperado) problemas.push(`escolha exatamente ${esperado} ofertas (vieram ${saida.escolhas.length})`);
  return problemas;
}
