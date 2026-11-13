import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import type { ModeloIA, PedidoModelo } from '../../harness/agentes.ts';
import { processarFila } from '../../harness/fila.ts';
import { importarVendas } from '../vendas/atribuicao.ts';
import { extrairLinks, regrasAtendente } from '../../agents/atendente/regras.ts';
import { atender, concluirPedido, contratoAtendente, pedidosAbertos } from './atendente.ts';

const agora = new Date('2026-11-13T15:00:00Z');
const resposta = (o: Record<string, unknown>) => JSON.stringify({ url: null, periodo: null, nicho: null, resumo: 'pedido', ...o });

function modeloFalso(respostas: (string | Error)[]) {
  const pedidos: PedidoModelo[] = [];
  const modelo: ModeloIA = {
    async gerar(p) {
      pedidos.push(p);
      const r = respostas.shift();
      if (r === undefined || r instanceof Error) throw r ?? new Error('sem resposta');
      return { texto: r, tokensEntrada: 200, tokensSaida: 30 };
    },
  };
  return { modelo, pedidos };
}

describe('extrairLinks e regras', () => {
  it('extrai links sem a pontuação do fim', () => {
    expect(extrairLinks('olha https://shopee.com.br/x-i.1.2, e https://amzn.to/abc!')).toEqual(['https://shopee.com.br/x-i.1.2', 'https://amzn.to/abc']);
  });
  it('recusa link inventado e campos fora da intenção', () => {
    const e = { mensagem: 'x', links_na_mensagem: ['https://a.com/1'], nichos_do_cliente: [] };
    expect(regrasAtendente(e, { intencao: 'transformar_link', url: 'https://b.com', periodo: null, nicho: null, resumo: '' })).toContain('url não é um dos links da mensagem');
    expect(regrasAtendente(e, { intencao: 'pausar', url: null, periodo: 'hoje', nicho: null, resumo: '' })).toContain('periodo só vale para quanto_ganhei');
    expect(regrasAtendente(e, { intencao: 'transformar_link', url: null, periodo: null, nicho: null, resumo: '' })).toContain('a mensagem tem link: copie-o em "url"');
  });
});

