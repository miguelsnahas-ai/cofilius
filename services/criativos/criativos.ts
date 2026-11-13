/**
 * Criativos de Instagram (carrossel, stories, reels) de uma oferta.
 *
 * O agente Criativo escreve o roteiro com marcadores; nada de preço, desconto ou link escritos por ele.
 * Na hora de mostrar, o código preenche os marcadores com os valores ATUAIS do banco e devolve também
 * preço, desconto, link e foto à parte, para o painel desenhar as imagens e o vídeo.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import { carregarContrato, executarAgente, type ContratoAgente, type ModeloIA, type PrecoModelo } from '../../harness/agentes.ts';
import type { Cliente } from '../../db/clientes.ts';
import { regrasCriativo, type EntradaCriativo, type FormatoCriativo, type SaidaCriativo } from '../../agents/criativo/regras.ts';
import { formatarDesconto, formatarPreco, preencherMensagem } from '../lista/marcadores.ts';
import { aplicarConformidade, lerConformidade } from '../conformidade/regras.ts';
import { prepararLinks, registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { gerarLinkShopee } from '../links/gerarLinkShopee.ts';
import type { ClienteShopee } from '../shopee/client.ts';

/** Canal dos criativos nos sub_ids e em links.canal: o Instagram mede separado do WhatsApp ("wa"). */
export const CANAL_INSTAGRAM = 'ig';

const PASTA = join(dirname(fileURLToPath(import.meta.url)), '../../agents/criativo');

export const FORMATOS: FormatoCriativo[] = ['carrossel', 'stories', 'reels'];
/** Telas (ou cenas) que o agente escreve, além da capa/gancho e da tela final de preço e chamada. */
export const TELAS_POR_FORMATO: Record<FormatoCriativo, number> = { carrossel: 4, stories: 2, reels: 4 };

export async function contratoCriativo(ambiente: Record<string, string | undefined> = process.env): Promise<ContratoAgente<EntradaCriativo, SaidaCriativo>> {
  return carregarContrato(PASTA, regrasCriativo, ambiente);
}

export async function montarEntradaCriativo(sql: Sql, cliente: Cliente, ofertaId: string, formato: FormatoCriativo): Promise<EntradaCriativo> {
  const [o] = await sql`
    select o.titulo, o.nicho, o.desconto_pct, c.tom_grupo
    from ofertas o join clientes c on c.cliente_id = o.cliente_id
    where o.cliente_id = ${cliente.clienteId} and o.id = ${ofertaId}`;
  if (!o) throw new Error('Oferta não encontrada para este cliente.');
  return {
    formato,
    oferta: { titulo: o.titulo.slice(0, 300), nicho: o.nicho ?? 'geral', tem_desconto: o.desconto_pct !== null && Number(o.desconto_pct) > 0 },
    tom: (o.tom_grupo ?? '').slice(0, 500),
    telas: TELAS_POR_FORMATO[formato],
  };
}

export interface CriativoPronto {
  id: string;
  formato: FormatoCriativo;
  estado: string;
  ofertaId: string;
  titulo: string;
  plataforma: string;
  /** Roteiro com os valores atuais (preço e desconto já preenchidos). */
  roteiro: SaidaCriativo;
  preco: string;
  desconto: string | null;
  link: string | null;
  imagemUrl: string | null;
  precoConferidoEm: string | null;
  criadoEm: string;
  /** Sem link próprio do Instagram ainda (Shopee, modo manual): sub_ids para gerar no painel da Shopee. */
  preparoLink: { subIds: string[]; quando: string; urlProduto: string } | null;
  /** O que o link do criativo gerou (só depois de ter link próprio). */
  desempenho: { cliques: number; pedidos: number; comissao: number } | null;
}

