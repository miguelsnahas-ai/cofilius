/**
 * API das telas de gestão do painel (o que antes só existia no terminal): clientes e nichos, credenciais
 * da Shopee, importação de planilhas, fechamento, uso, diretrizes e teste dos agentes.
 * Só chama os serviços existentes; as regras continuam neles.
 */
import { join } from 'node:path';
import { importarChave } from '../harness/cripto.ts';
import { RAIZ } from '../harness/configLocal.ts';
import { carregarAgente, rodarCasos } from '../harness/agentes.ts';
import { buscarCliente } from '../db/clientes.ts';
import { salvarCredencialShopee } from '../db/credenciais.ts';
import {
  atualizarCliente, criarCliente, definirAtivo, listarCadastro, removerNicho, salvarNicho, type DadosCliente,
} from '../services/clientes/cadastro.ts';
import { importarPlanilhaShopee } from '../services/ofertas/importarPlanilhaShopee.ts';
import { lerPlanilhaVendas } from '../services/vendas/planilhaVendas.ts';
import { importarVendas, resumoPeriodo } from '../services/vendas/atribuicao.ts';
import { analisarPeriodo, contratoAnalista } from '../services/relatorios/analista.ts';
import { montarFechamento } from '../services/relatorios/fechamento.ts';
import { usoPorCliente } from '../services/relatorios/uso.ts';
import { listarDiretrizes, proporDiretriz } from '../services/curadoria/diretrizes.ts';
import { contratoCurador } from '../services/curadoria/curador.ts';
import { contratoRedator } from '../services/lista/redator.ts';
import { contratoAtendente } from '../services/atendimento/atendente.ts';
import { ErroPedido, type DepsApi } from './api.ts';

const DATA = /^\d{4}-\d{2}-\d{2}$/;

