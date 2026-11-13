import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import type { ModeloIA, PedidoModelo } from '../../harness/agentes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { aprovar, criarRascunho, registrarEnvio, validarMensagem } from '../lista/lista.ts';
import { importarVendas, registrarCliques, resumoPeriodo } from '../vendas/atribuicao.ts';
import { aprovarDiretriz, diretrizesVigentes, listarDiretrizes, proporDiretriz } from '../curadoria/diretrizes.ts';
import { calcularIndicadores } from './indicadores.ts';
import { analisarPeriodo, contratoAnalista } from './analista.ts';
import { montarFechamento } from './fechamento.ts';

const ambiente = { MODELO_IA_FORTE: 'modelo-forte-teste' };

function modeloFalso(respostas: string[]) {
  const pedidos: PedidoModelo[] = [];
  const modelo: ModeloIA = { async gerar(p) { pedidos.push(p); const r = respostas.shift(); if (!r) throw new Error('sem resposta'); return { texto: r, tokensEntrada: 2000, tokensSaida: 300 }; } };
  return { modelo, pedidos };
}

describe.skipIf(!BANCO_HABILITADO)('indicadores, Analista e fechamento', () => {
  let sql: Sql;
  let cliente: Cliente;

  /** Publica uma oferta: planilha → link → mensagem → enviada no horário dado; devolve a chave de rastreio. */
  async function publicar(produto: string, titulo: string, preco: string, nicho: string, enviadaEm: string) {
    const quando = new Date(enviadaEm);
    const r = await importarPlanilhaShopee(sql, cliente, `link;titulo;preco;nicho\nhttps://shopee.com.br/P-i.9.${produto};${titulo};${preco};${nicho}`, { quando });
    const ofertaId = r.ofertas[0]!.id;
    const l = await registrarLinkManual(sql, { cliente, ofertaId, link: `https://s.shopee.com.br/L${produto}`, quando });
    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(quando);
    const m = await criarRascunho(sql, { cliente, ofertaId, textoModelo: 'Achado {{preco}} 👉 {{link}}', dataLista: dia });
    await validarMensagem(sql, m.id, { agora: quando });
    await aprovar(sql, cliente, m.id, 'op');
    await registrarEnvio(sql, cliente, m.id, new Date(Math.max(Date.now(), quando.getTime())));
    await sql`update mensagens set enviada_em = ${quando} where id = ${m.id}`;
    return { chave: l.chaveRastreio, dia };
  }

  beforeAll(async () => { sql = await bancoLimpo(); cliente = await buscarCliente(sql, 'c1'); });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate vendas, cliques, mensagens, execucoes_agente, links, ofertas, diretrizes_nicho cascade`; });

  async function semana() {
    // 08:00 e 19:00 em São Paulo = 11:00 e 22:00 UTC
    const a = await publicar('1', 'Potes Herméticos', '39,90', 'casa', '2026-11-10T11:00:00Z');
    const b = await publicar('2', 'Air Fryer 4L', '289,90', 'casa', '2026-11-11T22:00:00Z');
    const c = await publicar('3', 'Kit Pincéis', '45,00', 'beleza', '2026-11-12T11:00:00Z');
    const venda = (pedido: string, produto: string, chave: string, comissao: string, situacao: 'pendente' | 'validada' | 'cancelada') => ({
      plataforma: 'shopee' as const, pedidoId: pedido, produtoId: produto, situacao, valor: '10.00', comissao, chaveRastreio: chave,
      dataPedido: new Date('2026-11-12T15:00:00Z'),
    });
    await importarVendas(sql, cliente, [
      venda('V1', '1', a.chave, '4.00', 'validada'), venda('V2', '1', a.chave, '3.00', 'pendente'),
      venda('V3', '2', b.chave, '20.00', 'cancelada'), venda('V4', '3', c.chave, '2.00', 'pendente'),
      venda('V5', '99', 'c1-wa-20261101-77-0800', '1.00', 'validada'),
    ]);
    await registrarCliques(sql, cliente, [
      { plataforma: 'shopee', chaveRastreio: a.chave, dia: '2026-11-10', cliques: 30 },
      { plataforma: 'shopee', chaveRastreio: b.chave, dia: '2026-11-11', cliques: 12 },
      { plataforma: 'shopee', chaveRastreio: c.chave, dia: '2026-11-12', cliques: 8 },
    ]);
  }

  it('indicadores por nicho, horário, faixa de preço e postagem, sem comissão cancelada', async () => {
    await semana();
    const i = await calcularIndicadores(sql, cliente, '2026-11-09', '2026-11-15');
    const por = Object.fromEntries(i.linhas.map((l) => [l.ref, l]));
    expect(i.totais).toEqual({ mensagens: 3, cliques: 50, pedidos: 3, comissao: 9 });
    expect(por['nicho:casa']).toMatchObject({ mensagens: 2, cliques: 42, pedidos: 2, comissao: 7 });
    expect(por['horario:08']).toMatchObject({ mensagens: 2, cliques: 38, comissao: 9 });
    expect(por['horario:19']).toMatchObject({ mensagens: 1, pedidos: 0, comissao: 0 });
    expect(por['preco:200-mais']).toMatchObject({ rotulo: 'acima de R$ 200', mensagens: 1 });
    expect(i.linhas.filter((l) => l.dimensao === 'postagem').map((l) => l.rotulo)).toEqual(['Potes Herméticos', 'Kit Pincéis', 'Air Fryer 4L']);
  });

  it('Analista: propõe diretriz (sem aprovar), liga leituras aos dados e recusa ref inventada ou valor escrito', async () => {
    await semana();
    const d = await proporDiretriz(sql, cliente, 'casa', 'Priorizar cozinha.', 'operador');
    await aprovarDiretriz(sql, cliente, d.id);
    const ok = {
      diretrizes: [{ nicho: 'casa', texto: 'Priorizar utilidades até R$ 60; evitar eletroportáteis caros.', refs: ['nicho:casa', 'preco:200-mais'] }],
      insights: [
        { texto: 'Casa rendeu mais que beleza.', refs: ['nicho:casa', 'nicho:beleza'] },
        { texto: 'As postagens das 8h foram melhores que as da noite.', refs: ['horario:08', 'horario:19'] },
        { texto: 'Produto caro chamou clique, mas não vendeu.', refs: ['preco:200-mais'] },
      ],
    };
    const { modelo, pedidos } = modeloFalso([
      JSON.stringify({ ...ok, insights: [{ texto: 'Casa rendeu R$ 7,00.', refs: ['nicho:casa'] }, ok.insights[1], { texto: 'x', refs: ['nicho:pets'] }] }),
      JSON.stringify(ok),
    ]);
    const r = await analisarPeriodo(sql, { cliente, inicio: '2026-11-09', fim: '2026-11-15', modelo, contrato: await contratoAnalista(ambiente) });
    expect(pedidos[1]!.correcao).toContain('valor em reais');
    expect(pedidos[1]!.correcao).toContain('ref inexistente: nicho:pets');
    expect(r.leituras[0]!.evidencias.map((e) => e.ref)).toEqual(['nicho:casa', 'nicho:beleza']);
    expect(r.propostas).toHaveLength(1);
    expect(r.propostas[0]).toMatchObject({ nicho: 'casa', versao: 2, situacao: 'proposta', propostaPor: 'analista' });
    // a diretriz em vigor continua a do operador até a aprovação
    expect((await diretrizesVigentes(sql, cliente)).casa!.texto).toBe('Priorizar cozinha.');
    const entrada = JSON.parse(pedidos[0]!.entrada);
    expect(entrada.diretrizes_atuais).toEqual({ casa: 'Priorizar cozinha.' });
    expect(entrada.nichos).toEqual(['casa', 'beleza']);
  });

  it('sem mensagens no período, não chama o modelo', async () => {
    const { modelo, pedidos } = modeloFalso([]);
    const r = await analisarPeriodo(sql, { cliente, inicio: '2026-01-01', fim: '2026-01-07', modelo, contrato: await contratoAnalista(ambiente) });
    expect(r.semDados).toBe(true);
    expect(pedidos).toHaveLength(0);
    expect(await listarDiretrizes(sql, cliente)).toEqual([]);
  });

  it('fechamento: números do banco e cada leitura com seu dado', async () => {
    await semana();
    const resposta = {
      diretrizes: [],
      insights: [
        { texto: 'Casa rendeu mais que beleza.', refs: ['nicho:casa'] },
        { texto: 'Manhã foi melhor que noite.', refs: ['horario:08', 'horario:19'] },
        { texto: 'Produto caro não vendeu.', refs: ['preco:200-mais'] },
      ],
    };
    const analise = await analisarPeriodo(sql, { cliente, inicio: '2026-11-09', fim: '2026-11-15', modelo: modeloFalso([JSON.stringify(resposta)]).modelo, contrato: await contratoAnalista(ambiente) });
    const resumo = await resumoPeriodo(sql, cliente, '2026-11-09', '2026-11-15');
    const texto = montarFechamento('Cliente Teste', resumo, analise);
    expect(texto).toContain('*Fechamento 09/11/2026 a 15/11/2026* · Cliente Teste');
    expect(texto).toContain('Comissão validada: R$ 5,00');
    expect(texto).toContain('Comissão pendente: R$ 5,00');
    expect(texto).toContain('Cancelada no período: R$ 20,00');
    expect(texto).toContain('Vendas sem postagem identificada: 1 (R$ 1,00)');
    expect(texto).toContain('1. Casa rendeu mais que beleza.\n   ↳ casa: 2 mensagens · 42 cliques · 2 pedidos · R$ 7,00');
    expect(texto).toContain('↳ 19h: 1 mensagem · 12 cliques · 0 pedidos · R$ 0,00');
  });
});
