import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import type { ModeloIA, PedidoModelo } from '../../harness/agentes.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { criarCriativo, criativosDoDia, mudarEstadoCriativo } from './criativos.ts';

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
    expect(c).toMatchObject({ id, formato: 'carrossel', estado: 'rascunho', preco: 'R$ 29,90', desconto: '25%', link: 'https://s.shopee.com.br/L555',
      imagemUrl: 'https://down-br.img.susercontent.com/file/abc' });
    expect(c!.roteiro.telas[0]!.texto).toBe('Com 25% de desconto.');
    expect(c!.roteiro.legenda).toBe('Só R$ 29,90 ✨ #achadinhos');
    // O preço mudou no banco: o criativo mostra o novo.
    await sql`update ofertas set preco = 27.5 where id = ${ofertaId}`;
    [c] = await criativosDoDia(sql, cliente, '2026-11-13');
    expect(c!.roteiro.legenda).toBe('Só R$ 27,50 ✨ #achadinhos');

    expect(await mudarEstadoCriativo(sql, cliente, id, 'aprovar')).toBe('aprovado');
    expect(await mudarEstadoCriativo(sql, cliente, id, 'publicado')).toBe('publicado');
    await expect(mudarEstadoCriativo(sql, cliente, id, 'descartar')).rejects.toThrow('outro estado');
  });
});
