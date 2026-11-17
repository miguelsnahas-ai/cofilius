import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ErroShopee,
  erroShopeeTransitorio,
  extrairIdsDaUrl,
  interpretarResposta,
  parsearLinkCurto,
  parsearOfertas,
} from './parser.ts';
import { consultaOfertas, criarClienteShopee, montarAutorizacao, mutacaoLinkCurto } from './client.ts';

const fixture = (nome: string) => readFileSync(join(import.meta.dirname, 'fixtures', nome), 'utf8');

describe('parser · productOfferV2', () => {
  it('converte as ofertas de exemplo', () => {
    const r = parsearOfertas(interpretarResposta(fixture('exemplo-productOfferV2-ok.json')));
    expect(r.descartadas).toEqual([]);
    expect(r.pagina).toEqual({ page: 1, limit: 2, hasNextPage: true });
    expect(r.ofertas).toHaveLength(2);
    const [a, b] = r.ofertas;
    expect(a).toMatchObject({
      produtoId: '22912345678',
      lojaId: '334455667',
      titulo: 'Organizador de Gaveta Ajustável 6 Divisórias',
      urlProduto: 'https://shopee.com.br/product/334455667/22912345678',
      urlOferta: 'https://s.shopee.com.br/exemplo1',
      preco: '29.90',
      precoMaximo: '34.90',
      descontoPct: '25.0000',
      comissaoPct: '12.0000',
      comissaoValor: '3.59',
      vendas: 1520,
      avaliacao: '4.80',
    });
    expect(a!.validadeInicio?.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(a!.bruto).toHaveProperty('itemId');
  });

  it('aceita números como texto ou número e trata validade zerada como sem data', () => {
    const [, b] = parsearOfertas(interpretarResposta(fixture('exemplo-productOfferV2-ok.json'))).ofertas;
    expect(b).toMatchObject({
      produtoId: '19876543210',
      lojaId: '112233445',
      preco: '289.90',
      descontoPct: '0.0000',
      comissaoPct: '7.5000',
      comissaoValor: '21.74',
      avaliacao: '4.60',
      validadeInicio: null,
      validadeFim: null,
    });
  });

  it('descarta nó sem dado essencial e mantém os válidos', () => {
    const r = parsearOfertas(interpretarResposta(fixture('exemplo-productOfferV2-no-invalido.json')));
    expect(r.ofertas.map((o) => o.produtoId)).toEqual(['557']);
    expect(r.ofertas[0]).toMatchObject({ descontoPct: null, comissaoPct: null, comissaoValor: null });
    expect(r.descartadas).toEqual([
      { indice: 0, motivo: 'sem preço (priceMin)' },
      { indice: 1, motivo: 'sem itemId válido' },
    ]);
    expect(r.pagina.hasNextPage).toBe(false);
  });

  it('lista vazia', () => {
    const r = parsearOfertas(interpretarResposta(fixture('exemplo-productOfferV2-vazio.json')));
    expect(r.ofertas).toEqual([]);
  });

  it('recusa comissão fora de 0 a 1 (não é fração) em vez de gravar valor errado', () => {
    const r = parsearOfertas({
      productOfferV2: {
        nodes: [{ itemId: 1, productName: 'x', productLink: 'https://shopee.com.br/product/1/1', priceMin: '1', commissionRate: '12' }],
      },
    });
    expect(r.ofertas[0]!.comissaoPct).toBeNull();
  });

  it('recusa itemId acima do inteiro seguro do JS quando vem como número', () => {
    const r = parsearOfertas({
      productOfferV2: { nodes: [{ itemId: 2 ** 60, productName: 'x', productLink: 'https://shopee.com.br/product/1/1', priceMin: '1' }] },
    });
    expect(r.descartadas[0]!.motivo).toBe('sem itemId válido');
  });
});

describe('parser · generateShortLink', () => {
  it('extrai o link curto', () => {
    expect(parsearLinkCurto(interpretarResposta(fixture('exemplo-generateShortLink-ok.json')))).toBe(
      'https://s.shopee.com.br/AbCdEf123',
    );
  });

  it('recusa link vazio ou sem https', () => {
    expect(() => parsearLinkCurto({ generateShortLink: { shortLink: '' } })).toThrow(ErroShopee);
    expect(() => parsearLinkCurto({ generateShortLink: { shortLink: 'http://s.shopee.com.br/x' } })).toThrow('inválido');
    expect(() => parsearLinkCurto({})).toThrow('generateShortLink');
  });
});

describe('parser · erros', () => {
  it('erro de assinatura vira ErroShopee não transitório', () => {
    try {
      interpretarResposta(fixture('exemplo-erro-assinatura.json'));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ErroShopee);
      expect((e as ErroShopee).codigo).toBe(10020);
      expect((e as Error).message).toContain('Invalid Signature');
      expect(erroShopeeTransitorio(e)).toBe(false);
    }
  });

  it('limite de chamadas é transitório', () => {
    expect(() => interpretarResposta(fixture('exemplo-erro-limite.json'))).toThrow(ErroShopee);
    try {
      interpretarResposta(fixture('exemplo-erro-limite.json'));
    } catch (e) {
      expect(erroShopeeTransitorio(e)).toBe(true);
    }
  });

  it('resposta que não é JSON ou sem data', () => {
    expect(() => interpretarResposta('<html>')).toThrow('não é JSON');
    expect(() => interpretarResposta('{}')).toThrow('sem "data"');
  });
});