function texto(corpo: Record<string, unknown>, campo: string, obrigatorio = true): string | undefined {
  const v = corpo[campo];
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (obrigatorio) throw new ErroPedido(`Falta "${campo}".`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ErroPedido(`"${campo}" deve ser texto.`);
  return v.trim();
}

function data(corpo: Record<string, unknown>, campo: string): string {
  const d = texto(corpo, campo)!;
  if (!DATA.test(d)) throw new ErroPedido(`"${campo}" no formato AAAA-MM-DD.`);
  return d;
}

function dadosCliente(corpo: Record<string, unknown>): DadosCliente {
  const d: DadosCliente = {};
  if (corpo.nome !== undefined) d.nome = String(corpo.nome);
  if (corpo.whatsapp !== undefined) d.whatsapp = corpo.whatsapp ? String(corpo.whatsapp) : null;
  if (corpo.horarioEnvio !== undefined) d.horarioEnvio = corpo.horarioEnvio ? String(corpo.horarioEnvio) : null;
  if (corpo.tomGrupo !== undefined) d.tomGrupo = corpo.tomGrupo ? String(corpo.tomGrupo) : null;
  if (corpo.limiteMensagensDia !== undefined && corpo.limiteMensagensDia !== '') d.limiteMensagensDia = Number(corpo.limiteMensagensDia);
  return d;
}

// ---------------------------------------------------------------------------
// Clientes e nichos
// ---------------------------------------------------------------------------

export async function cadastroClientes(deps: DepsApi) {
  const clientes = await listarCadastro(deps.sql);
  const comShopee = new Set((await deps.sql`
    select c.codigo from credenciais k join clientes c on c.cliente_id = k.cliente_id
    where k.plataforma = 'shopee' and k.nome = 'open_api'`).map((r) => r.codigo));
  return clientes.map((c) => ({ ...c, clienteId: undefined, shopeeApi: comShopee.has(c.codigo) }));
}

export async function novoCliente(deps: DepsApi, corpo: Record<string, unknown>) {
  const c = await criarCliente(deps.sql, texto(corpo, 'codigo')!.toLowerCase(), { ...dadosCliente(corpo), nome: texto(corpo, 'nome')! });
  return { ok: true, codigo: c.codigo };
}

export async function editarCliente(deps: DepsApi, codigo: string, corpo: Record<string, unknown>) {
  await atualizarCliente(deps.sql, codigo, dadosCliente(corpo));
  return { ok: true };
}

export async function ativarCliente(deps: DepsApi, codigo: string, corpo: Record<string, unknown>) {
  await definirAtivo(deps.sql, codigo, corpo.ativo === true);
  return { ok: true };
}

export async function salvarNichoCliente(deps: DepsApi, codigo: string, corpo: Record<string, unknown>) {
  const palavras = String(corpo.palavras ?? '').split(/[,\n;]/);
  const nichos = await salvarNicho(deps.sql, codigo, { nome: texto(corpo, 'nome')!, palavrasChave: palavras });
  return { ok: true, nichos };
}

export async function removerNichoCliente(deps: DepsApi, codigo: string, slug: string) {
  return { ok: true, nichos: await removerNicho(deps.sql, codigo, slug) };
}

export async function salvarShopeeCliente(deps: DepsApi, codigo: string, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, codigo);
  const chave = await importarChave(process.env.CREDENCIAIS_CHAVE);
  await salvarCredencialShopee(deps.sql, chave, cliente.clienteId, { appId: texto(corpo, 'appId')!, secret: texto(corpo, 'secret')! });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Importações (o navegador lê o arquivo e manda o texto)
// ---------------------------------------------------------------------------

export async function importarOfertas(deps: DepsApi, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente')!);
  const r = await importarPlanilhaShopee(deps.sql, cliente, texto(corpo, 'csv')!, { nichoPadrao: texto(corpo, 'nicho', false) });
  return { ok: true, dataColeta: r.dataColeta, gravadas: r.ofertas.length, novas: r.novas, atualizadas: r.atualizadas, erros: r.erros };
}

export async function importarVendasPlanilha(deps: DepsApi, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente')!);
  const { vendas, erros } = lerPlanilhaVendas(texto(corpo, 'csv')!, cliente.fusoHorario);
  const r = vendas.length ? await importarVendas(deps.sql, cliente, vendas) : null;
  return { ok: true, resultado: r, erros };
}

export const MODELOS_PLANILHA: Record<string, string> = {
  'ofertas-shopee.csv': join(RAIZ, 'docs', 'modelos', 'ofertas-shopee.csv'),
  'vendas.csv': join(RAIZ, 'docs', 'modelos', 'vendas.csv'),
};

// ---------------------------------------------------------------------------
// Relatórios
// ---------------------------------------------------------------------------

export async function fechamento(deps: DepsApi, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente')!);
  const inicio = data(corpo, 'de');
  const fim = data(corpo, 'ate');
  if (inicio > fim) throw new ErroPedido('A data inicial é depois da final.');
  const resumo = await resumoPeriodo(deps.sql, cliente, inicio, fim);
  let analise = null;
  if (corpo.comAnalise === true) {
    if (!deps.modelo) throw new ErroPedido('Leitura do Analista precisa da IA: configure a chave da API em Configuração.');
    analise = await analisarPeriodo(deps.sql, { cliente, inicio, fim, modelo: deps.modelo(), precos: deps.precos });
  }
  return {
    ok: true,
    resumo,
    leituras: (analise?.leituras ?? []).map((l) => ({ texto: l.texto, evidencias: l.evidencias })),
    texto: montarFechamento(cliente.nome, resumo, analise),
    propostas: (analise?.propostas ?? []).map((d) => ({ id: d.id, nicho: d.nicho, versao: d.versao, texto: d.texto })),
  };
}

export async function uso(deps: DepsApi, de: string | null, ate: string | null) {
  if (!de || !ate || !DATA.test(de) || !DATA.test(ate)) throw new ErroPedido('Informe o período (de e até).');
  return usoPorCliente(deps.sql, de, ate);
}

// ---------------------------------------------------------------------------
// Diretrizes e agentes
// ---------------------------------------------------------------------------

export async function diretrizesDoCliente(deps: DepsApi, codigo: string) {
  const cliente = await buscarCliente(deps.sql, codigo);
  return (await listarDiretrizes(deps.sql, cliente)).map((d) => ({
    id: d.id, nicho: d.nicho, versao: d.versao, texto: d.texto, situacao: d.situacao, propostaPor: d.propostaPor, criadoEm: d.criadoEm,
  }));
}

export async function novaDiretriz(deps: DepsApi, corpo: Record<string, unknown>) {
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente')!);
  const d = await proporDiretriz(deps.sql, cliente, texto(corpo, 'nicho')!, texto(corpo, 'texto')!, 'operador');
  return { ok: true, id: d.id, versao: d.versao };
}

const CONTRATOS: Record<string, () => Promise<any>> = {
  curador: contratoCurador, redator: contratoRedator, analista: contratoAnalista, atendente: contratoAtendente,
};

export async function testarAgente(deps: DepsApi, corpo: Record<string, unknown>) {
  if (!deps.modelo) throw new ErroPedido('Configure a chave da API do Claude em Configuração.');
  const nome = texto(corpo, 'agente')!;
  if (!CONTRATOS[nome]) throw new ErroPedido(`Agente desconhecido: ${nome}`);
  const cliente = await buscarCliente(deps.sql, texto(corpo, 'cliente')!);
  const { casos } = await carregarAgente(join(RAIZ, 'agents', nome));
  const inicio = new Date();
  const r = await rodarCasos(deps.sql, { contrato: await CONTRATOS[nome]!(), casos, modelo: deps.modelo(), clienteId: cliente.clienteId, precos: deps.precos });
  const [custo] = await deps.sql`
    select count(*)::int as chamadas, coalesce(sum(custo_usd), 0)::numeric(12,6)::text as custo
    from execucoes_agente where cliente_id = ${cliente.clienteId} and criado_em >= ${inicio}`;
  return { ok: true, casos: r, chamadas: custo!.chamadas, custoUsd: custo!.custo };
}
