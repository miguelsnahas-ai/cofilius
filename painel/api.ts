/**
 * API do painel do operador. Só chama os serviços que já existem: as regras (estados, validadores,
 * preço conferido antes do envio, links só da Shopee) são as mesmas do terminal e do banco.
 */
import type { Sql } from '../harness/db.ts';
import type { ModeloIA, PrecoModelo } from '../harness/agentes.ts';
import { buscarCliente, type Cliente } from '../db/clientes.ts';
import { horarioLocalParaData } from '../services/etiquetas/etiquetas.ts';
import {
  aprovar, confirmarPreco, dataLocal, descartar, listarDia, registrarEnvio, validarMensagem,
} from '../services/lista/lista.ts';
import { prepararLinks, registrarLinkManual } from '../services/links/linksManuaisShopee.ts';
import { curarDia, selecionadasDoDia } from '../services/curadoria/curador.ts';
import { redigirSelecionadas } from '../services/lista/redator.ts';
import { aprovarDiretriz, descartarDiretriz, listarDiretrizes } from '../services/curadoria/diretrizes.ts';
import { numeroBr } from '../harness/csv.ts';

export interface DepsApi {
  sql: Sql;
  /** Nome gravado em `aprovada_por`. */
  operador: string;
  modelo?: () => ModeloIA;
  precos?: Record<string, PrecoModelo>;
}

/** Erro de uso (vira HTTP 400 com a mensagem para a tela). */
export class ErroPedido extends Error {}

const DATA = /^\d{4}-\d{2}-\d{2}$/;

function texto(corpo: Record<string, unknown>, campo: string): string {
  const v = corpo[campo];
  if (typeof v !== 'string' || !v.trim()) throw new ErroPedido(`Falta "${campo}".`);
  return v.trim();
}

function data(v: unknown, cliente: Cliente): string {
  const d = typeof v === 'string' && v ? v : dataLocal(new Date(), cliente.fusoHorario);
  if (!DATA.test(d)) throw new ErroPedido('Data no formato AAAA-MM-DD.');
  return d;
}

/** Horário em que a lista sai (usado nos sub_ids dos links gerados no painel). */
async function horarioDoEnvio(sql: Sql, cliente: Cliente, dia: string): Promise<{ texto: string; quando: Date }> {
  const [c] = await sql`select to_char(coalesce(horario_envio, '08:00'), 'HH24:MI') as h from clientes where cliente_id = ${cliente.clienteId}`;
  const textoHorario = `${dia} ${c!.h}`;
  return { texto: textoHorario, quando: horarioLocalParaData(textoHorario, cliente.fusoHorario) };
}

export async function listarClientes(deps: DepsApi) {
  const r = await deps.sql`select codigo, nome from clientes where ativo order by codigo`;
  return r.map((c) => ({ codigo: c.codigo, nome: c.nome }));
}

/** Tudo o que a tela precisa para um cliente e um dia. */
export async function painelDoDia(deps: DepsApi, codigo: string, diaPedido?: string) {
  const { sql } = deps;
  const cliente = await buscarCliente(sql, codigo);
  const dia = data(diaPedido, cliente);
  const envio = await horarioDoEnvio(sql, cliente, dia);

  const selecionadas = await selecionadasDoDia(sql, cliente, dia);
  const semLink = selecionadas.filter((s) => !s.linkId && s.plataforma === 'shopee').map((s) => s.ofertaId);
  const preparo = semLink.length ? await prepararLinks(sql, cliente, { quando: envio.quando, ofertaIds: semLink }) : [];
  const porOferta = new Map(preparo.map((p) => [p.ofertaId, p]));

  const mensagens = await listarDia(sql, cliente, dia);
  const extras = mensagens.length
    ? await sql`
        select m.id, m.oferta_id, m.enviada_em, o.preco_conferido_em, o.plataforma
        from mensagens m left join ofertas o on o.cliente_id = m.cliente_id and o.id = m.oferta_id
        where m.id in ${sql(mensagens.map((m) => m.id))}`
    : [];
  const extra = new Map(extras.map((e) => [e.id, e]));

  const [contagem] = await sql`
    select count(*)::int as candidatas from ofertas where cliente_id = ${cliente.clienteId} and data_coleta = ${dia}`;
  const propostas = (await listarDiretrizes(sql, cliente)).filter((d) => d.situacao === 'proposta');

  return {
    cliente: { codigo: cliente.codigo, nome: cliente.nome },
    data: dia,
    horarioEnvio: envio.texto,
    candidatas: contagem!.candidatas,
    iaDisponivel: !!deps.modelo,
    selecionadas: selecionadas.map((s) => {
      const p = porOferta.get(s.ofertaId);
      return {
        ...s,
        preparoLink: p ? { urlProduto: p.urlProduto, subIds: p.subIds, quando: p.quando } : null,
      };
    }),
    mensagens: mensagens.map((m) => {
      const e = extra.get(m.id);
      return {
        ...m,
        ofertaId: e?.oferta_id ?? null,
        plataforma: e?.plataforma ?? null,
        enviadaEm: e?.enviada_em ?? null,
        precoConferidoEm: e?.preco_conferido_em ?? null,
      };
    }),
    propostas: propostas.map((d) => ({ id: d.id, nicho: d.nicho, versao: d.versao, texto: d.texto, propostaPor: d.propostaPor })),
  };
}