describe('extrairIdsDaUrl', () => {
  it('formatos conhecidos', () => {
    expect(extrairIdsDaUrl('https://shopee.com.br/Organizador-de-Gaveta-i.334455667.22912345678')).toEqual({
      lojaId: '334455667', produtoId: '22912345678',
    });
    expect(extrairIdsDaUrl('https://shopee.com.br/Organizador-i.1.2?sp_atk=abc')).toEqual({ lojaId: '1', produtoId: '2' });
    expect(extrairIdsDaUrl('https://shopee.com.br/product/1/2')).toEqual({ lojaId: '1', produtoId: '2' });
  });
  it('link curto, outro site ou lixo: null', () => {
    expect(extrairIdsDaUrl('https://s.shopee.com.br/AbC')).toBeNull();
    expect(extrairIdsDaUrl('https://exemplo.com/x-i.1.2')).toBeNull();
    expect(extrairIdsDaUrl('não é url')).toBeNull();
  });
});

describe('cliente', () => {
  const cred = { appId: '123456', secret: 'segredo' };

  it('assinatura = SHA256(AppId + Timestamp + Payload + Secret)', async () => {
    const corpo = '{"query":"{ x }"}';
    const esperado = createHash('sha256').update(`123456${1700000000}${corpo}segredo`).digest('hex');
    expect(await montarAutorizacao(cred, corpo, 1700000000)).toBe(
      `SHA256 Credential=123456, Timestamp=1700000000, Signature=${esperado}`,
    );
  });

  it('escapa aspas na palavra-chave e limita a página', () => {
    const q = consultaOfertas({ palavraChave: 'air "fryer"', limite: 500 });
    expect(q).toContain('keyword: "air \\"fryer\\""');
    expect(q).toContain('limit: 50');
    expect(q).not.toContain('sortType');
    expect(mutacaoLinkCurto('https://shopee.com.br/product/1/2', ['c1', 'wa'])).toContain('subIds: ["c1", "wa"]');
  });

  it('assina o corpo exato enviado, repete em limite de chamadas e devolve as ofertas', async () => {
    const enviados: { corpo: string; auth: string }[] = [];
    let n = 0;
    const fetchFalso: typeof fetch = async (_url, init) => {
      const h = init!.headers as Record<string, string>;
      enviados.push({ corpo: String(init!.body), auth: h.Authorization! });
      n++;
      return new Response(n === 1 ? fixture('exemplo-erro-limite.json') : fixture('exemplo-productOfferV2-ok.json'));
    };
    let relogio = 1700000000;
    const cliente = criarClienteShopee(cred, { fetch: fetchFalso, agora: () => relogio++, esperar: async () => {} });
    const r = await cliente.buscarOfertas({ palavraChave: 'organizador' });
    expect(r.ofertas).toHaveLength(2);
    expect(enviados).toHaveLength(2);
    // cada tentativa leva timestamp novo e assinatura do corpo enviado
    for (const [i, e] of enviados.entries()) {
      const ts = 1700000000 + i;
      const sig = createHash('sha256').update(`123456${ts}${e.corpo}segredo`).digest('hex');
      expect(e.auth).toBe(`SHA256 Credential=123456, Timestamp=${ts}, Signature=${sig}`);
    }
    expect(JSON.parse(enviados[0]!.corpo).query).toContain('keyword: "organizador"');
  });

  it('não repete erro de assinatura', async () => {
    let n = 0;
    const f: typeof fetch = async () => { n++; return new Response(fixture('exemplo-erro-assinatura.json')); };
    const cliente = criarClienteShopee(cred, { fetch: f, esperar: async () => {} });
    await expect(cliente.gerarLinkCurto('https://shopee.com.br/product/1/2', ['a'])).rejects.toThrow('10020');
    expect(n).toBe(1);
  });

  it('repete erro 503 e devolve o link curto', async () => {
    let n = 0;
    const f: typeof fetch = async () =>
      ++n < 3 ? new Response('indisponível', { status: 503 }) : new Response(fixture('exemplo-generateShortLink-ok.json'));
    const cliente = criarClienteShopee(cred, { fetch: f, esperar: async () => {} });
    expect(await cliente.gerarLinkCurto('https://shopee.com.br/product/1/2', ['a'])).toBe('https://s.shopee.com.br/AbCdEf123');
    expect(n).toBe(3);
  });

  it('recusa credencial vazia', () => {
    expect(() => criarClienteShopee({ appId: '', secret: 'x' })).toThrow('incompletas');
  });
});
