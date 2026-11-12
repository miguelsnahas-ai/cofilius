/**
 * Lista diária (tabela `mensagens`): rascunho → validada → aprovada → enviada → medida.
 *
 * - Rascunho: texto com marcadores; o código preenche preço, desconto e link a partir do banco.
 * - Validada: passou em todos os validadores (só código decide).
 * - Aprovada: o operador aprovou (durante o MVP, sempre uma pessoa).
 * - Enviada: só a partir de aprovada, e só se o preço foi conferido até 30 minutos antes.
 *
 * O banco também garante a ordem dos estados (migration 0002); este módulo diz o porquê de cada recusa.
 */
import type { Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import type { Cliente } from '../../db/clientes.ts';
import { partesLocais } from '../etiquetas/etiquetas.ts';
import { descreverProblema, preencherMensagem, verificarTextoModelo } from './marcadores.ts';

export const DIAS_SEM_REPETIR = 7;
export const MINUTOS_PRECO_VALIDO = 30;

export type Regra = 'texto' | 'link' | 'preco' | 'repeticao' | 'limite';

export interface ResultadoRegra {
  regra: Regra;
  ok: boolean;
  detalhe: string;
}

export interface ResultadoValidacao {
  mensagemId: string;
  ok: boolean;
  estado: string;
  regras: ResultadoRegra[];
}

/** Domínios aceitos para o link de afiliado de cada plataforma. */
const HOSTS_LINK: Record<string, RegExp> = {
  shopee: /^(s\.shopee\.com\.br|shope\.ee|shopee\.com\.br)$/i,
  mercado_livre: /(^|\.)(mercadolivre\.com|mercadolivre\.com\.br|mercadolibre\.com)$/i,
  amazon: /^(amzn\.to|www\.amazon\.com\.br|amazon\.com\.br)$/i,
};

export function linkDaPlataforma(plataforma: string, url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !!HOSTS_LINK[plataforma]?.test(u.hostname);
  } catch {
    return false;
  }
}