function preencherRoteiro(r: SaidaCriativo, preco: string, desconto: string | null, p: { plataforma: string; conformidade: unknown }): SaidaCriativo {
  const f = (t: string) => preencherMensagem(t, { preco, desconto, link: 'https://x' }, { exigirLink: false, proibirLink: true });
  // A legenda é o texto publicado: leva a identificação de publicidade no começo e, na Amazon, o aviso
  // de preço e a declaração de Associado. O preço sempre aparece na tela final, por isso temPreco.
  const legenda = aplicarConformidade(f(r.legenda), {
    plataforma: p.plataforma, identificacao: lerConformidade(p.conformidade).identificacao, temPreco: true,
  });
  return { gancho: f(r.gancho), telas: r.telas.map((t) => ({ titulo: f(t.titulo), texto: f(t.texto) })), cta: f(r.cta), legenda };
}

/** Gera o roteiro com a IA e grava o criativo (rascunho). */
export async function criarCriativo(
  sql: Sql,
  p: { cliente: Cliente; ofertaId: string; formato: FormatoCriativo; dataLista: string; modelo: ModeloIA; precos?: Record<string, PrecoModelo>; contrato?: ContratoAgente<EntradaCriativo, SaidaCriativo> },
): Promise<string> {
  if (!FORMATOS.includes(p.formato)) throw new Error(`Formato desconhecido: ${p.formato}`);
  const entrada = await montarEntradaCriativo(sql, p.cliente, p.ofertaId, p.formato);
  const r = await executarAgente(sql, {
    contrato: p.contrato ?? (await contratoCriativo()), clienteId: p.cliente.clienteId, entrada, modelo: p.modelo, precos: p.precos,
  });
  // Sem link: o criativo ganha um link próprio do Instagram (canal "ig"), nunca o do WhatsApp.
  const [c] = await sql`
    insert into criativos (cliente_id, oferta_id, formato, roteiro, data_lista)
    values (${p.cliente.clienteId}, ${p.ofertaId}, ${p.formato}, ${sql.json(r.saida as never)}, ${p.dataLista})
    returning id`;
  log.info('criativo.criado', { cliente: p.cliente.codigo, formato: p.formato, criativo: c!.id });
  return c!.id;
}

/** Criativos do dia (menos os descartados), com os valores atuais do banco. */
export async function criativosDoDia(sql: Sql, cliente: Cliente, dataLista: string): Promise<CriativoPronto[]> {
  const linhas = await sql`
    select k.id, k.formato, k.estado, k.oferta_id, k.roteiro, k.criado_em, o.titulo, o.plataforma, o.preco::text as preco,
           o.desconto_pct::text as desconto, o.imagem_url, o.preco_conferido_em, c.conformidade, o.url_produto,
           l.url_afiliado as link, k.link_id,
           coalesce((select sum(q.cliques) from cliques q where q.cliente_id = k.cliente_id and q.link_id = k.link_id), 0)::int as cliques,
           (select count(distinct v.pedido_id) from vendas v
             where v.cliente_id = k.cliente_id and v.link_id = k.link_id and v.situacao <> 'cancelada')::int as pedidos,
           coalesce((select sum(v.comissao) from vendas v
             where v.cliente_id = k.cliente_id and v.link_id = k.link_id and v.situacao <> 'cancelada'), 0)::float8 as comissao
    from criativos k
    join clientes c on c.cliente_id = k.cliente_id
    join ofertas o on o.cliente_id = k.cliente_id and o.id = k.oferta_id
    left join links l on l.cliente_id = k.cliente_id and l.id = k.link_id
    where k.cliente_id = ${cliente.clienteId} and k.data_lista = ${dataLista} and k.estado <> 'descartado'
    order by k.criado_em desc`;
  // Criativos da Shopee ainda sem link: sub_ids do canal "ig" para gerar no painel da Shopee (um horário só).
  const agora = new Date();
  const semLink = linhas.filter((k) => !k.link_id && k.plataforma === 'shopee').map((k) => k.oferta_id as string);
  const preparo = semLink.length
    ? new Map((await prepararLinks(sql, cliente, { quando: agora, canal: CANAL_INSTAGRAM, ofertaIds: [...new Set(semLink)] })).map((x) => [x.ofertaId, x]))
    : new Map();
  return linhas.map((k) => {
    const pr = !k.link_id ? preparo.get(k.oferta_id) : undefined;
    const desconto = k.desconto !== null && Number(k.desconto) > 0 ? k.desconto : null;
    return {
      id: k.id, formato: k.formato, estado: k.estado, ofertaId: k.oferta_id, titulo: k.titulo, plataforma: k.plataforma,
      roteiro: preencherRoteiro(k.roteiro as SaidaCriativo, k.preco, desconto, { plataforma: k.plataforma, conformidade: k.conformidade }),
      preco: formatarPreco(k.preco), desconto: desconto ? formatarDesconto(desconto) : null,
      // Amazon: as imagens da loja não podem ser guardadas (Políticas do Programa de Associados).
      link: k.link, imagemUrl: k.plataforma === 'amazon' ? null : k.imagem_url,
      precoConferidoEm: k.preco_conferido_em ? new Date(k.preco_conferido_em).toISOString() : null,
      criadoEm: new Date(k.criado_em).toISOString(),
      preparoLink: pr ? { subIds: [...pr.subIds], quando: pr.quando, urlProduto: pr.urlProduto } : null,
      desempenho: k.link_id ? { cliques: k.cliques, pedidos: k.pedidos, comissao: Math.round(k.comissao * 100) / 100 } : null,
    };
  });
}

