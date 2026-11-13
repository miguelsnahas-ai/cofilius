/**
 * Fechamento semanal para mandar à afiliada pelo WhatsApp.
 *
 * O texto é montado aqui, pelo código, com os números do banco (vendas, cliques, desempenho das
 * postagens). Da IA entram no máximo duas frases de leitura do Analista, que já passaram pela regra
 * de não escrever valores. Fica gravado em `fechamentos` como "pronto" até o operador mandar.
 */
import type { Sql } from '../../harness/db.ts';
import { log } from '../../harness/log.ts';
import type { Cliente } from '../../db/clientes.ts';
import { formatarPreco } from '../lista/marcadores.ts';
import { resultadosPeriodo } from './resultados.ts';
import { desempenhoPostagens } from './desempenho.ts';
import { canceladosDePedidosAnteriores } from '../vendas/avisos.ts';
import { ErroForaDaJanela, type Canal } from '../disparador/disparador.ts';
import { ErroWhatsapp, ERRO_FORA_DA_JANELA } from '../disparador/whatsapp.ts';

export interface DadosFechamento {
  inicio: string;
  fim: string;
  comissaoValidada: number;
  comissaoPendente: number;
  comissaoCancelada: number;
  pedidos: number;
  cancelados: number;
  cliques: number;
  /** Comissão não cancelada da semana anterior (mesmo tamanho de período). */
  anterior: number;
  porPlataforma: { plataforma: string; comissao: number }[];
  maisVendidos: { nome: string; pedidos: number; comissao: number }[];
  nichoDestaque: { nicho: string; pedidos: number; comissao: number } | null;
  /** Pedidos de semanas anteriores que foram cancelados nesta semana (saem do pendente). */
  canceladosAnteriores?: { pedidos: number; comissao: number };
}

const NOMES_PLATAFORMA: Record<string, string> = { shopee: 'Shopee', mercado_livre: 'Mercado Livre', amazon: 'Amazon' };
const reais = (v: number) => formatarPreco(v.toFixed(2));
const dataCurta = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const arred = (n: number) => Math.round(n * 100) / 100;

