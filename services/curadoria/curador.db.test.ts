import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import type { ModeloIA, PedidoModelo } from '../../harness/agentes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { aprovar, registrarEnvio, validarMensagem } from '../lista/lista.ts';
import { contratoRedator, redigirSelecionadas } from '../lista/redator.ts';
import { aprovarDiretriz, proporDiretriz } from './diretrizes.ts';
import { contratoCurador, curarDia, montarEntradaCurador, selecionadasDoDia } from './curador.ts';

const quando = new Date('2026-11-12T09:00:00Z');
const DIA = '2026-11-12';
const PLANILHA = [
  'link;titulo;preco;desconto;comissao;comissao_valor;nicho',
  'https://shopee.com.br/A-i.9.1;Organizador de Gaveta;29,90;25;12;3,59;casa',
  'https://shopee.com.br/B-i.9.2;Kit Potes Herméticos;49,90;40;10;4,99;casa',
  'https://shopee.com.br/C-i.9.3;Escorredor Dobrável;34,90;30;11;3,84;casa',
  'https://shopee.com.br/D-i.9.4;Pincéis de Maquiagem;39,90;50;9;3,59;beleza',
].join('\n');

/** Modelo falso que responde com uma função do pedido (para escolher IDs reais). */
function modeloFalso(responder: (p: PedidoModelo) => string) {
  const pedidos: PedidoModelo[] = [];
  const modelo: ModeloIA = { async gerar(p) { pedidos.push(p); return { texto: responder(p), tokensEntrada: 800, tokensSaida: 120 }; } };
  return { modelo, pedidos };
}
const escolher = (n: number) => (p: PedidoModelo) => {
  const e = JSON.parse(p.entrada) as { candidatas: { id: string }[] };
  return JSON.stringify({ escolhas: e.candidatas.slice(0, n).map((c) => ({ oferta_id: c.id, motivo: 'bom desconto' })) });
};

