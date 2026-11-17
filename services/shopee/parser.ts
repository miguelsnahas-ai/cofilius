/**
 * Parser das respostas da Shopee Affiliate Open API.
 *
 * Transforma o JSON da API em tipos internos, conferindo cada campo. Nó com dado essencial
 * faltando (ID, título, link, preço) é descartado e registrado, nunca gravado pela metade.
 *
 * Dinheiro sai como texto decimal ("29.90"), para não perder centavos em ponto flutuante;
 * o Postgres guarda em numeric. Percentuais saem em pontos percentuais ("12.0000" = 12%).
 *
 * Os nomes de campo estão descritos em client.ts (com os TODO do que precisa ser conferido).
 */

export class ErroShopee extends Error {
  constructor(
    readonly codigo: number | null,
    mensagem: string,
  ) {
    super(`Shopee${codigo !== null ? ` [${codigo}]` : ''}: ${mensagem}`);
    this.name = 'ErroShopee';
  }
}

/**
 * Erros que valem nova tentativa.
 * TODO(shopee-doc): conferir a tabela de códigos de erro. Suposição: 10000 = erro de sistema,
 * 10030 = limite de chamadas. Os demais (assinatura, permissão, parâmetro) não se resolvem repetindo.
 */
export const CODIGOS_TRANSITORIOS = new Set([10000, 10030]);

export interface OfertaShopee {
  produtoId: string;
  lojaId: string | null;
  titulo: string;
  urlProduto: string;
  urlOferta: string | null;
  imagemUrl: string | null;
  lojaNome: string | null;
  preco: string;
  precoMaximo: string | null;
  descontoPct: string | null;
  comissaoPct: string | null;
  comissaoValor: string | null;
  vendas: number | null;
  avaliacao: string | null;
  validadeInicio: Date | null;
  validadeFim: Date | null;
  bruto: Record<string, unknown>;
}

export interface PaginaOfertas {
  ofertas: OfertaShopee[];
  pagina: { page: number; limit: number; hasNextPage: boolean };
  descartadas: { indice: number; motivo: string }[];
}

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lê o texto da resposta, lança ErroShopee se vier "errors", devolve "data". */
export function interpretarResposta(texto: string): Obj {
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new ErroShopee(null, `resposta não é JSON: ${texto.slice(0, 200)}`);
  }
  if (!ehObj(json)) throw new ErroShopee(null, 'resposta em formato inesperado');
  const erros = json.errors;
  if (Array.isArray(erros) && erros.length > 0) {
    const e = ehObj(erros[0]) ? erros[0] : {};
    const ext = ehObj(e.extensions) ? e.extensions : {};
    const codigo = typeof ext.code === 'number' ? ext.code : Number.isFinite(Number(ext.code)) ? Number(ext.code) : null;
    const msg = String(ext.message ?? e.message ?? 'erro desconhecido');
    throw new ErroShopee(codigo, msg);
  }
  if (!ehObj(json.data)) throw new ErroShopee(null, 'resposta sem "data"');
  return json.data;
}

export function erroShopeeTransitorio(erro: unknown): boolean {
  return erro instanceof ErroShopee && erro.codigo !== null && CODIGOS_TRANSITORIOS.has(erro.codigo);
}

// ---------- conversões de campo ----------

