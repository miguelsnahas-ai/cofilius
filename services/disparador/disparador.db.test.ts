import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import type { ModeloIA } from '../../harness/agentes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import { aprovar, criarRascunho, validarMensagem } from '../lista/lista.ts';
import { atualizarCliente } from '../clientes/cadastro.ts';
import { assinaturaValida, enviarTextoWhatsapp, ErroWhatsapp, lerAviso, verificarWebhook, type ConfigWhatsapp } from './whatsapp.ts';
import { canalManual, enviarListaDoDia, enviarMensagem, ErroForaDaJanela, registrarStatus, type Canal } from './disparador.ts';
import { pedeALista } from '../atendimento/entrada.ts';
import { criarServidorWebhook } from '../../harness/webhook.ts';

const cfg: ConfigWhatsapp = { token: 'tok', numeroId: '123', versao: 'vX', segredoApp: 'segredo', tokenVerificacao: 'verifica', esperar: async () => {} };

describe('cliente WhatsApp (formato suposto, ver TODOs)', () => {
  it('envia texto e devolve o id', async () => {
    const pedidos: { url: string; init: RequestInit }[] = [];
    const f: typeof fetch = async (url, init) => { pedidos.push({ url: String(url), init: init! }); return new Response('{"messages":[{"id":"wamid.1"}]}'); };
    expect(await enviarTextoWhatsapp({ ...cfg, fetch: f }, '5511999998888', 'oi')).toBe('wamid.1');
    expect(pedidos[0]!.url).toBe('https://graph.facebook.com/vX/123/messages');
    expect(JSON.parse(String(pedidos[0]!.init.body))).toEqual({ messaging_product: 'whatsapp', to: '5511999998888', type: 'text', text: { preview_url: true, body: 'oi' } });
    expect((pedidos[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('erro da Meta vira ErroWhatsapp sem repetir; 5xx repete', async () => {
    let n = 0;
    const f: typeof fetch = async () => { n++; return new Response('{"error":{"code":131047,"message":"Re-engagement message"}}', { status: 400 }); };
    const e = await enviarTextoWhatsapp({ ...cfg, fetch: f }, '55', 'x').catch((x) => x);
    expect(e).toBeInstanceOf(ErroWhatsapp);
    expect((e as ErroWhatsapp).codigo).toBe(131047);
    expect(n).toBe(1);
    let m = 0;
    const g: typeof fetch = async () => (++m < 3 ? new Response('x', { status: 503 }) : new Response('{"messages":[{"id":"w2"}]}'));
    expect(await enviarTextoWhatsapp({ ...cfg, fetch: g }, '55', 'x')).toBe('w2');
  });
  it('verificação, assinatura e leitura do aviso', () => {
    expect(verificarWebhook(cfg, new URLSearchParams('hub.mode=subscribe&hub.verify_token=verifica&hub.challenge=42'))).toBe('42');
    expect(verificarWebhook(cfg, new URLSearchParams('hub.mode=subscribe&hub.verify_token=errado&hub.challenge=42'))).toBeNull();
    const corpo = '{"a":1}';
    const sig = `sha256=${createHmac('sha256', 'segredo').update(corpo).digest('hex')}`;
    expect(assinaturaValida(cfg, corpo, sig)).toBe(true);
    expect(assinaturaValida(cfg, corpo + ' ', sig)).toBe(false);
    expect(assinaturaValida(cfg, corpo, undefined)).toBe(false);
    const aviso = lerAviso({ entry: [{ changes: [{ value: {
      messages: [{ from: '5511', id: 'w1', timestamp: '1700000000', type: 'text', text: { body: 'oi' } },
        { from: '5511', id: 'w2', timestamp: '1700000001', type: 'interactive', interactive: { button_reply: { title: 'Mandar a lista de hoje' } } },
        { from: '5511', id: 'w3', type: 'image' }],
      statuses: [{ id: 'w9', status: 'read', timestamp: '1700000002' }],
    } }] }] });
    expect(aviso.mensagens.map((m) => m.texto)).toEqual(['oi', 'Mandar a lista de hoje']);
    expect(aviso.status).toEqual([{ id: 'w9', status: 'read', em: new Date(1700000002000) }]);
    expect(lerAviso('lixo')).toEqual({ mensagens: [], status: [] });
  });
  it('reconhece o pedido da lista', () => {
    for (const t of ['Mandar a lista de hoje', 'manda a lista', 'me manda a lista do dia!', 'Envia lista por favor']) expect(pedeALista(t)).toBe(true);
    for (const t of ['quanto ganhei', 'manda o link da lista de compras']) expect(pedeALista(t)).toBe(false);
  });
});

describe.skipIf(!BANCO_HABILITADO)('Disparador e entrada pelo WhatsApp', () => {
  let sql: Sql;
  let cliente: Cliente;
  const enviados: { para: string; texto: string }[] = [];
  let foraDaJanela = false;
  const canalFalso: Canal = {
    nome: 'whatsapp',
    async enviar(para, texto) {
      if (foraDaJanela) throw new ErroWhatsapp(131047, 'Re-engagement message');
      enviados.push({ para, texto });
      return `wamid.${enviados.length}`;
    },
  };

  async function aprovada(produto: string, posicaoTexto = 'Achado') {
    const r = await importarPlanilhaShopee(sql, cliente, `link;titulo;preco\nhttps://shopee.com.br/P-i.9.${produto};Produto ${produto};10,00`);
    const ofertaId = r.ofertas[0]!.id;
    await registrarLinkManual(sql, { cliente, ofertaId, link: `https://s.shopee.com.br/W${produto}`, quando: new Date() });
    const m = await criarRascunho(sql, { cliente, ofertaId, textoModelo: `${posicaoTexto} {{preco}} 👉 {{link}}` });
    await validarMensagem(sql, m.id);
    await aprovar(sql, cliente, m.id, 'op');
    return m.id;
  }

  beforeAll(async () => {
    sql = await bancoLimpo();
    await atualizarCliente(sql, 'c1', { whatsapp: '5511999998888' });
    cliente = await buscarCliente(sql, 'c1');
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => {
    await sql`truncate mensagens, pedidos_afiliado, tarefas, links, ofertas, execucoes_agente cascade`;
    enviados.length = 0;
    foraDaJanela = false;
  });

  it('envia a aprovada pelo canal, grava id e estado; manual só registra', async () => {
    const a = await aprovada('1');
    const r = await enviarMensagem(sql, cliente, a, canalFalso);
    expect(r).toMatchObject({ enviada: true, idExterno: 'wamid.1' });
    expect(enviados[0]).toEqual({ para: '5511999998888', texto: '#publi Achado R$ 10,00 👉 https://s.shopee.com.br/W1' });
    const b = await aprovada('2');
    expect((await enviarMensagem(sql, cliente, b, canalManual)).idExterno).toBeNull();
    const linhas = await sql`select estado, canal, id_externo from mensagens order by criado_em`;
    expect(linhas.map((l) => [l.estado, l.canal, l.id_externo])).toEqual([['enviada', 'whatsapp', 'wamid.1'], ['enviada', 'manual', null]]);
  });

  it('não envia o que não está aprovado nem com preço velho; fora da janela vira erro claro', async () => {
    const a = await aprovada('3');
    await sql`update ofertas set preco_conferido_em = now() - interval '2 hours'`;
    expect(await enviarMensagem(sql, cliente, a, canalFalso)).toMatchObject({ enviada: false, motivo: expect.stringContaining('confira de novo') });
    await sql`update ofertas set preco_conferido_em = now()`;
    foraDaJanela = true;
    await expect(enviarMensagem(sql, cliente, a, canalFalso)).rejects.toBeInstanceOf(ErroForaDaJanela);
    const [m] = await sql`select estado from mensagens`;
    expect(m!.estado).toBe('aprovada');
    expect(enviados).toHaveLength(0);
  });

  it('entrega e leitura pelo id externo', async () => {
    const a = await aprovada('4');
    await enviarMensagem(sql, cliente, a, canalFalso);
    expect(await registrarStatus(sql, [{ id: 'wamid.1', status: 'delivered', em: new Date('2026-11-13T11:01:00Z') }, { id: 'wamid.1', status: 'read', em: new Date('2026-11-13T11:05:00Z') }, { id: 'outro', status: 'read', em: new Date() }])).toBe(2);
    const [m] = await sql`select entregue_em, lida_em from mensagens`;
    expect(m!.entregue_em.toISOString()).toBe('2026-11-13T11:01:00.000Z');
    expect(m!.lida_em.toISOString()).toBe('2026-11-13T11:05:00.000Z');
  });

  it('webhook: assinatura, pedido da lista envia as aprovadas em ordem, aviso repetido não duplica, número desconhecido é ignorado', async () => {
    await aprovada('5', 'Primeira');
    await aprovada('6', 'Segunda');
    const modelo: ModeloIA = { async gerar() { return { texto: '{"intencao":"desconhecida","url":null,"periodo":null,"nicho":null,"resumo":"oi"}', tokensEntrada: 1, tokensSaida: 1 }; } };
    const servidor = criarServidorWebhook({ sql, cfg, canal: canalFalso, modelo: () => modelo });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    const postar = (corpo: object, assinar = true) => {
      const bruto = JSON.stringify(corpo);
      const sig = `sha256=${createHmac('sha256', 'segredo').update(bruto).digest('hex')}`;
      return fetch(base, { method: 'POST', body: bruto, headers: { 'Content-Type': 'application/json', ...(assinar ? { 'X-Hub-Signature-256': sig } : {}) } });
    };
    const aviso = (id: string, de: string, texto: string) => ({ entry: [{ changes: [{ value: { messages: [{ from: de, id, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: texto } }] } }] }] });

    expect((await fetch(`${base}/?hub.mode=subscribe&hub.verify_token=verifica&hub.challenge=abc`)).status).toBe(200);
    expect((await postar(aviso('w1', '5511999998888', 'Mandar a lista de hoje'), false)).status).toBe(401);
    expect((await postar(aviso('w1', '5511999998888', 'Mandar a lista de hoje'))).status).toBe(200);
    expect(enviados.map((e) => e.texto.split(' ')[1])).toEqual(['Primeira', 'Segunda']);
    await postar(aviso('w1', '5511999998888', 'Mandar a lista de hoje'));
    expect(enviados).toHaveLength(2);
    await postar(aviso('w2', '5599000000000', 'oi'));
    await postar(aviso('w3', '5511999998888', 'bom dia!'));
    const pedidos = await sql`select intencao, situacao, canal, id_externo from pedidos_afiliado order by recebido_em, id_externo`;
    expect(pedidos.map((p) => [p.intencao, p.situacao, p.canal, p.id_externo])).toEqual([
      ['pedir_lista', 'resolvido', 'whatsapp', 'w1'], ['desconhecida', 'encaminhado_operador', 'whatsapp', 'w3'],
    ]);
    // sem lista aprovada: avisa que ainda não está pronta
    await postar(aviso('w4', '5511999998888', 'manda a lista'));
    expect(enviados.at(-1)!.texto).toContain('ainda não está pronta');
    servidor.close();
  });
});