async function criativoParaLink(sql: Sql, cliente: Cliente, id: string) {
  const [k] = await sql`
    select k.id, k.oferta_id, k.link_id, o.plataforma from criativos k
    join ofertas o on o.cliente_id = k.cliente_id and o.id = k.oferta_id
    where k.cliente_id = ${cliente.clienteId} and k.id = ${id}`;
  if (!k) throw new Error('Criativo não encontrado.');
  if (k.link_id) throw new Error('Este criativo já tem link próprio.');
  if (k.plataforma !== 'shopee') throw new Error('Por enquanto, link próprio do Instagram só na Shopee.');
  return k;
}

/** Link do Instagram gerado no painel da Shopee com os sub_ids mostrados (canal "ig"), colado no Cofilius. */
export async function registrarLinkCriativo(sql: Sql, cliente: Cliente, id: string, link: string, quando: Date): Promise<string> {
  const k = await criativoParaLink(sql, cliente, id);
  const l = await registrarLinkManual(sql, { cliente, ofertaId: k.oferta_id, link, quando, canal: CANAL_INSTAGRAM });
  await sql`update criativos set link_id = ${l.id} where cliente_id = ${cliente.clienteId} and id = ${id}`;
  log.info('criativo.link', { cliente: cliente.codigo, criativo: id, origem: 'painel' });
  return l.id;
}

/** Com a API da Shopee configurada: gera o link do Instagram direto. */
export async function gerarLinkCriativo(
  sql: Sql, cliente: Cliente, id: string, shopee: Pick<ClienteShopee, 'gerarLinkCurto'>, quando = new Date(),
): Promise<string> {
  const k = await criativoParaLink(sql, cliente, id);
  const l = await gerarLinkShopee({ sql, shopee }, { cliente, ofertaId: k.oferta_id, canal: CANAL_INSTAGRAM, quando, contexto: { origem: 'criativo' } });
  await sql`update criativos set link_id = ${l.id} where cliente_id = ${cliente.clienteId} and id = ${id}`;
  log.info('criativo.link', { cliente: cliente.codigo, criativo: id, origem: 'api' });
  return l.id;
}

const TRANSICOES: Record<string, { de: string[]; para: string }> = {
  aprovar: { de: ['rascunho'], para: 'aprovado' },
  publicado: { de: ['rascunho', 'aprovado'], para: 'publicado' },
  descartar: { de: ['rascunho', 'aprovado'], para: 'descartado' },
};

export async function mudarEstadoCriativo(sql: Sql, cliente: Cliente, id: string, acao: string): Promise<string> {
  const t = TRANSICOES[acao];
  if (!t) throw new Error(`Ação desconhecida: ${acao}`);
  const [c] = await sql`
    update criativos set estado = ${t.para}, publicado_em = case when ${t.para} = 'publicado' then now() else publicado_em end
    where cliente_id = ${cliente.clienteId} and id = ${id} and estado in ${sql(t.de)}
    returning estado`;
  if (!c) throw new Error('Criativo não encontrado ou já está em outro estado.');
  return c.estado;
}