function texto(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** ID numérico pode vir como número ou texto. Número acima do seguro do JS é recusado. */
function id(v: unknown): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return v.trim();
  return null;
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Valor em reais, como texto com 2 casas. */
function dinheiro(v: unknown): string | null {
  const n = numero(v);
  return n === null || n < 0 ? null : n.toFixed(2);
}

/**
 * commissionRate vem como fração (0.12 = 12%).
 * TODO(shopee-doc): confirmar se é fração ou já percentual.
 */
function fracaoParaPct(v: unknown): string | null {
  const n = numero(v);
  if (n === null || n < 0 || n > 1) return null;
  return (n * 100).toFixed(4);
}

/** priceDiscountRate vem como inteiro em pontos percentuais (25 = 25%). TODO(shopee-doc): confirmar. */
function pct(v: unknown): string | null {
  const n = numero(v);
  if (n === null || n < 0 || n > 100) return null;
  return n.toFixed(4);
}

function url(v: unknown): string | null {
  const s = texto(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : null;
  } catch {
    return null;
  }
}

/** Timestamp Unix em segundos; 0 ou ausente = sem data. */
function data(v: unknown): Date | null {
  const n = numero(v);
  return n && n > 0 ? new Date(n * 1000) : null;
}

function inteiro(v: unknown): number | null {
  const n = numero(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

function avaliacao(v: unknown): string | null {
  const n = numero(v);
  return n === null || n < 0 || n > 5 ? null : n.toFixed(2);
}

// ---------- operações ----------

export function parsearOferta(no: unknown): OfertaShopee | string {
  if (!ehObj(no)) return 'nó não é objeto';
  const produtoId = id(no.itemId);
  if (!produtoId) return 'sem itemId válido';
  const titulo = texto(no.productName);
  if (!titulo) return 'sem productName';
  const urlProduto = url(no.productLink);
  if (!urlProduto) return 'sem productLink válido';
  const preco = dinheiro(no.priceMin ?? no.price);
  if (!preco) return 'sem preço (priceMin)';

  return {
    produtoId,
    lojaId: id(no.shopId),
    titulo,
    urlProduto,
    urlOferta: url(no.offerLink),
    imagemUrl: url(no.imageUrl),
    lojaNome: texto(no.shopName),
    preco,
    precoMaximo: dinheiro(no.priceMax),
    descontoPct: pct(no.priceDiscountRate),
    comissaoPct: fracaoParaPct(no.commissionRate),
    comissaoValor: dinheiro(no.commission),
    vendas: inteiro(no.sales),
    avaliacao: avaliacao(no.ratingStar),
    validadeInicio: data(no.periodStartTime),
    validadeFim: data(no.periodEndTime),
    bruto: no,
  };
}

export function parsearOfertas(dados: Obj): PaginaOfertas {
  const raiz = dados.productOfferV2;
  if (!ehObj(raiz)) throw new ErroShopee(null, 'resposta sem productOfferV2');
  const nos = Array.isArray(raiz.nodes) ? raiz.nodes : [];
  const info = ehObj(raiz.pageInfo) ? raiz.pageInfo : {};
  const ofertas: OfertaShopee[] = [];
  const descartadas: { indice: number; motivo: string }[] = [];
  nos.forEach((no, indice) => {
    const r = parsearOferta(no);
    if (typeof r === 'string') descartadas.push({ indice, motivo: r });
    else ofertas.push(r);
  });
  return {
    ofertas,
    descartadas,
    pagina: {
      page: inteiro(info.page) ?? 1,
      limit: inteiro(info.limit) ?? nos.length,
      hasNextPage: info.hasNextPage === true,
    },
  };
}

export function parsearLinkCurto(dados: Obj): string {
  const raiz = dados.generateShortLink;
  if (!ehObj(raiz)) throw new ErroShopee(null, 'resposta sem generateShortLink');
  const link = url(raiz.shortLink);
  if (!link || !link.startsWith('https://')) throw new ErroShopee(null, `shortLink inválido: ${String(raiz.shortLink)}`);
  return link;
}

/**
 * Extrai o ID do produto de uma URL da Shopee. Formatos conhecidos:
 *   https://shopee.com.br/Nome-do-Produto-i.<shopId>.<itemId>
 *   https://shopee.com.br/product/<shopId>/<itemId>
 * Link curto (s.shopee.com.br/...) não tem o ID: devolve null.
 */
export function extrairIdsDaUrl(endereco: string): { lojaId: string; produtoId: string } | null {
  let u: URL;
  try {
    u = new URL(endereco);
  } catch {
    return null;
  }
  if (!/(^|\.)shopee\.com\.br$/.test(u.hostname)) return null;
  const m = u.pathname.match(/-i\.(\d+)\.(\d+)\/?$/) ?? u.pathname.match(/^\/product\/(\d+)\/(\d+)\/?$/);
  return m ? { lojaId: m[1]!, produtoId: m[2]! } : null;
}