function deslocar(data: string, dias: number): string {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Junta os números do período, todos do banco. */
export async function dadosFechamento(sql: Sql, cliente: Cliente, inicio: string, fim: string): Promise<DadosFechamento> {
  const r = await resultadosPeriodo(sql, cliente, inicio, fim);
  const dias = Math.round((Date.parse(`${fim}T12:00:00Z`) - Date.parse(`${inicio}T12:00:00Z`)) / 864e5) + 1;
  const ant = await resultadosPeriodo(sql, cliente, deslocar(inicio, -dias), deslocar(inicio, -1));
  const porPlataforma = await sql`
    select plataforma, coalesce(sum(comissao), 0)::float8 as comissao from vendas v
    where v.cliente_id = ${cliente.clienteId} and situacao <> 'cancelada'
      and (v.data_pedido at time zone ${cliente.fusoHorario})::date between ${inicio} and ${fim}
    group by 1 having sum(comissao) > 0 order by 2 desc, 1`;
  // Nicho que mais rendeu entre as postagens enviadas na semana.
  const posts = await desempenhoPostagens(sql, cliente, { de: inicio, ate: fim });
  const nichos = new Map<string, { pedidos: number; comissao: number }>();
  for (const p of posts) {
    if (!p.nicho) continue;
    const n = nichos.get(p.nicho) ?? { pedidos: 0, comissao: 0 };
    n.pedidos += p.pedidos;
    n.comissao += p.comissaoPendente + p.comissaoValidada;
    nichos.set(p.nicho, n);
  }
  // Nome do nicho como cadastrado ("Bebê"), não o código ("bebe").
  const [cad] = await sql`select nichos from clientes where cliente_id = ${cliente.clienteId}`;
  const nomeNicho = new Map(((cad?.nichos ?? []) as { slug: string; nome?: string }[]).map((n) => [n.slug, n.nome || n.slug]));
  const [melhorNicho] = [...nichos.entries()].filter(([, n]) => n.pedidos > 0).sort((a, b) => b[1].comissao - a[1].comissao || a[0].localeCompare(b[0]));
  const t = r.totais;
  return {
    inicio, fim,
    comissaoValidada: Number(t.comissaoValidada), comissaoPendente: Number(t.comissaoPendente), comissaoCancelada: Number(t.comissaoCancelada),
    pedidos: t.pedidos, cancelados: t.pedidosCancelados, cliques: t.cliques,
    anterior: arred(Number(ant.totais.comissaoValidada) + Number(ant.totais.comissaoPendente)),
    porPlataforma: porPlataforma.map((p) => ({ plataforma: p.plataforma, comissao: arred(p.comissao) })),
    maisVendidos: r.produtos.slice(0, 3).map((p) => ({ nome: (p.nome ?? `Produto ${p.produtoId}`).slice(0, 60), pedidos: p.pedidos, comissao: Number(p.comissao) })),
    canceladosAnteriores: await canceladosDePedidosAnteriores(sql, cliente, inicio, fim),
    nichoDestaque: melhorNicho ? { nicho: nomeNicho.get(melhorNicho[0]) ?? melhorNicho[0], pedidos: melhorNicho[1].pedidos, comissao: arred(melhorNicho[1].comissao) } : null,
  };
}

function linhaCanceladosAnteriores(d: DadosFechamento): string | null {
  const ant = d.canceladosAnteriores;
  if (!ant || ant.pedidos === 0) return null;
  const quem = ant.pedidos === 1 ? '1 pedido de semanas anteriores foi cancelado' : `${ant.pedidos} pedidos de semanas anteriores foram cancelados`;
  return `↩️ ${quem}${ant.comissao > 0 ? ` (${reais(ant.comissao)} saem do pendente)` : ''}`;
}

/** Texto do WhatsApp, curto e no tom de quem acompanha o grupo dela. Função pura. */
export function textoFechamentoAfiliada(nome: string, d: DadosFechamento, leituras: string[] = []): string {
  const primeiro = nome.trim().split(/\s+/)[0] || nome;
  const total = arred(d.comissaoValidada + d.comissaoPendente);
  const plural = (n: number, um: string, varios: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`;
  const l: string[] = [];
  l.push(`Oi, ${primeiro}! 👋 Seu resumo da semana (${dataCurta(d.inicio)} a ${dataCurta(d.fim)}):`, '');

  if (total === 0 && d.pedidos === 0) {
    l.push('Essa semana ainda não entrou nenhuma venda pelo grupo.');
    if (d.cliques > 0) l.push(`Mas teve ${plural(d.cliques, 'clique', 'cliques')} nos links: o pessoal está olhando! 👀`);
    const linha = linhaCanceladosAnteriores(d);
    if (linha) l.push('', linha);
    l.push('', 'Seguimos ajustando as ofertas para o gosto do grupo. Até a próxima semana! 💜');
    return l.join('\n');
  }

  l.push(`💰 *Comissão da semana: ${reais(total)}*`);
  if (d.comissaoValidada > 0) l.push(`✅ ${reais(d.comissaoValidada)} já confirmada`);
  if (d.comissaoPendente > 0) l.push(`⏳ ${reais(d.comissaoPendente)} pendente (confirma depois que o pedido é entregue)`);
  if (d.porPlataforma.length > 1) l.push(d.porPlataforma.map((p) => `${NOMES_PLATAFORMA[p.plataforma] ?? p.plataforma} ${reais(p.comissao)}`).join(' · '));
  l.push(`📦 ${plural(d.pedidos, 'pedido', 'pedidos')}${d.cliques ? ` · 👆 ${plural(d.cliques, 'clique', 'cliques')}` : ''}`);

  const diferenca = arred(total - d.anterior);
  if (d.anterior > 0 && Math.abs(diferenca) >= 0.01) {
    l.push(diferenca > 0
      ? `📈 ${reais(diferenca)} a mais que na semana anterior`
      : `📉 ${reais(-diferenca)} a menos que na semana anterior`);
  } else if (d.anterior === 0 && total > 0) {
    l.push('📈 Melhor que a semana anterior, que não teve vendas');
  }

  if (d.maisVendidos.length) {
    l.push('', '🏆 *Mais vendidos pelo grupo*');
    d.maisVendidos.forEach((p, i) => l.push(`${i + 1}. ${p.nome} · ${plural(p.pedidos, 'pedido', 'pedidos')} · ${reais(p.comissao)}`));
  }
  if (d.nichoDestaque) {
    l.push('', `✨ O que mais funcionou: *${d.nichoDestaque.nicho}* (${plural(d.nichoDestaque.pedidos, 'pedido', 'pedidos')}, ${reais(d.nichoDestaque.comissao)})`);
  }
  const ant = d.canceladosAnteriores;
  if (d.cancelados > 0 || (ant && ant.pedidos > 0)) l.push('');
  if (d.cancelados > 0) {
    l.push(`❌ ${plural(d.cancelados, 'pedido cancelado', 'pedidos cancelados')}${d.comissaoCancelada > 0 ? ` (${reais(d.comissaoCancelada)} que não entram)` : ''}`);
  }
  if (ant && ant.pedidos > 0) l.push(linhaCanceladosAnteriores(d)!);
  const dicas = leituras.map((x) => x.trim()).filter(Boolean).slice(0, 2);
  if (dicas.length) {
    l.push('', '💡 *Para a próxima semana*');
    for (const dica of dicas) l.push(`• ${dica}`);
  }
  l.push('', 'Até a próxima semana! 💜');
  return l.join('\n');
}

export interface Fechamento {
  id: string;
  inicio: string;
  fim: string;
  texto: string;
  situacao: 'pronto' | 'enviado';
  enviadoEm: string | null;
  canal: string | null;
}

function paraFechamento(f: Record<string, any>): Fechamento {
  return {
    id: f.id, inicio: f.inicio, fim: f.fim, texto: f.texto, situacao: f.situacao,
    enviadoEm: f.enviado_em ? new Date(f.enviado_em).toISOString() : null, canal: f.canal,
  };
}

const COLUNAS = (sql: Sql) => sql`id, to_char(inicio, 'YYYY-MM-DD') as inicio, to_char(fim, 'YYYY-MM-DD') as fim, texto, situacao, enviado_em, canal`;

/** Monta e grava (ou atualiza, se ainda não foi enviado) o fechamento do período. */
export async function prepararFechamento(
  sql: Sql, cliente: Cliente, inicio: string, fim: string, leituras: string[] = [],
): Promise<Fechamento> {
  const dados = await dadosFechamento(sql, cliente, inicio, fim);
  const texto = textoFechamentoAfiliada(cliente.nome, dados, leituras);
  const [f] = await sql`
    insert into fechamentos (cliente_id, inicio, fim, texto, dados)
    values (${cliente.clienteId}, ${inicio}, ${fim}, ${texto}, ${sql.json(dados as never)})
    on conflict (cliente_id, inicio, fim) do update set
      texto = case when fechamentos.situacao = 'pronto' then excluded.texto else fechamentos.texto end,
      dados = case when fechamentos.situacao = 'pronto' then excluded.dados else fechamentos.dados end
    returning ${COLUNAS(sql)}`;
  log.info('fechamento.preparado', { cliente: cliente.codigo, inicio, fim, situacao: f!.situacao });
  return paraFechamento(f!);
}

/** O fechamento mais recente ainda não enviado (dos últimos 14 dias), ou null. */
export async function fechamentoPronto(sql: Sql, cliente: Cliente, hoje: string): Promise<Fechamento | null> {
  const [f] = await sql`
    select ${COLUNAS(sql)} from fechamentos
    where cliente_id = ${cliente.clienteId} and situacao = 'pronto' and fim >= ${deslocar(hoje, -14)}::date
    order by fim desc limit 1`;
  return f ? paraFechamento(f) : null;
}

/** Envia pelo canal (manual = só registra) e marca como enviado. */
export async function enviarFechamento(sql: Sql, cliente: Cliente, id: string, canal: Canal, agora = new Date()): Promise<Fechamento> {
  const [f] = await sql`
    select f.texto, f.situacao, c.whatsapp from fechamentos f join clientes c on c.cliente_id = f.cliente_id
    where f.id = ${id} and f.cliente_id = ${cliente.clienteId}`;
  if (!f) throw new Error('Fechamento não encontrado.');
  if (f.situacao === 'enviado') throw new Error('Este fechamento já foi enviado.');
  if (canal.nome === 'whatsapp' && !f.whatsapp) throw new Error('Cliente sem WhatsApp cadastrado.');
  let idExterno: string | null;
  try {
    idExterno = await canal.enviar(f.whatsapp ?? '', f.texto);
  } catch (erro) {
    if (erro instanceof ErroWhatsapp && erro.codigo === ERRO_FORA_DA_JANELA) throw new ErroForaDaJanela();
    throw erro;
  }
  const [g] = await sql`
    update fechamentos set situacao = 'enviado', enviado_em = ${agora}, canal = ${canal.nome}, id_externo = ${idExterno}
    where id = ${id} and situacao = 'pronto' returning ${COLUNAS(sql)}`;
  log.info('fechamento.enviado', { cliente: cliente.codigo, id, canal: canal.nome });
  return paraFechamento(g!);
}
