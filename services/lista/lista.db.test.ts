import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarPlanilhaShopee } from '../ofertas/importarPlanilhaShopee.ts';
import { registrarLinkManual } from '../links/linksManuaisShopee.ts';
import {
  aprovar, conferirAntesDoEnvio, confirmarPreco, criarRascunho, descartar, listarDia, registrarEnvio, validarDia, validarMensagem,
} from './lista.ts';

const quando = new Date('2026-11-12T11:15:00Z');
const DIA = '2026-11-12';
const TEXTO = 'Organizador por {{preco}} com {{desconto}} off! {{link}}';

describe.skipIf(!BANCO_HABILITADO)('lista diária', () => {
  let sql: Sql;
  let cliente: Cliente;

  /** Cria oferta + link e devolve o id da oferta. */
  async function ofertaComLink(produto: string, preco = '29,90', link = `https://s.shopee.com.br/L${produto}`) {
    const r = await importarPlanilhaShopee(sql, cliente,
      `link;titulo;preco;desconto;comissao\nhttps://shopee.com.br/P-i.9.${produto};Produto ${produto};${preco};25;12`, { quando });
    const ofertaId = r.ofertas[0]!.id;
    await registrarLinkManual(sql, { cliente, ofertaId, link, quando });
    return ofertaId;
  }

  beforeAll(async () => {
    sql = await bancoLimpo();
    cliente = await buscarCliente(sql, 'c1');
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate mensagens, links, ofertas cascade`; });

  it('rascunho: código preenche preço, desconto e link a partir do banco', async () => {
    const ofertaId = await ofertaComLink('101');
    const m = await criarRascunho(sql, { cliente, ofertaId, textoModelo: TEXTO, dataLista: DIA });
    expect(m.estado).toBe('rascunho');
    expect(m.textoFinal).toBe('Organizador por R$ 29,90 com 25% off! https://s.shopee.com.br/L101');
  });

  it('rascunho recusa texto com preço escrito, oferta sem link e oferta repetida no dia', async () => {
    const ofertaId = await ofertaComLink('102');
    await expect(criarRascunho(sql, { cliente, ofertaId, textoModelo: 'Só R$ 10 {{link}}', dataLista: DIA })).rejects.toThrow('dinheiro');
    const semLink = (await importarPlanilhaShopee(sql, cliente, 'link;titulo;preco\nhttps://shopee.com.br/P-i.9.103;X;10', { quando })).ofertas[0]!.id;
    await expect(criarRascunho(sql, { cliente, ofertaId: semLink, textoModelo: TEXTO, dataLista: DIA })).rejects.toThrow('ainda não tem link');
    await criarRascunho(sql, { cliente, ofertaId, textoModelo: TEXTO, dataLista: DIA });
    await expect(criarRascunho(sql, { cliente, ofertaId, textoModelo: TEXTO, dataLista: DIA })).rejects.toThrow('já está na lista');
  });

  it('validação aprova quando todas as regras passam', async () => {
    const ofertaId = await ofertaComLink('104');
    const m = await criarRascunho(sql, { cliente, ofertaId, textoModelo: TEXTO, dataLista: DIA });
    const v = await validarMensagem(sql, m.id, { agora: quando, linkAbre: async () => true });
    expect(v.regras.filter((r) => !r.ok)).toEqual([]);
    expect(v.estado).toBe('validada');
    expect(v.regras.find((r) => r.regra === 'link')!.detalhe).toContain('link abre');
  });

  it('validação barra preço que mudou e link que não abre', async () => {
    const ofertaId = await ofertaComLink('105');
    const m = await criarRascunho(sql, { cliente, ofertaId, textoModelo: TEXTO, dataLista: DIA });
    await confirmarPreco(sql, cliente, ofertaId, '24.90');
    const v = await validarMensagem(sql, m.id, { agora: quando, linkAbre: async () => false });
    expect(v.estado).toBe('rascunho');
    expect(v.regras.filter((r) => !r.ok).map((r) => r.regra)).toEqual(['link', 'preco']);
    const [salvo] = await sql`select validacao from mensagens where id = ${m.id}`;
    expect(salvo!.validacao).toHaveLength(5);
  });

  it('validação barra produto enviado nos últimos 7 dias (mesmo produto, oferta de outro dia)', async () => {
    const antes = await ofertaComLink('106', '29,90', 'https://s.shopee.com.br/Antigo');
    const m1 = await criarRascunho(sql, { cliente, ofertaId: antes, textoModelo: TEXTO, dataLista: '2026-11-10' });
    await validarMensagem(sql, m1.id, { agora: quando });
    await aprovar(sql, cliente, m1.id, 'operador');
    await registrarEnvio(sql, cliente, m1.id, new Date());
    await sql`update mensagens set enviada_em = ${new Date('2026-11-10T11:00:00Z')} where id = ${m1.id}`;
    // nova coleta do mesmo produto em outro dia
    const r = await importarPlanilhaShopee(sql, cliente, 'link;titulo;preco;desconto\nhttps://shopee.com.br/P-i.9.106;P;29,90;25',
      { quando: new Date('2026-11-13T11:00:00Z') });
    await registrarLinkManual(sql, { cliente, ofertaId: r.ofertas[0]!.id, link: 'https://s.shopee.com.br/Novo', quando: new Date('2026-11-13T11:00:00Z') });
    const m2 = await criarRascunho(sql, { cliente, ofertaId: r.ofertas[0]!.id, textoModelo: TEXTO, dataLista: '2026-11-13' });
    const v = await validarMensagem(sql, m2.id, { agora: new Date('2026-11-13T11:00:00Z') });
    expect(v.regras.find((x) => x.regra === 'repeticao')).toMatchObject({ ok: false });
    // passados 7 dias, pode
    const v2 = await validarMensagem(sql, m2.id, { agora: new Date('2026-11-18T11:00:00Z') });
    expect(v2.regras.find((x) => x.regra === 'repeticao')).toMatchObject({ ok: true });
  });

  it('validação barra link de outro cliente/sub_id errado e respeita o limite do dia', async () => {
    await sql`update clientes set limite_mensagens_dia = 1 where codigo = 'c1'`;
    cliente = await buscarCliente(sql, 'c1');
    const a = await criarRascunho(sql, { cliente, ofertaId: await ofertaComLink('107'), textoModelo: TEXTO, dataLista: DIA });
    const b = await criarRascunho(sql, { cliente, ofertaId: await ofertaComLink('108'), textoModelo: TEXTO, dataLista: DIA });
    const r = await validarDia(sql, cliente, DIA, { agora: quando });
    expect(r.map((x) => x.estado)).toEqual(['validada', 'rascunho']);
    expect(r[1]!.regras.find((x) => x.regra === 'limite')).toMatchObject({ ok: false });
    await sql`update clientes set limite_mensagens_dia = 10 where codigo = 'c1'`;
    cliente = await buscarCliente(sql, 'c1');
    await sql`update links set sub_ids = '{c9,wa,20261112,108,0815}' where url_afiliado = 'https://s.shopee.com.br/L108'`;
    const v = await validarMensagem(sql, b.id, { agora: quando });
    expect(v.regras.find((x) => x.regra === 'link')!.detalhe).toContain('não é o código do cliente');
    expect(a.id).toBeTruthy();
  });

  it('banco garante a ordem dos estados', async () => {
    const m = await criarRascunho(sql, { cliente, ofertaId: await ofertaComLink('109'), textoModelo: TEXTO, dataLista: DIA });
    await expect(sql`update mensagens set estado = 'enviada' where id = ${m.id}`).rejects.toThrow('não permitida');
    await expect(sql`update mensagens set estado = 'aprovada' where id = ${m.id}`).rejects.toThrow('não permitida');
    await expect(sql`insert into mensagens (cliente_id, texto_modelo, data_lista, estado)
      values (${cliente.clienteId}, 'x', ${DIA}, 'aprovada')`).rejects.toThrow('rascunho');
    await expect(aprovar(sql, cliente, m.id, 'op')).rejects.toThrow('esperado: validada');
  });

  it('mexer no texto de mensagem aprovada devolve para rascunho', async () => {
    const m = await criarRascunho(sql, { cliente, ofertaId: await ofertaComLink('110'), textoModelo: TEXTO, dataLista: DIA });
    await validarMensagem(sql, m.id, { agora: quando });
    await aprovar(sql, cliente, m.id, 'op');
    await sql`update mensagens set texto_final = 'outro texto' where id = ${m.id}`;
    const [x] = await sql`select estado, aprovada_por from mensagens where id = ${m.id}`;
    expect(x).toMatchObject({ estado: 'rascunho', aprovada_por: null });
  });

  it('envio: exige preço conferido há até 30 minutos e descarta se o preço mudou', async () => {
    const ofertaId = await ofertaComLink('111');
    const m = await criarRascunho(sql, { cliente, ofertaId, textoModelo: TEXTO, dataLista: DIA });
    await validarMensagem(sql, m.id, { agora: quando });
    await aprovar(sql, cliente, m.id, 'op');
    const daqui1h = new Date(Date.now() + 3_600_000);
    expect(await conferirAntesDoEnvio(sql, cliente, m.id, daqui1h)).toMatchObject({ podeEnviar: false, descartada: false });
    await expect(registrarEnvio(sql, cliente, m.id, daqui1h)).rejects.toThrow('confira de novo');
    await registrarEnvio(sql, cliente, m.id, new Date(Date.now() + 60_000));
    const [enviada] = await sql`select estado, enviada_em from mensagens where id = ${m.id}`;
    expect(enviada!.estado).toBe('enviada');
    await expect(sql`update mensagens set texto_final = 'x' where id = ${m.id}`).rejects.toThrow('já enviada');

    const outra = await ofertaComLink('112');
    const m2 = await criarRascunho(sql, { cliente, ofertaId: outra, textoModelo: TEXTO, dataLista: DIA });
    await validarMensagem(sql, m2.id, { agora: quando });
    await aprovar(sql, cliente, m2.id, 'op');
    await confirmarPreco(sql, cliente, outra, '35.00');
    expect(await conferirAntesDoEnvio(sql, cliente, m2.id)).toMatchObject({ podeEnviar: false, descartada: true });
    const lista = await listarDia(sql, cliente, DIA);
    expect(lista.map((l) => l.estado)).toEqual(['enviada', 'descartada']);
    expect(lista[1]!.motivoDescarte).toContain('preço mudou');
  });

  it('descartar', async () => {
    const m = await criarRascunho(sql, { cliente, ofertaId: await ofertaComLink('113'), textoModelo: TEXTO, dataLista: DIA });
    await descartar(sql, cliente, m.id, 'não gostei');
    await expect(descartar(sql, cliente, m.id, 'de novo')).rejects.toThrow('descartada');
  });
});
