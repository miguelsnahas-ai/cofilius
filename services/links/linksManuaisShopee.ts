/**
 * Links e rastreio · Shopee · modo manual (sem a Open API).
 *
 * 1. prepararLinks: para cada oferta, mostra os 5 sub_ids que devem ser digitados no painel de afiliados.
 * 2. A pessoa gera o link no painel (tela de link personalizado) com esses sub_ids.
 * 3. registrarLinkManual: grava o link gerado em `links`, com os mesmos sub_ids (recalculados a partir
 *    da mesma oferta e do mesmo horário), pelo mesmo caminho do modo com API.
 *
 * Limite deste modo: o sistema não consegue ver se os sub_ids foram digitados certo no painel
 * (o link curto não mostra). A conferência vem do relatório de conversões, que traz os sub_ids das vendas.
 */
import type { Sql } from '../../harness/db.ts';
import type { Cliente } from '../../db/clientes.ts';
import { gerarEtiquetas, partesLocais, type SubIdsShopee } from '../etiquetas/etiquetas.ts';
import { gerarLinkShopee, type LinkGravado } from './gerarLinkShopee.ts';

export interface LinkParaPreparar {
  ofertaId: string;
  produtoId: string;
  titulo: string;
  preco: string;
  urlProduto: string;
  subIds: SubIdsShopee;
  /** Horário da postagem usado nos sub_ids, no formato aceito por --quando. */
  quando: string;
  /** Links já registrados para esta oferta. */
  linksExistentes: number;
}

const HOSTS_LINK_SHOPEE = new Set(['s.shopee.com.br', 'shope.ee', 'shopee.com.br']);

/** Confere o link colado do painel: https e domínio da Shopee. */
export function validarLinkDoPainel(link: string): string {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    throw new Error(`Link inválido: "${link}"`);
  }
  if (u.protocol !== 'https:' || !HOSTS_LINK_SHOPEE.has(u.hostname)) {
    throw new Error(`Isso não parece um link de afiliado da Shopee (esperado https://s.shopee.com.br/...): "${link}"`);
  }
  return u.toString();
}

function textoLocal(quando: Date, fuso: string): string {
  const p = partesLocais(quando, fuso);
  const d = (n: number) => String(n).padStart(2, '0');
  return `${p.ano}-${d(p.mes)}-${d(p.dia)} ${d(p.hora)}:${d(p.minuto)}`;
}

export async function prepararLinks(
  sql: Sql,
  cliente: Cliente,
  opcoes: { quando: Date; canal?: string; ofertaIds?: string[]; dataColeta?: string },
): Promise<LinkParaPreparar[]> {
  const canal = opcoes.canal ?? 'wa';
  const ofertas = opcoes.ofertaIds?.length
    ? await sql`
        select o.id, o.produto_id, o.titulo, o.preco::text, o.url_produto, o.nicho,
               (select count(*)::int from links l where l.cliente_id = o.cliente_id and l.oferta_id = o.id) as links
        from ofertas o
        where o.cliente_id = ${cliente.clienteId} and o.plataforma = 'shopee' and o.id in ${sql(opcoes.ofertaIds)}
        order by o.criado_em`
    : await sql`
        select o.id, o.produto_id, o.titulo, o.preco::text, o.url_produto, o.nicho,
               (select count(*)::int from links l where l.cliente_id = o.cliente_id and l.oferta_id = o.id) as links
        from ofertas o
        where o.cliente_id = ${cliente.clienteId} and o.plataforma = 'shopee'
          and o.data_coleta = ${opcoes.dataColeta ?? textoLocal(opcoes.quando, cliente.fusoHorario).slice(0, 10)}
        order by o.criado_em`;
  if (opcoes.ofertaIds?.length && ofertas.length !== opcoes.ofertaIds.length) {
    throw new Error('Alguma oferta informada não existe para este cliente.');
  }
  return ofertas.map((o) => ({
    ofertaId: o.id,
    produtoId: o.produto_id,
    titulo: o.titulo,
    preco: o.preco,
    urlProduto: o.url_produto,
    linksExistentes: o.links,
    quando: textoLocal(opcoes.quando, cliente.fusoHorario),
    subIds: gerarEtiquetas({
      cliente: { codigo: cliente.codigo },
      canal,
      quando: opcoes.quando,
      fusoHorario: cliente.fusoHorario,
      nicho: o.nicho ?? 'geral',
      oferta: { produtoId: o.produto_id },
    }).shopee.subIds,
  }));
}

export async function registrarLinkManual(
  sql: Sql,
  entrada: { cliente: Cliente; link: string; quando: Date; ofertaId?: string; url?: string; canal?: string; nicho?: string },
): Promise<LinkGravado> {
  const link = validarLinkDoPainel(entrada.link);
  const [existente] = await sql`
    select id from links where cliente_id = ${entrada.cliente.clienteId} and url_afiliado = ${link}`;
  if (existente) throw new Error(`Este link já foi registrado (id ${existente.id}).`);
  return gerarLinkShopee(
    { sql, shopee: { gerarLinkCurto: async () => link } },
    {
      cliente: entrada.cliente,
      ofertaId: entrada.ofertaId,
      url: entrada.url,
      canal: entrada.canal,
      nicho: entrada.nicho,
      quando: entrada.quando,
      contexto: { origem: 'painel' },
    },
  );
}
