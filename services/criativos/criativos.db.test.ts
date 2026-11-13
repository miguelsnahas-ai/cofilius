import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import type { ModeloIA, PedidoModelo } from '../../harness/agentes.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { criarCriativo, criativosDoDia, mudarEstadoCriativo, registrarLinkCriativo } from './criativos.ts';
import { importarVendas, registrarCliques } from '../vendas/atribuicao.ts';
import { resultadosPeriodo } from '../relatorios/resultados.ts';
import { desempenhoParaCurador } from '../relatorios/desempenho.ts';
import { horarioLocalParaData } from '../etiquetas/etiquetas.ts';

describe.skipIf(!BANCO_HABILITADO)('criativos', () => {
  let sql: Sql;
  let cliente: Cliente;
  beforeAll(async () => { sql = await bancoLimpo(); cliente = await buscarCliente(sql, 'c1'); });
  afterAll(async () => { await sql?.end(); });

  it('a IA escreve com marcadores; o sistema mostra preço e desconto atuais, link e foto; estados', async () => {
    const quando = new Date('2026-11-13T09:00:00Z');
    const o = await importarPlanilhaShopee(sql, cliente,
      'link;titulo;preco;desconto;imagem\nhttps://shopee.com.br/P-i.9.555;Organizador de Gaveta;29,90;25;https://down-br.img.susercontent.com/file/abc', { quando });
    const ofertaId = o.ofertas[0]!.id;
    await registrarLinkManual(sql, { cliente, ofertaId, link: 'https://s.shopee.com.br/L555', quando });
    const pedidos: PedidoModelo[] = [];
    const respostas = [
      // 1ª: escreve o preço (recusada pela regra), 2ª: correta
      { gancho: 'Por R$ 29,90 só hoje', telas: [1, 2, 3, 4].map(() => ({ titulo: 'Gaveta em ordem', texto: 'Cabe tudo.' })), cta: 'Comenta EU QUERO', legenda: 'Ordem na casa ✨' },
      { gancho: 'Sua gaveta nunca mais igual', telas: [1, 2, 3, 4].map(() => ({ titulo: 'Gaveta em ordem', texto: 'Com {{desconto}} de desconto.' })), cta: 'Comenta EU QUERO', legenda: 'Só {{preco}} ✨ #achadinhos' },
    ];
    const modelo: ModeloIA = { async gerar(p) { pedidos.push(p); return { texto: JSON.stringify(respostas.shift()), tokensEntrada: 1, tokensSaida: 1 }; } };
    const id = await criarCriativo(sql, { cliente, ofertaId, formato: 'carrossel', dataLista: '2026-11-13', modelo });
    expect(pedidos).toHaveLength(2);
    expect(JSON.stringify(pedidos[0])).not.toContain('29');
    let [c] = await criativosDoDia(sql, cliente, '2026-11-13');
    // Não reaproveita o link do WhatsApp: mostra os sub_ids do canal "ig" para gerar o link próprio.
    expect(c).toMatchObject({ id, formato: 'carrossel', estado: 'rascunho', preco: 'R$ 29,90', desconto: '25%', link: null, desempenho: null,
      imagemUrl: 'https://down-br.img.susercontent.com/file/abc' });
    expect(c!.preparoLink!.subIds.slice(0, 2)).toEqual(['c1', 'ig']);
    expect(c!.roteiro.telas[0]!.texto).toBe('Com 25% de desconto.');
    expect(c!.roteiro.legenda).toBe('#publi Só R$ 29,90 ✨ #achadinhos');
    // O preço mudou no banco: o criativo mostra o novo.
    await sql`update ofertas set preco = 27.5 where id = ${ofertaId}`;
    [c] = await criativosDoDia(sql, cliente, '2026-11-13');
    expect(c!.roteiro.legenda).toBe('#publi Só R$ 27,50 ✨ #achadinhos');

    // Link do Instagram colado do painel da Shopee, com os sub_ids mostrados.
    await expect(registrarLinkCriativo(sql, cliente, id, 'https://s.shopee.com.br/L555', horarioLocalParaData(c!.preparoLink!.quando)))
      .rejects.toThrow('já foi registrado'); // o link do WhatsApp não serve
    const linkIg = await registrarLinkCriativo(sql, cliente, id, 'https://s.shopee.com.br/IG555', horarioLocalParaData(c!.preparoLink!.quando));
    const [l] = await sql`select canal, chave_rastreio, sub_ids from links where id = ${linkIg}`;
    expect(l!.canal).toBe('ig');
    expect(l!.sub_ids[1]).toBe('ig');
    await expect(registrarLinkCriativo(sql, cliente, id, 'https://s.shopee.com.br/IG556', new Date())).rejects.toThrow('já tem link');
    [c] = await criativosDoDia(sql, cliente, '2026-11-13');
    expect(c).toMatchObject({ link: 'https://s.shopee.com.br/IG555', preparoLink: null, desempenho: { cliques: 0, pedidos: 0, comissao: 0 } });

    expect(await mudarEstadoCriativo(sql, cliente, id, 'aprovar')).toBe('aprovado');
    expect(await mudarEstadoCriativo(sql, cliente, id, 'publicado')).toBe('publicado');
    await expect(mudarEstadoCriativo(sql, cliente, id, 'descartar')).rejects.toThrow('outro estado');

    // Vendas e cliques chegam pela chave de cada link: Instagram e WhatsApp separados.
    const [wa] = await sql`select chave_rastreio from links where url_afiliado = 'https://s.shopee.com.br/L555'`;
    const venda = (pedido: string, chave: string, comissao: string) => ({ plataforma: 'shopee' as const, pedidoId: pedido, produtoId: '555',
      situacao: 'pendente' as const, valor: '29.90', comissao, chaveRastreio: chave, dataPedido: new Date('2026-11-13T15:00:00Z') });
    await importarVendas(sql, cliente, [venda('I1', l!.chave_rastreio, '3.00'), venda('I2', l!.chave_rastreio, '3.00'), venda('W1', wa!.chave_rastreio, '2.00')]);
    await registrarCliques(sql, cliente, [
      { plataforma: 'shopee', chaveRastreio: l!.chave_rastreio, dia: '2026-11-13', cliques: 40 },
      { plataforma: 'shopee', chaveRastreio: wa!.chave_rastreio, dia: '2026-11-13', cliques: 10 },
    ]);
    [c] = await criativosDoDia(sql, cliente, '2026-11-13');
    expect(c!.desempenho).toEqual({ cliques: 40, pedidos: 2, comissao: 6 });
    const r = await resultadosPeriodo(sql, cliente, '2026-11-13', '2026-11-13');
    expect(r.porCanal).toEqual([
      { canal: 'ig', rotulo: 'Instagram', cliques: 40, pedidos: 2, comissao: '6.00' },
      { canal: 'wa', rotulo: 'WhatsApp', cliques: 10, pedidos: 1, comissao: '2.00' },
    ]);
    // O Curador do dia seguinte recebe a comparação (o criativo publicado entra como postagem do Instagram).
    const d = await desempenhoParaCurador(sql, cliente, '2026-11-14');
    expect(d!.por_canal).toEqual([{ grupo: 'Instagram', postagens: 1, cliques_por_postagem: 40, pedidos: 2, comissao: 6 }]);
  });
});
