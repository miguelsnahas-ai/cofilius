/**
 * Recebe no painel o que a extensão do Chrome capturou nas páginas de afiliado e grava no banco:
 * conversões da Shopee viram vendas, cliques da Shopee viram cliques por dia, links curtos da
 * Amazon (SiteStripe) viram links. Também processa um arquivo de gravação inteiro (o mesmo formato).
 *
 * Pareamento: cada cliente tem um código; a extensão manda o código e o painel sabe de quem são os dados.
 * Só o hash do código fica no banco.
 */
import { createHash, randomBytes } from 'node:crypto';
import { conectarTransacao, type Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarVendas, registrarCliques } from '../vendas/atribuicao.ts';
import { cliquesShopee, conversoesShopee, linkAmazon, tipoPelaUrl, type TipoRecebido } from './conversores.ts';

const hash = (codigo: string) => createHash('sha256').update(codigo.trim()).digest('hex');

/** Gera (ou troca) o código de pareamento do cliente. O código só aparece agora; depois, só o hash. */
export async function gerarPareamento(sql: Sql, codigoCliente: string): Promise<string> {
  const cliente = await buscarCliente(sql, codigoCliente);
  const codigo = `cof-${randomBytes(15).toString('base64url')}`;
  await sql`
    insert into pareamentos_extensao (cliente_id, codigo_hash) values (${cliente.clienteId}, ${hash(codigo)})
    on conflict (cliente_id) do update set codigo_hash = excluded.codigo_hash, criado_em = now(), usado_em = null`;
  log.info('extensao.pareamento_gerado', { cliente: cliente.codigo });
  return codigo;
}

/** Cliente dono do código, ou null. */
export async function clientePareado(sql: Sql, codigo: string | undefined): Promise<Cliente | null> {
  if (!codigo || codigo.length < 10 || codigo.length > 100) return null;
  const [p] = await sql`
    update pareamentos_extensao set usado_em = now() where codigo_hash = ${hash(codigo)}
    returning (select codigo from clientes c where c.cliente_id = pareamentos_extensao.cliente_id) as codigo`;
  return p ? buscarCliente(sql, p.codigo) : null;
}

export interface Captura { url: string; resposta?: { json?: unknown } | null }

export interface ResultadoRecebido {
  tipo: TipoRecebido | null;
  ok: boolean;
  detalhe: string;
  /** Shopee: a página tem continuação? (a extensão busca as próximas) */
  pagina?: { pagina: number; tamanho: number; total: number };
}

async function registrarRecebimento(sql: Sql, cliente: Cliente, tipo: string, url: string, resultado: object, erro: string | null) {
  await sql`
    insert into recebimentos_extensao (cliente_id, tipo, url, resultado, erro)
    values (${cliente.clienteId}, ${tipo}, ${url.slice(0, 500)}, ${sql.json(resultado as never)}, ${erro})`;
}

async function gravarCliquesShopee(sql: Sql, cliente: Cliente, json: unknown) {
  const { cliques, pagina } = cliquesShopee(json);
  let afetados: { chave: string; dia: string }[] = [];
  await conectarTransacao(sql, 'extensao.cliques', async (tx) => {
    for (const c of cliques) {
      await tx`
        insert into cliques_shopee (cliente_id, click_id, chave_rastreio, clicado_em)
        values (${cliente.clienteId}, ${c.clickId}, ${c.chaveRastreio}, ${c.clicadoEm})
        on conflict (cliente_id, click_id) do nothing`;
    }
  });
  if (cliques.length) {
    // Reconta os dias tocados a partir de todos os cliques guardados (páginas chegam separadas).
    afetados = (await sql`
      select chave_rastreio as chave, to_char((clicado_em at time zone ${cliente.fusoHorario})::date, 'YYYY-MM-DD') as dia
      from cliques_shopee where cliente_id = ${cliente.clienteId} and click_id in ${sql(cliques.map((c) => c.clickId))}
      group by 1, 2`) as unknown as { chave: string; dia: string }[];
    const contagens = await sql`
      select chave_rastreio as chave, to_char((clicado_em at time zone ${cliente.fusoHorario})::date, 'YYYY-MM-DD') as dia, count(*)::int as n
      from cliques_shopee where cliente_id = ${cliente.clienteId}
      group by 1, 2`;
    const tocados = new Set(afetados.map((a) => `${a.chave}|${a.dia}`));
    await registrarCliques(sql, cliente, contagens
      .filter((c) => tocados.has(`${c.chave}|${c.dia}`))
      .map((c) => ({ plataforma: 'shopee' as const, chaveRastreio: c.chave, dia: c.dia, cliques: c.n })));
  }
  return { detalhe: `${cliques.length} cliques lidos, ${afetados.length} dias atualizados`, pagina, resultado: { cliques: cliques.length, dias: afetados.length } };
}

