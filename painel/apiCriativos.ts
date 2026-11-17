/** API da aba Criativos: listar, criar com a IA, mudar o estado. */
import { buscarCliente } from '../db/clientes.ts';
import { criarCriativo, criativosDoDia, FORMATOS, gerarLinkCriativo, mudarEstadoCriativo, registrarLinkCriativo } from '../services/criativos/criativos.ts';
import { horarioLocalParaData } from '../services/etiquetas/etiquetas.ts';
import { dataLocal } from '../services/lista/lista.ts';
import type { FormatoCriativo } from '../agents/criativo/regras.ts';
import { ErroPedido, type DepsApi } from './api.ts';

const DATA = /^\d{4}-\d{2}-\d{2}$/;

export async function telaCriativos(deps: DepsApi, codigo: string, data: string | null) {
  const cliente = await buscarCliente(deps.sql, codigo);
  const dia = data && DATA.test(data) ? data : dataLocal(new Date(), cliente.fusoHorario);
  // Ofertas que podem virar criativo: as escolhidas do dia primeiro, depois as outras do dia.
  const ofertas = await deps.sql`
    select o.id, o.titulo, o.plataforma, o.imagem_url is not null as tem_foto,
           exists (select 1 from links l where l.cliente_id = o.cliente_id and l.oferta_id = o.id) as tem_link,
           o.selecionada_em is not null as escolhida
    from ofertas o where o.cliente_id = ${cliente.clienteId} and o.data_coleta = ${dia}
    order by (o.selecionada_em is not null) desc, (o.curadoria ->> 'posicao')::int nulls last, o.titulo limit 60`;
  const shopee = deps.shopeeDoCliente ? await deps.shopeeDoCliente(cliente).catch(() => null) : null;
  return {
    data: dia,
    iaDisponivel: !!deps.modelo,
    /** Com a API da Shopee, o link do Instagram sai com um clique; sem ela, pelos sub_ids. */
    linkAutomatico: !!shopee,
    ofertas: ofertas.map((o) => ({ id: o.id, titulo: o.titulo, plataforma: o.plataforma, temFoto: o.tem_foto, temLink: o.tem_link, escolhida: o.escolhida })),
    criativos: await criativosDoDia(deps.sql, cliente, dia),
  };
}

export async function novoCriativo(deps: DepsApi, corpo: Record<string, unknown>) {
  if (!deps.modelo) throw new ErroPedido('Coloque a chave da IA na Configuração para criar criativos.');
  const cliente = await buscarCliente(deps.sql, String(corpo.cliente ?? ''));
  const formato = String(corpo.formato ?? '') as FormatoCriativo;
  if (!FORMATOS.includes(formato)) throw new ErroPedido('Escolha carrossel, stories ou reels.');
  const ofertaId = String(corpo.ofertaId ?? '');
  if (!/^[0-9a-f-]{36}$/.test(ofertaId)) throw new ErroPedido('Escolha a oferta.');
  const data = typeof corpo.data === 'string' && DATA.test(corpo.data) ? corpo.data : dataLocal(new Date(), cliente.fusoHorario);
  const id = await criarCriativo(deps.sql, { cliente, ofertaId, formato, dataLista: data, modelo: deps.modelo(), precos: deps.precos });
  return { ok: true, id };
}

export async function acaoCriativo(deps: DepsApi, id: string, acao: string, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, String(corpo.cliente ?? ''));
  try {
    return { ok: true, estado: await mudarEstadoCriativo(deps.sql, cliente, id, acao) };
  } catch (e) {
    throw new ErroPedido((e as Error).message);
  }
}

/** Link próprio do Instagram: colado do painel da Shopee (com os sub_ids mostrados) ou gerado pela API. */
export async function linkCriativo(deps: DepsApi, id: string, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, String(corpo.cliente ?? ''));
  try {
    if (corpo.automatico === true) {
      const shopee = deps.shopeeDoCliente ? await deps.shopeeDoCliente(cliente) : null;
      if (!shopee) throw new Error('A API da Shopee não está configurada para este cliente: gere o link no painel da Shopee com os sub_ids.');
      return { ok: true, linkId: await gerarLinkCriativo(deps.sql, cliente, id, shopee) };
    }
    const quando = horarioLocalParaData(String(corpo.quando ?? ''), cliente.fusoHorario);
    return { ok: true, linkId: await registrarLinkCriativo(deps.sql, cliente, id, String(corpo.link ?? ''), quando) };
  } catch (e) {
    throw new ErroPedido((e as Error).message);
  }
}