describe.skipIf(!BANCO_HABILITADO)('Atendente', () => {
  let sql: Sql;
  let cliente: Cliente;
  const amb = { MODELO_IA_PEQUENO: 'modelo-teste' };

  beforeAll(async () => { sql = await bancoLimpo(); cliente = await buscarCliente(sql, 'c1'); });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate pedidos_afiliado, tarefas, vendas, links, ofertas, execucoes_agente cascade`; });

  it('quanto ganhei: responde na hora com números do banco', async () => {
    await importarVendas(sql, cliente, [
      { plataforma: 'shopee', pedidoId: 'A', produtoId: '1', situacao: 'validada', comissao: '4.00', chaveRastreio: null, dataPedido: new Date('2026-11-12T15:00:00Z') },
      { plataforma: 'shopee', pedidoId: 'B', produtoId: '2', situacao: 'pendente', comissao: '2.50', chaveRastreio: null, dataPedido: new Date('2026-11-13T12:00:00Z') },
      { plataforma: 'shopee', pedidoId: 'C', produtoId: '3', situacao: 'cancelada', comissao: '9.00', chaveRastreio: null, dataPedido: new Date('2026-11-13T12:00:00Z') },
    ]);
    const { modelo } = modeloFalso([resposta({ intencao: 'quanto_ganhei', periodo: 'semana' })]);
    const r = await atender(sql, { cliente, mensagem: 'quanto ganhei essa semana?', modelo, contrato: await contratoAtendente(amb), agora });
    expect(r).toMatchObject({ intencao: 'quanto_ganhei', situacao: 'resolvido', tarefaId: null });
    expect(r.resposta).toBe('Nos últimos 7 dias: 2 pedidos.\nComissão validada: R$ 4,00\nComissão pendente: R$ 2,50 (ainda pode mudar se algum pedido for cancelado)');
    const [p] = await sql`select situacao, intencao, resposta from pedidos_afiliado`;
    expect(p).toMatchObject({ situacao: 'resolvido', intencao: 'quanto_ganhei' });
  });

  it('transformar link: com a Open API gera na hora; sem ela, vira tarefa do operador que a fila não executa', async () => {
    const url = 'https://shopee.com.br/Organizador-i.9.555';
    const shopee = { async gerarLinkCurto() { return 'https://s.shopee.com.br/Atend1'; } };
    const a = await atender(sql, { cliente, mensagem: `me manda o link ${url}`, modelo: modeloFalso([resposta({ intencao: 'transformar_link', url })]).modelo, contrato: await contratoAtendente(amb), shopee, agora });
    expect(a).toMatchObject({ situacao: 'resolvido', resposta: 'Aqui está o seu link com rastreio:\nhttps://s.shopee.com.br/Atend1' });
    const [l] = await sql`select sub_ids, contexto ->> 'origem' as origem from links`;
    expect(l).toMatchObject({ origem: 'atendente', sub_ids: ['c1', 'wa', '20261113', '555', '1200'] });

    const b = await atender(sql, { cliente, mensagem: `e esse? ${url}`, modelo: modeloFalso([resposta({ intencao: 'transformar_link', url })]).modelo, contrato: await contratoAtendente(amb), agora });
    expect(b).toMatchObject({ situacao: 'encaminhado_operador', resposta: 'Recebi! Vou gerar o seu link com rastreio e já te mando. 😉' });
    const r = await processarFila(sql, {}, { agora: () => agora });
    expect(r.executadas).toBe(0);
    const [t] = await sql`select tipo, estado, entrada ->> 'url' as url from tarefas`;
    expect(t).toMatchObject({ tipo: 'operador.gerar_link', estado: 'pendente', url });
  });

  it('link inventado pelo modelo é recusado e pedido de novo', async () => {
    const url = 'https://shopee.com.br/A-i.1.2';
    const { modelo, pedidos } = modeloFalso([
      resposta({ intencao: 'transformar_link', url: 'https://shopee.com.br/inventado' }),
      resposta({ intencao: 'transformar_link', url }),
    ]);
    await atender(sql, { cliente, mensagem: `link: ${url}`, modelo, contrato: await contratoAtendente(amb), agora });
    expect(pedidos[1]!.correcao).toContain('url não é um dos links da mensagem');
    expect(JSON.parse(pedidos[0]!.entrada).links_na_mensagem).toEqual([url]);
  });

  it('pausar, mudar nicho e desconhecida vão para o operador; desconhecida sem resposta', async () => {
    const c = await contratoAtendente(amb);
    const p1 = await atender(sql, { cliente, mensagem: 'para de mandar até dia 20', modelo: modeloFalso([resposta({ intencao: 'pausar' })]).modelo, contrato: c, agora });
    const p2 = await atender(sql, { cliente, mensagem: 'quero pets também', modelo: modeloFalso([resposta({ intencao: 'mudar_nicho', nicho: 'pets' })]).modelo, contrato: c, agora });
    const p3 = await atender(sql, { cliente, mensagem: 'bom dia!', modelo: modeloFalso([resposta({ intencao: 'desconhecida' })]).modelo, contrato: c, agora });
    expect([p1.resposta, p2.resposta, p3.resposta]).toEqual(['Combinado! Vou pausar as suas listas e te confirmo por aqui.', expect.stringContaining('nicho'), null]);
    const abertos = await pedidosAbertos(sql, cliente);
    expect(abertos.map((a) => [a.tipoTarefa, a.mensagem])).toEqual([
      ['operador.pausar', 'para de mandar até dia 20'], ['operador.mudar_nicho', 'quero pets também'], ['operador.responder', 'bom dia!'],
    ]);
    // a cliente não foi pausada sozinha
    expect((await buscarCliente(sql, 'c1')).codigo).toBe('c1');
    await concluirPedido(sql, cliente, p3.pedidoId, 'Bom dia! Tudo ótimo 😊');
    const [t] = await sql`select estado from tarefas where id = ${p3.tarefaId}`;
    expect(t!.estado).toBe('concluida');
    expect(await pedidosAbertos(sql, cliente)).toHaveLength(2);
    await expect(concluirPedido(sql, cliente, p3.pedidoId, 'de novo')).rejects.toThrow('já resolvido');
  });

  it('IA fora do ar: o pedido não se perde, vai para o operador', async () => {
    const r = await atender(sql, { cliente, mensagem: 'oi, quanto ganhei?', modelo: modeloFalso([new Error('sobrecarga'), new Error('sobrecarga'), new Error('sobrecarga')]).modelo, contrato: await contratoAtendente(amb), agora });
    expect(r).toMatchObject({ intencao: 'desconhecida', situacao: 'encaminhado_operador', resposta: null });
    const [a] = await pedidosAbertos(sql, cliente);
    expect(a!.resumo).toContain('IA indisponível');
  });
});