async function gravarLinkAmazon(sql: Sql, cliente: Cliente, url: string, json: unknown) {
  const l = linkAmazon(url, json);
  if (!l) throw new Error('Link da Amazon fora do formato esperado.');
  const [existe] = await sql`
    select id from links where cliente_id = ${cliente.clienteId} and plataforma = 'amazon' and url_afiliado = ${l.urlCurta}`;
  if (existe) return { detalhe: `link ${l.urlCurta} já registrado`, resultado: { novo: false, asin: l.asin } };
  await sql`
    insert into links (cliente_id, plataforma, url_origem, url_afiliado, chave_rastreio, canal, produto_id, contexto)
    values (${cliente.clienteId}, 'amazon', ${l.urlProduto}, ${l.urlCurta}, ${l.trackingId}, 'wa', ${l.asin},
            ${sql.json({ origem: 'extensao.sitestripe' })})`;
  return { detalhe: `link ${l.urlCurta} registrado (produto ${l.asin})`, resultado: { novo: true, asin: l.asin } };
}

/** Processa uma captura. Nunca lança: o erro volta no resultado e fica registrado. */
export async function receberCaptura(sql: Sql, cliente: Cliente, c: Captura): Promise<ResultadoRecebido> {
  const tipo = typeof c?.url === 'string' ? tipoPelaUrl(c.url) : null;
  if (!tipo) return { tipo: null, ok: false, detalhe: 'Dado que o painel não usa.' };
  const json = c.resposta?.json;
  try {
    let r: { detalhe: string; resultado: object; pagina?: ResultadoRecebido['pagina'] };
    if (tipo === 'shopee.conversoes') {
      const { vendas, pagina, ignorados } = conversoesShopee(json);
      const imp = vendas.length ? await importarVendas(sql, cliente, vendas) : null;
      r = {
        detalhe: `${vendas.length} vendas (${imp?.novas ?? 0} novas, ${imp?.atualizadas ?? 0} atualizadas, ${imp?.atribuidas ?? 0} atribuídas a postagens)`,
        resultado: { vendas: vendas.length, novas: imp?.novas ?? 0, atualizadas: imp?.atualizadas ?? 0, atribuidas: imp?.atribuidas ?? 0, ignorados },
        pagina,
      };
    } else if (tipo === 'shopee.cliques') {
      r = await gravarCliquesShopee(sql, cliente, json);
    } else {
      r = await gravarLinkAmazon(sql, cliente, c.url, json);
    }
    await registrarRecebimento(sql, cliente, tipo, c.url, r.resultado, null);
    log.info('extensao.recebido', { cliente: cliente.codigo, tipo, ...r.resultado });
    return { tipo, ok: true, detalhe: r.detalhe, pagina: r.pagina };
  } catch (erro) {
    const msg = erro instanceof Error ? erro.message : String(erro);
    log.error('extensao.falha', { cliente: cliente.codigo, tipo, erro: msg });
    await registrarRecebimento(sql, cliente, tipo, c.url, {}, msg).catch(() => {});
    return { tipo, ok: false, detalhe: msg };
  }
}

/** Processa várias capturas (o que a extensão mandou de uma vez, ou um arquivo de gravação). */
export async function receberCapturas(sql: Sql, cliente: Cliente, capturas: unknown[]) {
  const resultados: ResultadoRecebido[] = [];
  for (const c of capturas) {
    const cap = c as Captura & { tipo?: string };
    if (!cap || (cap.tipo !== undefined && cap.tipo !== 'resposta')) continue;
    const r = await receberCaptura(sql, cliente, cap);
    if (r.tipo) resultados.push(r);
  }
  return {
    usados: resultados.filter((r) => r.ok).length,
    falhas: resultados.filter((r) => !r.ok).map((r) => `${r.tipo}: ${r.detalhe}`),
    resultados,
  };
}

/** Últimos recebimentos do cliente, para a tela. */
export async function ultimosRecebimentos(sql: Sql, cliente: Cliente) {
  const [par] = await sql`select criado_em, usado_em from pareamentos_extensao where cliente_id = ${cliente.clienteId}`;
  const ultimos = await sql`
    select distinct on (tipo) tipo, criado_em, resultado, erro from recebimentos_extensao
    where cliente_id = ${cliente.clienteId} order by tipo, criado_em desc`;
  return {
    pareado: !!par,
    pareadoEm: par?.criado_em ?? null,
    usadoEm: par?.usado_em ?? null,
    ultimos: ultimos.map((u) => ({ tipo: u.tipo, em: u.criado_em, resultado: u.resultado, erro: u.erro })),
  };
}
