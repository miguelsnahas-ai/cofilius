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
  const [link] = await sql`select id from links where cliente_id = ${p.cliente.clienteId} and oferta_id = ${p.ofertaId} order by criado_em desc limit 1`;
  const [c] = await sql`
    insert into criativos (cliente_id, oferta_id, link_id, formato, roteiro, data_lista)
    values (${p.cliente.clienteId}, ${p.ofertaId}, ${link?.id ?? null}, ${p.formato}, ${sql.json(r.saida as never)}, ${p.dataLista})
    returning id`;
  log.info('criativo.criado', { cliente: p.cliente.codigo, formato: p.formato, criativo: c!.id });
  return c!.id;
}

/** Criativos do dia (menos os descartados), com os valores atuais do banco. */
export async function criativosDoDia(sql: Sql, cliente: Cliente, dataLista: string): Promise<CriativoPronto[]> {
  const linhas = await sql`
    select k.id, k.formato, k.estado, k.oferta_id, k.roteiro, k.criado_em, o.titulo, o.plataforma, o.preco::text as preco,
           o.desconto_pct::text as desconto, o.imagem_url, o.preco_conferido_em, c.conformidade,
           coalesce(l.url_afiliado, (select url_afiliado from links x where x.cliente_id = k.cliente_id and x.oferta_id = k.oferta_id
                                     order by x.criado_em desc limit 1)) as link
    from criativos k
    join clientes c on c.cliente_id = k.cliente_id
    join ofertas o on o.cliente_id = k.cliente_id and o.id = k.oferta_id
    left join links l on l.cliente_id = k.cliente_id and l.id = k.link_id
    where k.cliente_id = ${cliente.clienteId} and k.data_lista = ${dataLista} and k.estado <> 'descartado'
    order by k.criado_em desc`;
  return linhas.map((k) => {
    const desconto = k.desconto !== null && Number(k.desconto) > 0 ? k.desconto : null;
    return {
      id: k.id, formato: k.formato, estado: k.estado, ofertaId: k.oferta_id, titulo: k.titulo, plataforma: k.plataforma,
      roteiro: preencherRoteiro(k.roteiro as SaidaCriativo, k.preco, desconto, { plataforma: k.plataforma, conformidade: k.conformidade }),
      preco: formatarPreco(k.preco), desconto: desconto ? formatarDesconto(desconto) : null,
      // Amazon: as imagens da loja não podem ser guardadas (Políticas do Programa de Associados).
      link: k.link, imagemUrl: k.plataforma === 'amazon' ? null : k.imagem_url,
      precoConferidoEm: k.preco_conferido_em ? new Date(k.preco_conferido_em).toISOString() : null,
      criadoEm: new Date(k.criado_em).toISOString(),
    };
  });
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
