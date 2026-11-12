import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { ErroAgente, type ModeloIA, type PedidoModelo } from '../../harness/agentes.ts';
import { ErroModeloFatal } from '../../harness/modeloClaude.ts';
import { contratoRedator, montarEntradaRedator, redigirMensagem } from './redator.ts';

const quando = new Date('2026-11-12T11:15:00Z');
const ambiente = { MODELO_IA_PEQUENO: 'modelo-pequeno-teste' };

function modeloFalso(respostas: (string | Error)[]) {
  const pedidos: PedidoModelo[] = [];
  const modelo: ModeloIA = {
    async gerar(p) {
      pedidos.push(p);
      const r = respostas.shift();
      if (r === undefined) throw new Error('sem resposta');
      if (r instanceof Error) throw r;
      return { texto: r, tokensEntrada: 300, tokensSaida: 40 };
    },
  };
  return { modelo, pedidos };
}

describe.skipIf(!BANCO_HABILITADO)('Redator', () => {
  let sql: Sql;
  let cliente: Cliente;
  let ofertaId: string;

  beforeAll(async () => {
    sql = await bancoLimpo();
    cliente = await buscarCliente(sql, 'c1');
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => {
    await sql`truncate mensagens, execucoes_agente, links, ofertas cascade`;
    const r = await importarPlanilhaShopee(sql, cliente,
      'link;titulo;preco;desconto;nicho\nhttps://shopee.com.br/Org-i.9.501;Organizador de Gaveta 6 Divisórias;29,90;25;casa', { quando });
    ofertaId = r.ofertas[0]!.id;
    await registrarLinkManual(sql, { cliente, ofertaId, link: 'https://s.shopee.com.br/R501', quando });
  });

  it('o modelo vem do ambiente (porte "pequeno"); sem configurar, erro claro', async () => {
    expect((await contratoRedator(ambiente)).modelo).toBe('modelo-pequeno-teste');
    await expect(contratoRedator({})).rejects.toThrow('MODELO_IA_PEQUENO');
  });

  it('entrada do agente não leva preço nem link', async () => {
    const e = await montarEntradaRedator(sql, cliente, ofertaId);
    expect(e).toEqual({
      oferta: { titulo: 'Organizador de Gaveta 6 Divisórias', nicho: 'casa', tem_desconto: true },
      tom: 'Próximo e animado, sem exagero. Frases curtas.',
      exemplos: [],
    });
    expect(JSON.stringify(e)).not.toMatch(/29|shopee\.com/);
  });

  it('redige, valida e cria o rascunho com preço e link preenchidos pelo código', async () => {
    const { modelo, pedidos } = modeloFalso([
      '{"texto_modelo":"Gaveta organizada por R$ 29,90! {{link}}"}',
      '{"texto_modelo":"Gaveta organizada em seis divisórias 😍 {{preco}} com {{desconto}} off 👉 {{link}}"}',
    ]);
    const r = await redigirMensagem(sql, {
      cliente, ofertaId, modelo, contrato: await contratoRedator(ambiente), dataLista: '2026-11-12',
      precos: { 'modelo-pequeno-teste': { entradaPorMilhao: 1, saidaPorMilhao: 5 } },
    });
    expect(r.tentativas).toBe(2);
    expect(pedidos[1]!.correcao).toContain('valor em dinheiro');
    expect(r.mensagem.textoFinal).toBe('Gaveta organizada em seis divisórias 😍 R$ 29,90 com 25% off 👉 https://s.shopee.com.br/R501');
    const execucoes = await sql`select saida_valida, modelo, custo_usd::text from execucoes_agente order by criado_em`;
    expect(execucoes.map((e) => [e.saida_valida, e.modelo, e.custo_usd])).toEqual([
      [false, 'modelo-pequeno-teste', '0.000500'], [true, 'modelo-pequeno-teste', '0.000500'],
    ]);
  });

  it('usa como exemplo mensagens já enviadas', async () => {
    await sql`insert into clientes (cliente_id, codigo, nome) values ('00000000-0000-4000-8000-000000000009', 'c9', 'Outro') on conflict do nothing`;
    const { modelo } = modeloFalso(['{"texto_modelo":"Achado: {{preco}} 👉 {{link}}"}']);
    const r = await redigirMensagem(sql, { cliente, ofertaId, modelo, contrato: await contratoRedator(ambiente), dataLista: '2026-11-12' });
    await sql`update mensagens set estado = 'validada' where id = ${r.mensagem.id}`;
    await sql`update mensagens set estado = 'aprovada' where id = ${r.mensagem.id}`;
    await sql`update mensagens set estado = 'enviada' where id = ${r.mensagem.id}`;
    const e = await montarEntradaRedator(sql, cliente, ofertaId);
    expect(e.exemplos).toEqual(['Achado: {{preco}} 👉 {{link}}']);
  });

  it('erro fatal do modelo (ex.: chave inválida) para na primeira tentativa', async () => {
    const { modelo, pedidos } = modeloFalso([new ErroModeloFatal('HTTP 401'), '{"texto_modelo":"nunca chega {{link}}"}']);
    await expect(redigirMensagem(sql, { cliente, ofertaId, modelo, contrato: await contratoRedator(ambiente) })).rejects.toBeInstanceOf(ErroAgente);
    expect(pedidos).toHaveLength(1);
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from mensagens`;
    expect(c!.n).toBe(0);
  });
});
