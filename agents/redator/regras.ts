/**
 * Regras do Redator além do esquema: o texto passa na conferência de marcadores
 * (sem preço, percentual, link ou número escrito) e só usa {{desconto}} se a oferta tiver desconto.
 */
import { descreverProblema, verificarTextoModelo } from '../../services/lista/marcadores.ts';

export interface EntradaRedator {
  oferta: { titulo: string; nicho: string; tem_desconto: boolean; pode_mostrar_preco?: boolean };
  tom: string;
  exemplos: string[];
}

export interface SaidaRedator {
  texto_modelo: string;
}

export function regrasRedator(entrada: EntradaRedator, saida: SaidaRedator): string[] {
  const problemas = verificarTextoModelo(saida.texto_modelo).map(descreverProblema);
  if (!entrada.oferta.tem_desconto && /\{\{\s*desconto\s*\}\}/i.test(saida.texto_modelo)) {
    problemas.push('usou {{desconto}} numa oferta sem desconto');
  }
  if (entrada.oferta.pode_mostrar_preco === false && /\{\{\s*preco\s*\}\}/i.test(saida.texto_modelo)) {
    problemas.push('não use {{preco}} nesta oferta: o preço não pode aparecer (convide a pessoa a conferir o preço no link)');
  }
  return problemas;
}
