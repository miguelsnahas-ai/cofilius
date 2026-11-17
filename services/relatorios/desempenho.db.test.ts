import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import type { ModeloIA, PedidoModelo } from '../../harness/agentes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { aprovar, criarRascunho, registrarEnvio, validarMensagem } from '../lista/lista.ts';
import { importarVendas, registrarCliques } from '../vendas/atribuicao.ts';
import { curarDia, montarEntradaCurador } from '../curadoria/curador.ts';
import { desempenhoParaCurador, desempenhoPostagens } from './desempenho.ts';

describe.skipIf(!BANCO_HABILITADO)('desempenho por postagem', () => {
  let sql: Sql;
  let cliente: Cliente;

  /** Planilha → link → mensagem enviada no instante dado. */
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
    return { chave: l.chaveRastreio, mensagemId: m.id };
  }

  const venda = (pedido: string, produto: string, chave: string, comissao: string, situacao: 'pendente' | 'validada' | 'cancelada') => ({
    plataforma: 'shopee' as const, pedidoId: pedido, produtoId: produto, situacao, valor: '10.00', comissao, chaveRastreio: chave,
    dataPedido: new Date('2026-11-12T15:00:00Z'),
  });

  beforeAll(async () => { sql = await bancoLimpo(); cliente = await buscarCliente(sql, 'c1'); });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate vendas, cliques, mensagens, execucoes_agente, links, ofertas, diretrizes_nicho cascade`; });

  async function cenario() {
    const a = await publicar('1', 'Kit Bodies Bebê', '49,90', 'bebe', '2026-11-10T11:00:00Z');
    const b = await publicar('2', 'Fone Bluetooth', '89,90', 'eletronicos', '2026-11-11T11:00:00Z');
    const c = await publicar('3', 'Babador Silicone', '24,90', 'bebe', '2026-11-12T11:00:00Z');
    await importarVendas(sql, cliente, [
      venda('V1', '1', a.chave, '4.00', 'validada'), venda('V2', '1', a.chave, '3.00', 'pendente'),
      venda('V3', '2', b.chave, '9.00', 'cancelada'), venda('V4', '3', c.chave, '2.00', 'pendente'),
    ]);
    await registrarCliques(sql, cliente, [
      { plataforma: 'shopee', chaveRastreio: a.chave, dia: '2026-11-10', cliques: 30 },
      { plataforma: 'shopee', chaveRastreio: a.chave, dia: '2026-11-11', cliques: 5 },
      { plataforma: 'shopee', chaveRastreio: b.chave, dia: '2026-11-11', cliques: 4 },
    ]);
    return { a, b, c };
  }

  it('cliques, pedidos e comissão de cada mensagem enviada', async () => {
    const { a, b, c } = await cenario();
    const d = new Map((await desempenhoPostagens(sql, cliente, { ids: [a.mensagemId, b.mensagemId, c.mensagemId] })).map((x) => [x.mensagemId, x]));
    expect(d.get(a.mensagemId)).toMatchObject({ medivel: true, cliques: 35, pedidos: 2, cancelados: 0, comissaoPendente: 3, comissaoValidada: 4 });
    expect(d.get(b.mensagemId)).toMatchObject({ cliques: 4, pedidos: 0, cancelados: 1, comissaoPendente: 0, comissaoValidada: 0 });
    expect(d.get(c.mensagemId)).toMatchObject({ cliques: 0, pedidos: 1, comissaoPendente: 2 });
    expect(await desempenhoPostagens(sql, cliente, { ids: [] })).toEqual([]);
  });

  it('resumo para o Curador: últimas 4 semanas antes do dia, por nicho e preço, melhores e sem resultado', async () => {
    await cenario();
    const r = await desempenhoParaCurador(sql, cliente, '2026-11-12');
    // O dia 12 não entra (ainda não mediu): só as postagens dos dias 10 e 11.
    expect(r).toMatchObject({ periodo: { de: '2026-10-15', ate: '2026-11-11' }, postagens: 2, amostra_pequena: true });
    expect(r!.por_nicho).toEqual([
      { grupo: 'bebe', postagens: 1, cliques_por_postagem: 35, pedidos: 2, comissao: 7 },
      { grupo: 'eletronicos', postagens: 1, cliques_por_postagem: 4, pedidos: 0, comissao: 0 },
    ]);
    expect(r!.por_faixa_preco.map((g) => g.grupo)).toEqual(['até R$ 50', 'R$ 50 a R$ 100']);
    expect(r!.melhores).toEqual([{ titulo: 'Kit Bodies Bebê', nicho: 'bebe', preco: 49.9, cliques: 35, pedidos: 2, comissao: 7 }]);
    expect(r!.sem_resultado).toEqual([{ titulo: 'Fone Bluetooth', nicho: 'eletronicos', preco: 89.9, cliques: 4 }]);
    expect(await desempenhoParaCurador(sql, cliente, '2026-11-10')).toBeNull();
  });

  it('o Curador recebe o desempenho na entrada', async () => {
    await cenario();
    await importarPlanilhaShopee(sql, cliente, 'link;titulo;preco;nicho\nhttps://shopee.com.br/P-i.9.50;Toalha Bebê;34,90;bebe', { quando: new Date('2026-11-13T09:00:00Z') });
    const entrada = await montarEntradaCurador(sql, cliente, '2026-11-13', 1);
    expect(entrada.desempenho_recente?.postagens).toBe(3);
    const pedidos: PedidoModelo[] = [];
    const modelo: ModeloIA = { async gerar(p) { pedidos.push(p); return { texto: JSON.stringify({ escolhas: [{ oferta_id: entrada.candidatas[0]!.id, motivo: 'nicho que mais vende' }] }), tokensEntrada: 1, tokensSaida: 1 }; } };
    const r = await curarDia(sql, { cliente, data: '2026-11-13', modelo, quantidade: 1 });
    expect(r.escolhas).toHaveLength(1);
    expect(JSON.stringify(pedidos[0])).toContain('desempenho_recente');
    expect(JSON.stringify(pedidos[0])).toContain('Kit Bodies');
  });
});