export async function acaoMensagem(deps: DepsApi, id: string, acao: string, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente'));
  switch (acao) {
    case 'validar': {
      const [m] = await deps.sql`select 1 from mensagens where id = ${id} and cliente_id = ${cliente.clienteId}`;
      if (!m) throw new ErroPedido('Mensagem não encontrada para este cliente.');
      const r = await validarMensagem(deps.sql, id);
      return { ok: r.ok, estado: r.estado, falhas: r.regras.filter((x) => !x.ok) };
    }
    case 'aprovar':
      await aprovar(deps.sql, cliente, id, deps.operador);
      return { ok: true };
    case 'descartar':
      await descartar(deps.sql, cliente, id, texto(corpo, 'motivo'));
      return { ok: true };
    case 'enviada':
      await registrarEnvio(deps.sql, cliente, id);
      return { ok: true };
    default:
      throw new ErroPedido(`Ação desconhecida: ${acao}`);
  }
}

export async function confirmarPrecoOferta(deps: DepsApi, ofertaId: string, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente'));
  const n = numeroBr(texto(corpo, 'preco'));
  if (n === null || Number.isNaN(n) || n < 0) throw new ErroPedido('Preço inválido.');
  await confirmarPreco(deps.sql, cliente, ofertaId, n.toFixed(2));
  return { ok: true, preco: n.toFixed(2) };
}

export async function registrarLinkOferta(deps: DepsApi, ofertaId: string, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente'));
  // O horário precisa ser o mesmo usado para montar os sub_ids mostrados na tela.
  const quando = horarioLocalParaData(texto(corpo, 'quando'), cliente.fusoHorario);
  const l = await registrarLinkManual(deps.sql, { cliente, ofertaId, link: texto(corpo, 'link'), quando });
  return { ok: true, linkId: l.id, subIds: l.subIds };
}

function exigirModelo(deps: DepsApi): ModeloIA {
  if (!deps.modelo) throw new ErroPedido('IA não configurada: defina ANTHROPIC_API_KEY no .env e reinicie o painel.');
  return deps.modelo();
}

export async function rodarCurador(deps: DepsApi, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente'));
  const r = await curarDia(deps.sql, { cliente, data: data(corpo.data, cliente), modelo: exigirModelo(deps), precos: deps.precos });
  return { ok: true, candidatas: r.candidatas, escolhidas: r.escolhas.length };
}

export async function rodarRedator(deps: DepsApi, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente'));
  const r = await redigirSelecionadas(deps.sql, { cliente, data: data(corpo.data, cliente), modelo: exigirModelo(deps), precos: deps.precos });
  return { ok: true, redigidas: r.redigidas.length, semLink: r.semLink.length, falhas: r.falhas };
}

export async function acaoDiretriz(deps: DepsApi, id: string, acao: string, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente'));
  if (acao === 'aprovar') await aprovarDiretriz(deps.sql, cliente, id);
  else if (acao === 'descartar') await descartarDiretriz(deps.sql, cliente, id);
  else throw new ErroPedido(`Ação desconhecida: ${acao}`);
  return { ok: true };
}