export function dataLocal(quando: Date, fuso: string): string {
  const p = partesLocais(quando, fuso);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

const mesmoNumero = (a: string | null, b: string | null) =>
  (a === null && b === null) || (a !== null && b !== null && Number(a) === Number(b));

// ---------------------------------------------------------------------------
// Rascunho
// ---------------------------------------------------------------------------

export interface EntradaRascunho {
  cliente: Cliente;
  ofertaId: string;
  /** Link a usar. Se omitido, usa o link mais recente da oferta. */
  linkId?: string;
  /** Texto com marcadores ({{preco}}, {{desconto}}, {{link}}). */
  textoModelo: string;
  /** Dia da lista (AAAA-MM-DD). Padrão: hoje no fuso do cliente. */
  dataLista?: string;
  agendadaPara?: Date;
}

export interface MensagemCriada {
  id: string;
  textoFinal: string;
  estado: string;
}

export async function criarRascunho(sql: Sql, e: EntradaRascunho): Promise<MensagemCriada> {
  const clienteId = e.cliente.clienteId;
  const problemas = verificarTextoModelo(e.textoModelo);
  if (problemas.length) throw new Error(`Texto recusado: ${problemas.map(descreverProblema).join('; ')}`);

  const [oferta] = await sql`
    select id, preco::text, desconto_pct::text, plataforma, produto_id from ofertas
    where cliente_id = ${clienteId} and id = ${e.ofertaId}`;
  if (!oferta) throw new Error(`Oferta ${e.ofertaId} não encontrada para este cliente.`);

  const [link] = e.linkId
    ? await sql`select id, url_afiliado from links where cliente_id = ${clienteId} and id = ${e.linkId}`
    : await sql`select id, url_afiliado from links where cliente_id = ${clienteId} and oferta_id = ${e.ofertaId}
                order by criado_em desc limit 1`;
  if (!link) throw new Error('Esta oferta ainda não tem link de afiliado. Gere o link antes de montar a mensagem.');

  const textoFinal = preencherMensagem(e.textoModelo, { preco: oferta.preco, desconto: oferta.desconto_pct, link: link.url_afiliado });
  const dataLista = e.dataLista ?? dataLocal(new Date(), e.cliente.fusoHorario);

  try {
    const [m] = await sql`
      insert into mensagens (cliente_id, oferta_id, link_id, texto_modelo, texto_final, data_lista, agendada_para,
                             preco_usado, desconto_usado)
      values (${clienteId}, ${oferta.id}, ${link.id}, ${e.textoModelo}, ${textoFinal}, ${dataLista},
              ${e.agendadaPara ?? null}, ${oferta.preco}, ${oferta.desconto_pct})
      returning id, texto_final, estado`;
    return { id: m!.id, textoFinal: m!.texto_final, estado: m!.estado };
  } catch (erro) {
    if ((erro as { code?: string }).code === '23505') {
      throw new Error('Esta oferta já está na lista deste dia.');
    }
    throw erro;
  }
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

export interface OpcoesValidacao {
  agora?: Date;
  /** Confere se o link abre (chamada externa). Se omitido, essa parte é pulada e dita no detalhe. */
  linkAbre?: (url: string) => Promise<boolean>;
}

async function carregar(sql: Sql, mensagemId: string) {
  const [m] = await sql`
    select m.id, m.cliente_id, m.estado, m.texto_modelo, m.texto_final, m.data_lista::text, m.preco_usado::text,
           m.desconto_usado::text, m.oferta_id, m.link_id,
           o.preco::text as oferta_preco, o.desconto_pct::text as oferta_desconto, o.plataforma, o.produto_id,
           o.preco_conferido_em,
           l.url_afiliado, l.plataforma as link_plataforma, l.produto_id as link_produto, l.sub_ids, l.cliente_id as link_cliente,
           c.codigo, c.limite_mensagens_dia
    from mensagens m
    join clientes c on c.cliente_id = m.cliente_id
    left join ofertas o on o.cliente_id = m.cliente_id and o.id = m.oferta_id
    left join links l on l.cliente_id = m.cliente_id and l.id = m.link_id
    where m.id = ${mensagemId}`;
  if (!m) throw new Error(`Mensagem ${mensagemId} não encontrada.`);
  return m;
}

type Carregada = Awaited<ReturnType<typeof carregar>>;

async function regraRepeticao(sql: Sql, m: Carregada, agora: Date): Promise<ResultadoRegra> {
  // Compara pelo produto (não pela linha da oferta, que muda a cada dia de coleta).
  const desde = new Date(agora.getTime() - DIAS_SEM_REPETIR * 86_400_000);
  const [r] = await sql`
    select count(*)::int as n, max(m2.enviada_em) as ultima
    from mensagens m2
    join ofertas o2 on o2.cliente_id = m2.cliente_id and o2.id = m2.oferta_id
    where m2.cliente_id = ${m.cliente_id} and m2.id <> ${m.id}
      and m2.estado in ('enviada', 'medida') and m2.enviada_em > ${desde}
      and o2.plataforma = ${m.plataforma} and o2.produto_id = ${m.produto_id}`;
  return r!.n > 0
    ? { regra: 'repeticao', ok: false, detalhe: `produto já enviado em ${new Date(r!.ultima).toISOString().slice(0, 10)} (menos de ${DIAS_SEM_REPETIR} dias)` }
    : { regra: 'repeticao', ok: true, detalhe: `não enviado nos últimos ${DIAS_SEM_REPETIR} dias` };
}

async function regras(sql: Sql, m: Carregada, op: OpcoesValidacao): Promise<ResultadoRegra[]> {
  const agora = op.agora ?? new Date();
  const saida: ResultadoRegra[] = [];

  // texto: só marcadores, e o texto final é exatamente o preenchimento com os valores atuais do banco
  const problemas = verificarTextoModelo(m.texto_modelo);
  if (problemas.length) {
    saida.push({ regra: 'texto', ok: false, detalhe: problemas.map(descreverProblema).join('; ') });
  } else if (!m.oferta_id || !m.url_afiliado) {
    saida.push({ regra: 'texto', ok: false, detalhe: 'mensagem sem oferta ou sem link' });
  } else {
    try {
      // Confere que o texto final é exatamente o preenchimento do modelo com os valores gravados
      // (se o preço da oferta mudou depois, quem acusa é a regra "preco").
      const esperado = preencherMensagem(m.texto_modelo, { preco: m.preco_usado, desconto: m.desconto_usado, link: m.url_afiliado });
      saida.push(esperado === m.texto_final
        ? { regra: 'texto', ok: true, detalhe: 'só marcadores; valores vindos do banco' }
        : { regra: 'texto', ok: false, detalhe: 'o texto final não é o preenchimento do modelo com os valores do banco' });
    } catch (erro) {
      saida.push({ regra: 'texto', ok: false, detalhe: (erro as Error).message });
    }
  }

  // link: do cliente certo, da plataforma da oferta, do mesmo produto, com identificador do cliente
  if (!m.url_afiliado) {
    saida.push({ regra: 'link', ok: false, detalhe: 'sem link' });
  } else {
    const falhas: string[] = [];
    if (m.link_cliente !== m.cliente_id) falhas.push('link de outro cliente');
    if (m.link_plataforma !== m.plataforma) falhas.push(`link da plataforma ${m.link_plataforma}, oferta da ${m.plataforma}`);
    if (!linkDaPlataforma(m.plataforma, m.url_afiliado)) falhas.push(`endereço não é de afiliado da plataforma: ${m.url_afiliado}`);
    if (m.link_produto && m.produto_id && m.link_produto !== m.produto_id) falhas.push('link de outro produto');
    if (m.plataforma === 'shopee' && (m.sub_ids?.[0] ?? null) !== m.codigo) falhas.push(`sub_id1 "${m.sub_ids?.[0] ?? ''}" não é o código do cliente (${m.codigo})`);
    let detalheAbre = 'abertura do link não conferida';
    if (!falhas.length && op.linkAbre) {
      const abre = await op.linkAbre(m.url_afiliado).catch(() => false);
      if (!abre) falhas.push('o link não abriu');
      else detalheAbre = 'link abre';
    }
    saida.push(falhas.length
      ? { regra: 'link', ok: false, detalhe: falhas.join('; ') }
      : { regra: 'link', ok: true, detalhe: `link do cliente e do produto certos; ${detalheAbre}` });
  }

  // preço: o usado no texto ainda é o da oferta
  saida.push(m.oferta_preco !== null && mesmoNumero(m.preco_usado, m.oferta_preco) && mesmoNumero(m.desconto_usado, m.oferta_desconto)
    ? { regra: 'preco', ok: true, detalhe: 'preço e desconto iguais aos da oferta' }
    : { regra: 'preco', ok: false, detalhe: `preço mudou: texto com ${m.preco_usado}, oferta com ${m.oferta_preco}` });

  // repetição
  saida.push(m.produto_id ? await regraRepeticao(sql, m, agora) : { regra: 'repeticao', ok: false, detalhe: 'sem oferta' });

  // limite por dia (conta as outras mensagens do dia que já passaram da validação)
  const [c] = await sql`
    select count(*)::int as n from mensagens
    where cliente_id = ${m.cliente_id} and data_lista = ${m.data_lista} and id <> ${m.id}
      and estado in ('validada', 'aprovada', 'enviada', 'medida')`;
  saida.push(c!.n < m.limite_mensagens_dia
    ? { regra: 'limite', ok: true, detalhe: `${c!.n + 1} de ${m.limite_mensagens_dia} no dia` }
    : { regra: 'limite', ok: false, detalhe: `limite de ${m.limite_mensagens_dia} mensagens no dia atingido` });

  return saida;
}

export async function validarMensagem(sql: Sql, mensagemId: string, op: OpcoesValidacao = {}): Promise<ResultadoValidacao> {
  const m = await carregar(sql, mensagemId);
  if (m.estado !== 'rascunho' && m.estado !== 'validada') {
    throw new Error(`Só rascunho ou validada pode ser validada (está ${m.estado}).`);
  }
  const resultado = await regras(sql, m, op);
  const ok = resultado.every((r) => r.ok);
  const novoEstado = ok ? 'validada' : 'rascunho';
  await sql`
    update mensagens set validacao = ${sql.json(resultado as never)}, estado = ${novoEstado}
    where id = ${mensagemId}`;
  log.info('lista.validada', { mensagemId, ok, falhas: resultado.filter((r) => !r.ok).map((r) => r.regra) });
  return { mensagemId, ok, estado: novoEstado, regras: resultado };
}

/** Valida todos os rascunhos do dia de um cliente. */
export async function validarDia(sql: Sql, cliente: Cliente, dataLista: string, op: OpcoesValidacao = {}): Promise<ResultadoValidacao[]> {
  const ids = await sql<{ id: string }[]>`
    select id from mensagens where cliente_id = ${cliente.clienteId} and data_lista = ${dataLista} and estado = 'rascunho'
    order by criado_em`;
  const saida: ResultadoValidacao[] = [];
  for (const { id } of ids) saida.push(await validarMensagem(sql, id, op));
  return saida;
}

// ---------------------------------------------------------------------------
// Aprovação, descarte, envio
// ---------------------------------------------------------------------------

async function exigirEstado(sql: Sql, mensagemId: string, cliente: Cliente, estados: string[]) {
  const [m] = await sql`select estado from mensagens where id = ${mensagemId} and cliente_id = ${cliente.clienteId}`;
  if (!m) throw new Error(`Mensagem ${mensagemId} não encontrada para este cliente.`);
  if (!estados.includes(m.estado)) throw new Error(`A mensagem está ${m.estado}; esperado: ${estados.join(' ou ')}.`);
}

export async function aprovar(sql: Sql, cliente: Cliente, mensagemId: string, por: string): Promise<void> {
  await exigirEstado(sql, mensagemId, cliente, ['validada']);
  await sql`update mensagens set estado = 'aprovada', aprovada_por = ${por} where id = ${mensagemId}`;
  log.info('lista.aprovada', { mensagemId, por });
}

export async function descartar(sql: Sql, cliente: Cliente, mensagemId: string, motivo: string): Promise<void> {
  await exigirEstado(sql, mensagemId, cliente, ['rascunho', 'validada', 'aprovada']);
  await sql`update mensagens set estado = 'descartada', motivo_descarte = ${motivo} where id = ${mensagemId}`;
  log.info('lista.descartada', { mensagemId, motivo });
}

export interface ConferenciaEnvio {
  podeEnviar: boolean;
  motivo: string;
  /** true quando a mensagem foi descartada (preço mudou ou produto repetido). */
  descartada: boolean;
}

/**
 * Última conferência antes do envio (o Disparador chama isto).
 * - Preço conferido há mais de 30 minutos: não envia; é preciso conferir de novo (nova coleta) e repetir.
 * - Preço mudou ou produto já enviado nos últimos 7 dias: a mensagem sai da lista (descartada).
 */
export async function conferirAntesDoEnvio(sql: Sql, cliente: Cliente, mensagemId: string, agora = new Date()): Promise<ConferenciaEnvio> {
  await exigirEstado(sql, mensagemId, cliente, ['aprovada']);
  const m = await carregar(sql, mensagemId);
  const idadeMin = (agora.getTime() - new Date(m.preco_conferido_em).getTime()) / 60_000;
  if (!(mesmoNumero(m.preco_usado, m.oferta_preco) && mesmoNumero(m.desconto_usado, m.oferta_desconto))) {
    const motivo = `preço mudou antes do envio: texto com ${m.preco_usado}, oferta com ${m.oferta_preco}`;
    await descartar(sql, cliente, mensagemId, motivo);
    return { podeEnviar: false, motivo, descartada: true };
  }
  const repeticao = await regraRepeticao(sql, m, agora);
  if (!repeticao.ok) {
    await descartar(sql, cliente, mensagemId, repeticao.detalhe);
    return { podeEnviar: false, motivo: repeticao.detalhe, descartada: true };
  }
  if (idadeMin > MINUTOS_PRECO_VALIDO) {
    return { podeEnviar: false, motivo: `preço conferido há ${Math.round(idadeMin)} minutos (máximo ${MINUTOS_PRECO_VALIDO}); confira de novo`, descartada: false };
  }
  return { podeEnviar: true, motivo: 'ok', descartada: false };
}

/** Marca como enviada, depois da conferência. Lança erro se não puder enviar. */
export async function registrarEnvio(sql: Sql, cliente: Cliente, mensagemId: string, agora = new Date()): Promise<void> {
  const c = await conferirAntesDoEnvio(sql, cliente, mensagemId, agora);
  if (!c.podeEnviar) throw new Error(`Não enviada: ${c.motivo}`);
  await sql`update mensagens set estado = 'enviada', enviada_em = ${agora} where id = ${mensagemId}`;
  log.info('lista.enviada', { mensagemId });
}

/**
 * Confirma o preço de uma oferta sem nova coleta (modo manual: o operador olhou a página).
 * Se o preço mudou, grava o novo; mensagens que usavam o preço antigo serão barradas na validação/envio.
 */
export async function confirmarPreco(sql: Sql, cliente: Cliente, ofertaId: string, preco: string): Promise<void> {
  const r = await sql`
    update ofertas set preco = ${preco}, preco_conferido_em = now()
    where cliente_id = ${cliente.clienteId} and id = ${ofertaId}
    returning id`;
  if (!r.length) throw new Error(`Oferta ${ofertaId} não encontrada para este cliente.`);
}

export interface LinhaLista {
  id: string;
  estado: string;
  textoFinal: string | null;
  titulo: string | null;
  preco: string | null;
  validacao: ResultadoRegra[] | null;
  motivoDescarte: string | null;
}

export async function listarDia(sql: Sql, cliente: Cliente, dataLista: string): Promise<LinhaLista[]> {
  const linhas = await sql`
    select m.id, m.estado, m.texto_final, o.titulo, o.preco::text, m.validacao, m.motivo_descarte
    from mensagens m left join ofertas o on o.cliente_id = m.cliente_id and o.id = m.oferta_id
    where m.cliente_id = ${cliente.clienteId} and m.data_lista = ${dataLista}
    order by m.criado_em`;
  return linhas.map((l) => ({
    id: l.id, estado: l.estado, textoFinal: l.texto_final, titulo: l.titulo, preco: l.preco,
    validacao: l.validacao, motivoDescarte: l.motivo_descarte,
  }));
}
