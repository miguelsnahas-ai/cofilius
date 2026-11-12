/**
 * Conector de ofertas · Shopee.
 *
 * Busca candidatas por palavra-chave do nicho (productOfferV2) e grava em `ofertas` sem duplicar:
 * uma linha por cliente + produto + dia de coleta. Coletar de novo no mesmo dia atualiza preço,
 * desconto e comissão; em outro dia cria outra linha (histórico de preço).
 *
 * O que sai daqui vem do banco (RETURNING), não da resposta da API: é o mesmo dado que a esteira usa depois.
 */
import { conectarTransacao, type Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import { acharNicho, type Cliente } from '../../db/clientes.ts';
import { partesLocais } from '../etiquetas/etiquetas.ts';
import type { ClienteShopee } from '../shopee/client.ts';
import type { OfertaShopee } from '../shopee/parser.ts';

export interface EntradaColeta {
  cliente: Cliente;
  nicho: string;
  /** Se omitidas, usa as palavras-chave do nicho no cadastro do cliente; sem cadastro, o próprio nicho. */
  palavrasChave?: string[];
  /** Quantas ofertas distintas coletar. Padrão: 10. */
  limite?: number;
  ordenacao?: number;
  /** Momento da coleta (define data_coleta no fuso do cliente). Padrão: agora. */
  quando?: Date;
  /** Páginas no máximo por palavra-chave. Padrão: 5. */
  maxPaginas?: number;
}

export interface OfertaGravada {
  id: string;
  produtoId: string;
  titulo: string;
  preco: string;
  descontoPct: string | null;
  comissaoPct: string | null;
  comissaoValor: string | null;
  urlProduto: string;
  palavraChave: string | null;
  nova: boolean;
}

export interface ResultadoColeta {
  dataColeta: string;
  ofertas: OfertaGravada[];
  novas: number;
  atualizadas: number;
  descartadas: number;
}

export function palavrasDoNicho(cliente: Cliente, nicho: string, informadas?: string[]): string[] {
  const limpas = (l: string[] | undefined) => (l ?? []).map((p) => p.trim()).filter(Boolean);
  const daEntrada = limpas(informadas);
  if (daEntrada.length) return daEntrada;
  const doCadastro = limpas(acharNicho(cliente, nicho)?.palavras_chave);
  return doCadastro.length ? doCadastro : [nicho];
}

export async function coletarOfertasShopee(
  deps: { sql: Sql; shopee: Pick<ClienteShopee, 'buscarOfertas'> },
  entrada: EntradaColeta,
): Promise<ResultadoColeta> {
  const limite = Math.max(1, entrada.limite ?? 10);
  const maxPaginas = entrada.maxPaginas ?? 5;
  const palavras = palavrasDoNicho(entrada.cliente, entrada.nicho, entrada.palavrasChave);
  const { ano, mes, dia } = partesLocais(entrada.quando ?? new Date(), entrada.cliente.fusoHorario);
  const dataColeta = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

  // Coleta: percorre as palavras-chave em rodízio, página a página, até juntar `limite` produtos distintos.
  const coletadas = new Map<string, { oferta: OfertaShopee; palavra: string }>();
  let descartadas = 0;
  const estado = palavras.map((palavra) => ({ palavra, pagina: 1, acabou: false }));
  while (coletadas.size < limite && estado.some((e) => !e.acabou)) {
    for (const e of estado) {
      if (e.acabou || coletadas.size >= limite) continue;
      const r = await deps.shopee.buscarOfertas({
        palavraChave: e.palavra,
        pagina: e.pagina,
        limite: Math.min(50, limite),
        ordenacao: entrada.ordenacao,
      });
      descartadas += r.descartadas.length;
      for (const o of r.ofertas) {
        if (coletadas.size >= limite) break;
        if (!coletadas.has(o.produtoId)) coletadas.set(o.produtoId, { oferta: o, palavra: e.palavra });
      }
      e.pagina++;
      if (!r.pagina.hasNextPage || r.ofertas.length === 0 || e.pagina > maxPaginas) e.acabou = true;
    }
  }

  const itens = [...coletadas.values()].map(({ oferta, palavra }) => ({ oferta, nicho: entrada.nicho, palavraChave: palavra }));
  const gravadas = await gravarOfertas(deps.sql, entrada.cliente, itens, dataColeta);

  const novas = gravadas.filter((g) => g.nova).length;
  log.info('ofertas.coletadas', {
    cliente: entrada.cliente.codigo, nicho: entrada.nicho, dataColeta, total: gravadas.length, novas, descartadas,
  });
  return { dataColeta, ofertas: gravadas, novas, atualizadas: gravadas.length - novas, descartadas };
}

export interface ItemParaGravar {
  oferta: OfertaShopee;
  nicho: string | null;
  palavraChave: string | null;
}

/**
 * Grava ofertas da Shopee sem duplicar (uma linha por cliente + produto + dia de coleta).
 * Usada pela coleta via API e pela importação de planilha.
 */
export async function gravarOfertas(
  sql: Sql, cliente: Cliente, itens: ItemParaGravar[], dataColeta: string,
): Promise<OfertaGravada[]> {
  const clienteId = cliente.clienteId;
  return conectarTransacao(sql, 'ofertas.gravar', async (tx) => {
    const saida: OfertaGravada[] = [];
    for (const { oferta: o, nicho, palavraChave: palavra } of itens) {
      const [linha] = await tx`
        insert into ofertas (
          cliente_id, plataforma, produto_id, loja_id, nicho, palavra_chave, titulo, url_produto, url_oferta,
          imagem_url, loja_nome, preco, preco_maximo, desconto_pct, comissao_pct, comissao_valor, vendas,
          avaliacao, validade_inicio, validade_fim, data_coleta, dados_brutos
        ) values (
          ${clienteId}, 'shopee', ${o.produtoId}, ${o.lojaId}, ${nicho}, ${palavra}, ${o.titulo},
          ${o.urlProduto}, ${o.urlOferta}, ${o.imagemUrl}, ${o.lojaNome}, ${o.preco}, ${o.precoMaximo},
          ${o.descontoPct}, ${o.comissaoPct}, ${o.comissaoValor}, ${o.vendas}, ${o.avaliacao},
          ${o.validadeInicio}, ${o.validadeFim}, ${dataColeta}, ${tx.json(o.bruto as never)}
        )
        on conflict (cliente_id, plataforma, produto_id, data_coleta) do update set
          -- Campo vazio na nova coleta (ex.: planilha sem imagem) mantém o valor anterior.
          titulo = excluded.titulo, url_produto = excluded.url_produto, preco = excluded.preco,
          loja_id = coalesce(excluded.loja_id, ofertas.loja_id),
          url_oferta = coalesce(excluded.url_oferta, ofertas.url_oferta),
          imagem_url = coalesce(excluded.imagem_url, ofertas.imagem_url),
          loja_nome = coalesce(excluded.loja_nome, ofertas.loja_nome),
          preco_maximo = coalesce(excluded.preco_maximo, ofertas.preco_maximo),
          desconto_pct = coalesce(excluded.desconto_pct, ofertas.desconto_pct),
          comissao_pct = coalesce(excluded.comissao_pct, ofertas.comissao_pct),
          comissao_valor = coalesce(excluded.comissao_valor, ofertas.comissao_valor),
          vendas = coalesce(excluded.vendas, ofertas.vendas),
          avaliacao = coalesce(excluded.avaliacao, ofertas.avaliacao),
          validade_inicio = coalesce(excluded.validade_inicio, ofertas.validade_inicio),
          validade_fim = coalesce(excluded.validade_fim, ofertas.validade_fim),
          palavra_chave = coalesce(excluded.palavra_chave, ofertas.palavra_chave),
          nicho = coalesce(excluded.nicho, ofertas.nicho),
          dados_brutos = ofertas.dados_brutos || excluded.dados_brutos
        returning id, produto_id, titulo, preco::text, desconto_pct::text, comissao_pct::text,
                  comissao_valor::text, url_produto, palavra_chave, (xmax = 0) as nova`;
      saida.push({
        id: linha!.id,
        produtoId: linha!.produto_id,
        titulo: linha!.titulo,
        preco: linha!.preco,
        descontoPct: linha!.desconto_pct,
        comissaoPct: linha!.comissao_pct,
        comissaoValor: linha!.comissao_valor,
        urlProduto: linha!.url_produto,
        palavraChave: linha!.palavra_chave,
        nova: linha!.nova,
      });
    }
    return saida;
  });
}
