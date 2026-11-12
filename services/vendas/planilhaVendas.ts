/**
 * Planilha de vendas no formato do Cofilius (modo manual, enquanto não há importador de cada plataforma).
 * Modelo: docs/modelos/vendas.csv.
 *
 * Colunas: plataforma, pedido, produto, nome, quantidade, valor, comissao, situacao, etiqueta, data.
 * Na Shopee, em vez de "etiqueta", pode usar sub_id1 ... sub_id5.
 */
import { lerCsv, numeroBr } from '../../harness/csv.ts';
import { normalizar } from '../etiquetas/etiquetas.ts';
import { horarioLocalParaData } from '../etiquetas/etiquetas.ts';
import { chaveShopee, type Plataforma, type Situacao, type VendaNormalizada } from './atribuicao.ts';
import type { ErroLinha } from '../ofertas/importarPlanilhaShopee.ts';

const PLATAFORMAS: Record<string, Plataforma> = {
  shopee: 'shopee', mercadolivre: 'mercado_livre', ml: 'mercado_livre', amazon: 'amazon',
};
const SITUACOES: Record<string, Situacao> = {
  pendente: 'pendente', pending: 'pendente', emandamento: 'pendente',
  validada: 'validada', validado: 'validada', aprovada: 'validada', concluida: 'validada', paga: 'validada', completed: 'validada',
  cancelada: 'cancelada', cancelado: 'cancelada', cancelled: 'cancelada', canceled: 'cancelada', devolvida: 'cancelada',
};

function data(texto: string | undefined, fuso: string): Date | null {
  const t = (texto ?? '').trim();
  if (!t) return null;
  let m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) return horarioLocalParaData(`${m[3]}-${m[2]}-${m[1]} ${m[4] ?? '12'}:${m[5] ?? '00'}`, fuso);
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) return horarioLocalParaData(`${m[1]}-${m[2]}-${m[3]} ${m[4] ?? '12'}:${m[5] ?? '00'}`, fuso);
  throw new Error(`data inválida: "${t}" (use DD/MM/AAAA ou AAAA-MM-DD)`);
}

function decimal(texto: string | undefined, campo: string): string | null {
  const n = numeroBr(texto);
  if (n === null) return null;
  if (Number.isNaN(n) || n < 0) throw new Error(`${campo} inválido: "${texto}"`);
  return n.toFixed(2);
}

export function lerPlanilhaVendas(texto: string, fuso = 'America/Sao_Paulo'): { vendas: VendaNormalizada[]; erros: ErroLinha[] } {
  const linhas = lerCsv(texto);
  const cab = (linhas[0] ?? []).map((c) => normalizar(c));
  const col = (cels: string[], ...nomes: string[]) => {
    const i = cab.findIndex((c) => nomes.includes(c));
    return i >= 0 ? cels[i]?.trim() : undefined;
  };
  for (const obrig of [['plataforma'], ['pedido', 'pedidoid'], ['produto', 'produtoid', 'itemid', 'asin'], ['situacao', 'status']]) {
    if (!cab.some((c) => obrig.includes(c))) throw new Error(`A planilha precisa da coluna "${obrig[0]}". Use o modelo docs/modelos/vendas.csv.`);
  }
  const vendas: VendaNormalizada[] = [];
  const erros: ErroLinha[] = [];
  linhas.slice(1).forEach((cels, i) => {
    const linha = i + 2;
    try {
      const plataforma = PLATAFORMAS[normalizar(col(cels, 'plataforma') ?? '')];
      if (!plataforma) throw new Error(`plataforma desconhecida: "${col(cels, 'plataforma')}" (shopee, mercado livre ou amazon)`);
      const situacao = SITUACOES[normalizar(col(cels, 'situacao', 'status') ?? '')];
      if (!situacao) throw new Error(`situação desconhecida: "${col(cels, 'situacao', 'status')}" (pendente, validada ou cancelada)`);
      const pedidoId = col(cels, 'pedido', 'pedidoid');
      const produtoId = col(cels, 'produto', 'produtoid', 'itemid', 'asin');
      if (!pedidoId) throw new Error('pedido vazio');
      if (!produtoId) throw new Error('produto vazio');
      const subIds = [1, 2, 3, 4, 5].map((n) => col(cels, `subid${n}`));
      const chave = plataforma === 'shopee' && subIds.some(Boolean)
        ? chaveShopee(subIds)
        : col(cels, 'etiqueta', 'trackingid', 'chave', 'chaverastreio') || null;
      const qtd = numeroBr(col(cels, 'quantidade', 'qtd'));
      vendas.push({
        plataforma, situacao, pedidoId, produtoId,
        produtoNome: col(cels, 'nome', 'produtonome', 'titulo') || null,
        quantidade: qtd && Number.isInteger(qtd) && qtd > 0 ? qtd : 1,
        valor: decimal(col(cels, 'valor', 'valordopedido'), 'valor'),
        comissao: decimal(col(cels, 'comissao', 'comissaor'), 'comissão'),
        chaveRastreio: chave,
        dataPedido: data(col(cels, 'data', 'datadopedido'), fuso),
        bruto: { origem: 'planilha', linha },
      });
    } catch (e) {
      erros.push({ linha, motivo: (e as Error).message });
    }
  });
  return { vendas, erros };
}
