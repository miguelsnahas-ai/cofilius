/**
 * Links e rastreio · Shopee.
 *
 * Recebe uma URL de produto (ou uma oferta já gravada) + cliente + contexto, monta os sub_ids
 * pelo padrão de etiquetas, chama generateShortLink, grava em `links` e devolve o link lido do banco.
 */
import { conectarTransacao, type Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import type { Cliente } from '../../db/clientes.ts';
import { gerarEtiquetas, type SubIdsShopee } from '../etiquetas/etiquetas.ts';
import type { ClienteShopee } from '../shopee/client.ts';
import { extrairIdsDaUrl } from '../shopee/parser.ts';

export interface EntradaLink {
  cliente: Cliente;
  /** URL do produto na Shopee. Obrigatória se não houver ofertaId. */
  url?: string;
  /** Oferta gravada em `ofertas`: usa a URL e o produto dela. */
  ofertaId?: string;
  /** Padrão: "wa". */
  canal?: string;
  nicho?: string;
  /** Momento da postagem (vai para data e horário nos sub_ids). Padrão: agora. */
  quando?: Date;
  /** Dados livres sobre o pedido do link (quem pediu, por quê). */
  contexto?: Record<string, unknown>;
}

export interface LinkGravado {
  id: string;
  urlAfiliado: string;
  urlOrigem: string;
  subIds: SubIdsShopee;
  chaveRastreio: string;
  ofertaId: string | null;
  produtoId: string | null;
}

const DOMINIOS_SHOPEE = /(^|\.)shopee\.com\.br$/;

export function validarUrlShopee(endereco: string): string {
  let u: URL;
  try {
    u = new URL(endereco.trim());
  } catch {
    throw new Error(`URL inválida: ${endereco}`);
  }
  if (u.protocol !== 'https:' || !DOMINIOS_SHOPEE.test(u.hostname)) {
    throw new Error(`A URL não é da Shopee Brasil (https://shopee.com.br/...): ${endereco}`);
  }
  return u.toString();
}

export async function gerarLinkShopee(
  deps: { sql: Sql; shopee: Pick<ClienteShopee, 'gerarLinkCurto'> },
  entrada: EntradaLink,
): Promise<LinkGravado> {
  const { sql } = deps;
  const clienteId = entrada.cliente.clienteId;
  let urlOrigem: string;
  let produtoId: string | null;
  let ofertaId: string | null = null;
  let nicho = entrada.nicho ?? null;

  if (entrada.ofertaId) {
    const [o] = await sql`
      select id, produto_id, url_produto, nicho from ofertas
      where cliente_id = ${clienteId} and id = ${entrada.ofertaId} and plataforma = 'shopee'`;
    if (!o) throw new Error(`Oferta ${entrada.ofertaId} não encontrada para este cliente.`);
    ofertaId = o.id;
    produtoId = o.produto_id;
    urlOrigem = validarUrlShopee(entrada.url ?? o.url_produto);
    nicho ??= o.nicho;
  } else {
    if (!entrada.url) throw new Error('Informe a URL do produto ou o ID da oferta.');
    urlOrigem = validarUrlShopee(entrada.url);
    produtoId = extrairIdsDaUrl(urlOrigem)?.produtoId ?? null;
    if (produtoId) {
      // Se o produto já foi coletado, liga o link à oferta mais recente dele.
      const [o] = await sql`
        select id, nicho from ofertas
        where cliente_id = ${clienteId} and plataforma = 'shopee' and produto_id = ${produtoId}
        order by data_coleta desc limit 1`;
      if (o) {
        ofertaId = o.id;
        nicho ??= o.nicho;
      }
    }
  }

  const canal = entrada.canal ?? 'wa';
  const etiquetas = gerarEtiquetas({
    cliente: { codigo: entrada.cliente.codigo },
    canal,
    quando: entrada.quando ?? new Date(),
    fusoHorario: entrada.cliente.fusoHorario,
    nicho: nicho ?? 'geral', // o nicho não entra nos sub_ids da Shopee
    oferta: { produtoId },
  });
  const { subIds, chave } = etiquetas.shopee;

  const linkCurto = await deps.shopee.gerarLinkCurto(urlOrigem, subIds);

  const [linha] = await conectarTransacao(sql, 'links.gravar', (tx) => tx`
    insert into links (cliente_id, oferta_id, plataforma, url_origem, url_afiliado, sub_ids, chave_rastreio,
                       canal, nicho, produto_id, contexto)
    values (${clienteId}, ${ofertaId}, 'shopee', ${urlOrigem}, ${linkCurto}, ${subIds as unknown as string[]},
            ${chave}, ${canal}, ${nicho}, ${produtoId}, ${tx.json((entrada.contexto ?? {}) as never)})
    returning id, url_afiliado, url_origem, sub_ids, chave_rastreio, oferta_id, produto_id`).catch((erro) => {
    // O link já existe na Shopee: registra para não se perder.
    log.error('links.nao_gravado', { cliente: entrada.cliente.codigo, linkCurto, urlOrigem, chave });
    throw erro;
  });

  log.info('links.gerado', { cliente: entrada.cliente.codigo, linkId: linha!.id, chave });
  return {
    id: linha!.id,
    urlAfiliado: linha!.url_afiliado,
    urlOrigem: linha!.url_origem,
    subIds: linha!.sub_ids as SubIdsShopee,
    chaveRastreio: linha!.chave_rastreio,
    ofertaId: linha!.oferta_id,
    produtoId: linha!.produto_id,
  };
}
