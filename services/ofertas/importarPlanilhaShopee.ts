/**
 * Conector de ofertas · Shopee · modo manual (sem a Open API).
 *
 * Lê a planilha de ofertas (modelo em docs/modelos/ofertas-shopee.csv), confere cada linha e grava em
 * `ofertas` com a mesma regra da API: uma linha por cliente + produto + dia, sem duplicar.
 * Linha com problema não é gravada: volta na lista de erros, com o número da linha e o motivo.
 */
import type { Sql } from '../../harness/db.ts';
import { lerCsv, numeroBr } from '../../harness/csv.ts';
import { log } from '../../harness/log.ts';
import type { Cliente } from '../../db/clientes.ts';
import { normalizar, partesLocais } from '../etiquetas/etiquetas.ts';
import { extrairIdsDaUrl, type OfertaShopee } from '../shopee/parser.ts';
import { gravarOfertas, type OfertaGravada } from './coletarOfertasShopee.ts';

/** Nomes de coluna aceitos (comparados sem acento, maiúsculas, espaços e símbolos). */
const COLUNAS: Record<string, string[]> = {
  link: ['link', 'linkdoproduto', 'url', 'urldoproduto'],
  titulo: ['titulo', 'nome', 'produto', 'nomedoproduto'],
  preco: ['preco', 'precor', 'precoatual'],
  desconto: ['desconto', 'descontopct'],
  comissao: ['comissao', 'comissaopct', 'taxadecomissao'],
  comissaoValor: ['comissaovalor', 'comissaor', 'comissaoemreais'],
  nicho: ['nicho'],
  imagem: ['imagem', 'imagemurl', 'foto', 'urldaimagem', 'image', 'imageurl'],
};

/** Endereço da foto do produto (para os criativos). Só https; o resto é ignorado. */
function imagemValida(v: string | undefined): string | null {
  if (!v) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
}

export interface ErroLinha {
  linha: number;
  motivo: string;
}

export interface ResultadoImportacao {
  dataColeta: string;
  ofertas: OfertaGravada[];
  novas: number;
  atualizadas: number;
  erros: ErroLinha[];
}

function pct(v: string | undefined, campo: string): string | null {
  const n = numeroBr(v);
  if (n === null) return null;
  if (Number.isNaN(n) || n < 0 || n > 100) throw new Error(`${campo} inválido: "${v}" (use de 0 a 100, ex.: 12 para 12%)`);
  return n.toFixed(4);
}

function dinheiro(v: string | undefined, campo: string, obrigatorio = false): string | null {
  const n = numeroBr(v);
  if (n === null) {
    if (obrigatorio) throw new Error(`${campo} vazio`);
    return null;
  }
  if (Number.isNaN(n) || n < 0) throw new Error(`${campo} inválido: "${v}"`);
  return n.toFixed(2);
}

export function lerPlanilhaOfertas(
  texto: string,
  nichoPadrao: string | null,
): { itens: { oferta: OfertaShopee; nicho: string | null; linha: number }[]; erros: ErroLinha[] } {
  const linhas = lerCsv(texto);
  const cabecalho = (linhas[0] ?? []).map((c) => normalizar(c));
  const indice: Record<string, number> = {};
  for (const [campo, nomes] of Object.entries(COLUNAS)) {
    const i = cabecalho.findIndex((c) => nomes.includes(c));
    if (i >= 0) indice[campo] = i;
  }
  const faltando = ['link', 'titulo', 'preco'].filter((c) => indice[c] === undefined);
  if (faltando.length) {
    throw new Error(`A planilha precisa das colunas: ${faltando.join(', ')}. Use o modelo docs/modelos/ofertas-shopee.csv.`);
  }

  const itens: { oferta: OfertaShopee; nicho: string | null; linha: number }[] = [];
  const erros: ErroLinha[] = [];
  const vistos = new Map<string, number>();
  linhas.slice(1).forEach((cels, i) => {
    const numLinha = i + 2; // linha 1 é o cabeçalho
    const col = (campo: string) => (indice[campo] === undefined ? undefined : cels[indice[campo]!]?.trim());
    try {
      const link = col('link') ?? '';
      let u: URL;
      try { u = new URL(link); } catch { throw new Error(`link inválido: "${link}"`); }
      if (u.protocol !== 'https:' || !/(^|\.)shopee\.com\.br$/.test(u.hostname)) {
        throw new Error(`o link não é da Shopee Brasil: "${link}"`);
      }
      const ids = extrairIdsDaUrl(link);
      if (!ids) {
        throw new Error('não achei o ID do produto no link. Use o link completo da página do produto ' +
          '(ex.: https://shopee.com.br/Nome-do-Produto-i.123.456), não o link curto.');
      }
      const titulo = col('titulo');
      if (!titulo) throw new Error('título vazio');
      const anterior = vistos.get(ids.produtoId);
      if (anterior) throw new Error(`produto repetido (já está na linha ${anterior})`);
      vistos.set(ids.produtoId, numLinha);

      const nichoTexto = col('nicho');
      const nicho = nichoTexto ? normalizar(nichoTexto) || null : nichoPadrao;
      itens.push({
        linha: numLinha,
        nicho,
        oferta: {
          produtoId: ids.produtoId,
          lojaId: ids.lojaId,
          titulo,
          urlProduto: `https://shopee.com.br/product/${ids.lojaId}/${ids.produtoId}`,
          urlOferta: null,
          imagemUrl: imagemValida(col('imagem')),
          lojaNome: null,
          preco: dinheiro(col('preco'), 'preço', true)!,
          precoMaximo: null,
          descontoPct: pct(col('desconto'), 'desconto'),
          comissaoPct: pct(col('comissao'), 'comissão'),
          comissaoValor: dinheiro(col('comissaoValor'), 'comissão em R$'),
          vendas: null,
          avaliacao: null,
          validadeInicio: null,
          validadeFim: null,
          bruto: { origem: 'planilha', linha: numLinha, link },
        },
      });
    } catch (e) {
      erros.push({ linha: numLinha, motivo: e instanceof Error ? e.message : String(e) });
    }
  });
  return { itens, erros };
}

export async function importarPlanilhaShopee(
  sql: Sql,
  cliente: Cliente,
  texto: string,
  opcoes: { nichoPadrao?: string; quando?: Date } = {},
): Promise<ResultadoImportacao> {
  const { itens, erros } = lerPlanilhaOfertas(texto, opcoes.nichoPadrao ? normalizar(opcoes.nichoPadrao) : null);
  const { ano, mes, dia } = partesLocais(opcoes.quando ?? new Date(), cliente.fusoHorario);
  const dataColeta = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  const ofertas = itens.length
    ? await gravarOfertas(sql, cliente, itens.map((i) => ({ oferta: i.oferta, nicho: i.nicho, palavraChave: null })), dataColeta)
    : [];
  const novas = ofertas.filter((o) => o.nova).length;
  log.info('ofertas.planilha_importada', { cliente: cliente.codigo, dataColeta, gravadas: ofertas.length, novas, erros: erros.length });
  return { dataColeta, ofertas, novas, atualizadas: ofertas.length - novas, erros };
}
