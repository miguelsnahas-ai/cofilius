/**
 * Cliente da Shopee Affiliate Open API (Brasil).
 *
 * TUDO o que depende do formato da API da Shopee está neste arquivo e em parser.ts.
 * A documentação disponível é parcial. Cada suposição está marcada com TODO(shopee-doc):
 * confira na documentação oficial (painel de afiliados > Open API > documentação) antes de
 * confiar no resultado. Resumo dos pontos a conferir: veja o README, seção "TODO".
 *
 * Toda chamada tem timeout, até 3 novas tentativas com espera crescente e log (harness/retentativa.ts).
 * A assinatura é refeita a cada tentativa, porque leva o horário.
 */
import { sha256Hex } from '../../harness/cripto.ts';
import { log } from '../../harness/log.ts';
import { comRetentativa, erroTransitorio, postComTimeout, type OpcoesRetentativa } from '../../harness/retentativa.ts';
import {
  erroShopeeTransitorio,
  interpretarResposta,
  parsearLinkCurto,
  parsearOfertas,
  type PaginaOfertas,
} from './parser.ts';

/** Endpoint do Brasil (informado pelo operador). */
export const ENDPOINT_BRASIL = 'https://open-api.affiliate.shopee.com.br/graphql';

export interface CredenciaisShopee {
  appId: string;
  secret: string;
}

export interface OpcoesCliente {
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Relógio substituível nos testes. Devolve segundos Unix. */
  agora?: () => number;
  esperar?: OpcoesRetentativa['esperar'];
  /** Chamado com o texto bruto de cada resposta (usado pelo --gravar do comando de teste). */
  aoResponder?: (operacao: string, texto: string) => void | Promise<void>;
}

/**
 * Assinatura da requisição.
 *
 * TODO(shopee-doc): conferir o formato. Suposição, conforme a documentação parcial:
 *   Signature = SHA256(AppId + Timestamp + Payload + Secret), em hexadecimal minúsculo
 *   Payload   = o corpo da requisição exatamente como enviado (JSON em texto)
 *   Timestamp = segundos Unix (não milissegundos)
 *   Cabeçalho: "Authorization: SHA256 Credential=<AppId>, Timestamp=<Timestamp>, Signature=<Signature>"
 */
export async function montarAutorizacao(
  cred: CredenciaisShopee,
  corpo: string,
  timestamp: number,
): Promise<string> {
  const assinatura = await sha256Hex(`${cred.appId}${timestamp}${corpo}${cred.secret}`);
  return `SHA256 Credential=${cred.appId}, Timestamp=${timestamp}, Signature=${assinatura}`;
}

/** Texto como literal GraphQL. Strings JSON são literais GraphQL válidos. */
const lit = (s: string) => JSON.stringify(s);

export interface BuscaOfertas {
  palavraChave: string;
  pagina?: number;
  /** Itens por página. TODO(shopee-doc): conferir o máximo permitido (suposição: 50). */
  limite?: number;
  /**
   * Ordenação. Se omitida, vale o padrão da API.
   * TODO(shopee-doc): conferir os valores. Suposição: 1 relevância, 2 mais vendidos,
   * 3 maior preço, 4 menor preço, 5 maior comissão.
   */
  ordenacao?: number;
}

export const LIMITE_MAXIMO_POR_PAGINA = 50;

/**
 * Consulta productOfferV2.
 * TODO(shopee-doc): conferir nomes dos argumentos (keyword, sortType, page, limit) e dos
 * campos pedidos abaixo. Campo inexistente faz a API recusar a consulta inteira.
 */
export function consultaOfertas(b: BuscaOfertas): string {
  const args = [
    `keyword: ${lit(b.palavraChave)}`,
    b.ordenacao !== undefined ? `sortType: ${Math.trunc(b.ordenacao)}` : null,
    `page: ${Math.max(1, Math.trunc(b.pagina ?? 1))}`,
    `limit: ${Math.min(LIMITE_MAXIMO_POR_PAGINA, Math.max(1, Math.trunc(b.limite ?? 10)))}`,
  ].filter(Boolean);
  return `{ productOfferV2(${args.join(', ')}) {
    nodes {
      itemId shopId productName productLink offerLink imageUrl shopName
      priceMin priceMax priceDiscountRate commissionRate commission
      sales ratingStar periodStartTime periodEndTime
    }
    pageInfo { page limit hasNextPage }
  } }`;
}

/**
 * Mutação generateShortLink.
 * TODO(shopee-doc): conferir o formato do input (originUrl, subIds) e se subIds aceita
 * exatamente 5 itens, com quais caracteres e tamanho.
 */
export function mutacaoLinkCurto(urlOrigem: string, subIds: readonly string[]): string {
  return `mutation { generateShortLink(input: { originUrl: ${lit(urlOrigem)}, subIds: [${subIds.map(lit).join(', ')}] }) { shortLink } }`;
}

export function criarClienteShopee(cred: CredenciaisShopee, opcoes: OpcoesCliente = {}) {
  if (!cred.appId || !cred.secret) throw new Error('Credenciais da Shopee incompletas (App ID e Secret).');
  const endpoint = opcoes.endpoint ?? ENDPOINT_BRASIL;
  const agora = opcoes.agora ?? (() => Math.floor(Date.now() / 1000));

  async function chamar(operacao: string, query: string): Promise<Record<string, unknown>> {
    // TODO(shopee-doc): conferir se o corpo é {"query": "..."} e se aceita "variables".
    // Por segurança, os valores vão como literais dentro da própria consulta.
    const corpo = JSON.stringify({ query });
    return comRetentativa(
      async (tentativa) => {
        const headers = {
          'Content-Type': 'application/json',
          Authorization: await montarAutorizacao(cred, corpo, agora()),
        };
        log.info('shopee.chamada', { operacao, tentativa });
        const texto = await postComTimeout(endpoint, corpo, headers, {
          timeoutMs: opcoes.timeoutMs ?? 15_000,
          fetch: opcoes.fetch,
        });
        await opcoes.aoResponder?.(operacao, texto);
        return interpretarResposta(texto);
      },
      {
        operacao: `shopee.${operacao}`,
        esperar: opcoes.esperar,
        deveTentarDeNovo: (e) => erroTransitorio(e) || erroShopeeTransitorio(e),
      },
    );
  }

  return {
    async buscarOfertas(busca: BuscaOfertas): Promise<PaginaOfertas> {
      const pagina = parsearOfertas(await chamar('productOfferV2', consultaOfertas(busca)));
      if (pagina.descartadas.length) log.warn('shopee.ofertas_descartadas', { descartadas: pagina.descartadas });
      return pagina;
    },

    async gerarLinkCurto(urlOrigem: string, subIds: readonly string[]): Promise<string> {
      return parsearLinkCurto(await chamar('generateShortLink', mutacaoLinkCurto(urlOrigem, subIds)));
    },
  };
}

export type ClienteShopee = ReturnType<typeof criarClienteShopee>;