describe.skipIf(!BANCO_HABILITADO)('Curador', () => {
  let sql: Sql;
  let cliente: Cliente;
  const ambiente = { MODELO_IA_FORTE: 'modelo-forte-teste' };

  beforeAll(async () => { sql = await bancoLimpo(); cliente = await buscarCliente(sql, 'c1'); });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => {
    await sql`truncate mensagens, execucoes_agente, links, ofertas, diretrizes_nicho cascade`;
    await importarPlanilhaShopee(sql, cliente, PLANILHA, { quando });
  });

  it('entrada: candidatas do dia por comissão, diretrizes aprovadas e enviados recentes', async () => {
    const d = await proporDiretriz(sql, cliente, 'casa', 'Priorizar utilidades de cozinha.', 'operador');
    await proporDiretriz(sql, cliente, 'beleza', 'Proposta ainda não aprovada.', 'analista');
    await aprovarDiretriz(sql, cliente, d.id);
    const e = await montarEntradaCurador(sql, cliente, DIA, 3);
    expect(e.candidatas.map((c) => c.titulo)).toEqual(['Kit Potes Herméticos', 'Escorredor Dobrável', 'Organizador de Gaveta', 'Pincéis de Maquiagem']);
    expect(e.candidatas[0]).toMatchObject({ preco: 49.9, desconto_pct: 40, comissao_pct: 10, comissao_valor: 4.99, vendas: null });
    expect(e.diretrizes).toEqual({ casa: 'Priorizar utilidades de cozinha.' });
    expect(e.enviados_recentes).toEqual([]);
  });

  it('grava a escolha na oferta, em ordem; refazer substitui', async () => {
    const { modelo } = modeloFalso(escolher(3));
    const r = await curarDia(sql, { cliente, data: DIA, modelo, contrato: await contratoCurador(ambiente), quantidade: 3 });
    expect(r.escolhas.map((e) => [e.posicao, e.titulo])).toEqual([[1, 'Kit Potes Herméticos'], [2, 'Escorredor Dobrável'], [3, 'Organizador de Gaveta']]);
    const sel = await selecionadasDoDia(sql, cliente, DIA);
    expect(sel.map((s) => [s.posicao, s.motivo, s.linkId])).toEqual([[1, 'bom desconto', null], [2, 'bom desconto', null], [3, 'bom desconto', null]]);
    await curarDia(sql, { cliente, data: DIA, modelo: modeloFalso(escolher(1)).modelo, contrato: await contratoCurador(ambiente), quantidade: 1 });
    expect(await selecionadasDoDia(sql, cliente, DIA)).toHaveLength(1);
    const [e] = await sql`select modelo from execucoes_agente limit 1`;
    expect(e!.modelo).toBe('modelo-forte-teste');
  });

  it('ID inventado é recusado e repetido; sem candidatas, nem chama o modelo', async () => {
    let n = 0;
    const { modelo } = modeloFalso((p) => (++n === 1 ? JSON.stringify({ escolhas: [{ oferta_id: 'inventado', motivo: 'x' }] }) : escolher(1)(p)));
    const r = await curarDia(sql, { cliente, data: DIA, modelo, contrato: await contratoCurador(ambiente), quantidade: 1 });
    expect(r.escolhas).toHaveLength(1);
    const [falha] = await sql`select erro from execucoes_agente where not saida_valida`;
    expect(falha!.erro).toContain('fora da lista de candidatas');
    const vazio = modeloFalso(escolher(1));
    expect((await curarDia(sql, { cliente, data: '2026-11-20', modelo: vazio.modelo, contrato: await contratoCurador(ambiente) })).escolhas).toEqual([]);
    expect(vazio.pedidos).toHaveLength(0);
  });

  it('não oferece produto enviado nos últimos 7 dias', async () => {
    const { modelo } = modeloFalso(escolher(1));
    await curarDia(sql, { cliente, data: DIA, modelo, contrato: await contratoCurador(ambiente), quantidade: 1 });
    const [s] = await selecionadasDoDia(sql, cliente, DIA);
    await registrarLinkManual(sql, { cliente, ofertaId: s!.ofertaId, link: 'https://s.shopee.com.br/K2', quando });
    const redacao = modeloFalso(() => '{"texto_modelo":"Achado {{preco}} 👉 {{link}}"}');
    const r = await redigirSelecionadas(sql, { cliente, data: DIA, modelo: redacao.modelo, contrato: await contratoRedator({}) });
    const m = r.redigidas[0]!.mensagemId;
    await validarMensagem(sql, m, { agora: quando });
    await aprovar(sql, cliente, m, 'op');
    await registrarEnvio(sql, cliente, m);
    // nova coleta do mesmo produto no dia seguinte
    await importarPlanilhaShopee(sql, cliente, PLANILHA, { quando: new Date('2026-11-13T09:00:00Z') });
    const e = await montarEntradaCurador(sql, cliente, '2026-11-13', 5);
    expect(e.candidatas.map((c) => c.titulo)).not.toContain('Kit Potes Herméticos');
    expect(e.enviados_recentes).toEqual(['Kit Potes Herméticos']);
  });

  it('redação do dia: só escolhidas com link; as sem link ficam listadas; não duplica', async () => {
    await curarDia(sql, { cliente, data: DIA, modelo: modeloFalso(escolher(3)).modelo, contrato: await contratoCurador(ambiente), quantidade: 3 });
    const sel = await selecionadasDoDia(sql, cliente, DIA);
    await registrarLinkManual(sql, { cliente, ofertaId: sel[0]!.ofertaId, link: 'https://s.shopee.com.br/L1', quando });
    const redacao = modeloFalso(() => '{"texto_modelo":"Achado {{preco}} 👉 {{link}}"}');
    const r = await redigirSelecionadas(sql, { cliente, data: DIA, modelo: redacao.modelo, contrato: await contratoRedator({}) });
    expect(r.redigidas).toHaveLength(1);
    expect(r.semLink.map((x) => x.titulo)).toEqual(['Escorredor Dobrável', 'Organizador de Gaveta']);
    const r2 = await redigirSelecionadas(sql, { cliente, data: DIA, modelo: redacao.modelo, contrato: await contratoRedator({}) });
    expect(r2).toMatchObject({ redigidas: [], jaTinhamMensagem: 1 });
  });
});
