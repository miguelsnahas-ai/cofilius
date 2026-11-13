import { describe, expect, it } from 'vitest';
import './nucleo.js';

const N = (globalThis as any).CofiliusNucleo;

describe('deveGravar · Mercado Livre', () => {
  it('grava o site e a API do Mercado Livre e ignora métricas', () => {
    expect(N.deveGravar('https://www.mercadolivre.com.br/afiliados/api/links')).toBe(true);
    expect(N.deveGravar('https://api.mercadolibre.com/users/me')).toBe(true);
    expect(N.deveGravar('/api/relatorio', 'https://www.mercadolivre.com.br/afiliados')).toBe(true);
    expect(N.deveGravar('https://mercadolivre.com.br.golpe.com/x')).toBe(false);
    expect(N.deveGravar('https://www.mercadolivre.com.br/melidata/tracks')).toBe(false);
    expect(N.deveGravar('https://www.google-analytics.com/collect')).toBe(false);
    expect(N.deveGravar('data:text/plain,oi')).toBe(false);
  });
  it('não grava áreas pessoais', () => {
    expect(N.deveGravarPagina('https://www.mercadolivre.com.br/minhas-compras')).toBe(false);
    expect(N.deveGravarPagina('https://www.mercadolivre.com.br/checkout/pagamento')).toBe(false);
    expect(N.deveGravarPagina('https://www.mercadolivre.com.br/afiliados/painel')).toBe(true);
    expect(N.deveGravar('https://api.mercadolibre.com/x', undefined, 'https://www.mercadolivre.com.br/carrinho')).toBe(false);
  });
});

describe('deveGravar · Shopee', () => {
  it('painel de afiliados: grava tudo, menos métricas', () => {
    expect(N.deveGravarPagina('https://affiliate.shopee.com.br/report/conversion')).toBe(true);
    expect(N.deveGravar('https://affiliate.shopee.com.br/api/v3/report/list?page=1')).toBe(true);
    expect(N.deveGravar('https://affiliate.shopee.com.br/__t__/x')).toBe(false);
  });
  it('loja: só páginas de produto e só chamadas de afiliado', () => {
    expect(N.deveGravarPagina('https://shopee.com.br/Organizador-i.334455667.22912345678')).toBe(true);
    expect(N.deveGravarPagina('https://shopee.com.br/cart')).toBe(false);
    expect(N.deveGravarPagina('https://shopee.com.br/user/purchase')).toBe(false);
    expect(N.deveGravarPagina('https://shopee.com.br/')).toBe(false);
    const produto = 'https://shopee.com.br/Organizador-i.1.2';
    expect(N.deveGravar('https://shopee.com.br/api/v4/affiliate/link', undefined, produto)).toBe(true);
    expect(N.deveGravar('https://shopee.com.br/api/v4/pdp/get_pc', undefined, produto)).toBe(false);
  });
});

describe('deveGravar · Amazon', () => {
  it('painel de associados: grava tudo', () => {
    expect(N.deveGravarPagina('https://associados.amazon.com.br/home/reports')).toBe(true);
    expect(N.deveGravar('https://associados.amazon.com.br/home/reports/table.json?type=orders')).toBe(true);
  });
  it('loja: só páginas de produto e só chamadas do SiteStripe', () => {
    const produto = 'https://www.amazon.com.br/Creme-Weleda/dp/B0FH7C4YCS';
    expect(N.deveGravarPagina(produto)).toBe(true);
    expect(N.deveGravarPagina('https://www.amazon.com.br/gp/css/order-history')).toBe(false);
    expect(N.deveGravarPagina('https://www.amazon.com.br/your-orders/orders')).toBe(false);
    expect(N.deveGravarPagina('https://www.amazon.com.br/s?k=creme')).toBe(false);
    expect(N.deveGravar('https://www.amazon.com.br/associates/sitestripe/getShortUrl?longUrl=x', undefined, produto)).toBe(true);
    expect(N.deveGravar('https://www.amazon.com.br/gp/cart/view.html', undefined, produto)).toBe(false);
    expect(N.deveGravar('https://www.amazon.com.br/1/events/com.amazon.csm', undefined, produto)).toBe(false);
  });
  it('identifica a plataforma', () => {
    expect(N.idPlataforma('https://associados.amazon.com.br/x')).toBe('amazon');
    expect(N.idPlataforma('https://affiliate.shopee.com.br/x')).toBe('shopee');
    expect(N.idPlataforma('https://api.mercadolibre.com/x')).toBe('mercado_livre');
    expect(N.idPlataforma('https://exemplo.com')).toBeNull();
  });
});

describe('mascarar', () => {
  it('troca campos sensíveis e e-mails/CPFs soltos', () => {
    expect(
      N.mascarar({
        id: 1, email: 'a@b.com', nickname: 'LOJA', phone: { number: '9' }, first_name: 'Ana',
        texto: 'fale com ana@exemplo.com.br, cpf 123.456.789-09', itens: [{ access_token: 'x', preco: 10 }],
      }),
    ).toEqual({
      id: 1, email: '***', nickname: 'LOJA', phone: '***', first_name: '***',
      texto: 'fale com [email], cpf [cpf]', itens: [{ access_token: '***', preco: 10 }],
    });
  });
});

describe('limparUrl', () => {
  it('esconde parâmetros sensíveis e o fragmento', () => {
    expect(N.limparUrl('https://www.mercadolivre.com.br/x?access_token=abc&etiqueta=wa#topo')).toBe(
      'https://www.mercadolivre.com.br/x?access_token=***&etiqueta=wa',
    );
  });
});

describe('interpretarCorpo', () => {
  it('JSON vira objeto mascarado', () => {
    expect(N.interpretarCorpo('{"email":"x@y.com","link":"https://mercadolivre.com/sec/abc"}')).toEqual({
      json: { email: '***', link: 'https://mercadolivre.com/sec/abc' },
    });
  });
  it('ignora vazio e HTML; texto comum é mascarado', () => {
    expect(N.interpretarCorpo('')).toBeNull();
    expect(N.interpretarCorpo('<html></html>')).toBeNull();
    expect(N.interpretarCorpo('ok a@b.com')).toEqual({ texto: 'ok [email]' });
  });
  it('corta resposta gigante', () => {
    const r = N.interpretarCorpo('{"a":"' + 'x'.repeat(1_100_000) + '"}');
    expect(r.truncado).toBe(true);
    expect(r.inicio.length).toBe(2000);
  });
});

describe('montarArquivo', () => {
  it('cabeçalho do arquivo', () => {
    const a = N.montarArquivo([{ tipo: 'visita', plataforma: 'shopee' }, { tipo: 'visita', plataforma: 'amazon' }], { versao: '0.2.0' });
    expect(a).toMatchObject({ formato: 'cofilius-gravacao', versao: 2, plataformas: { shopee: 1, amazon: 1 }, extensao: '0.2.0', total: 2 });
  });
});

describe('sincronia com o painel', () => {
  it('reconhece só os relatórios que o painel usa', () => {
    expect(N.tipoSincronia('https://affiliate.shopee.com.br/api/v3/report/list?page_num=1')).toBe('shopee.conversoes');
    expect(N.tipoSincronia('/api/v1/click_report/list?page_num=1', 'https://affiliate.shopee.com.br/report/click_report')).toBe('shopee.cliques');
    expect(N.tipoSincronia('https://www.amazon.com.br/associates/sitestripe/getShortUrl?storeId=x')).toBe('amazon.link');
    expect(N.tipoSincronia('https://affiliate.shopee.com.br/api/v3/dashboard/detail')).toBeNull();
    expect(N.tipoSincronia('http://affiliate.shopee.com.br/api/v3/report/list')).toBeNull();
  });
  it('próxima página dos relatórios da Shopee', () => {
    const url = 'https://affiliate.shopee.com.br/api/v3/report/list?page_size=20&page_num=1&version=1';
    const dados = (pagina: number, total: number) => ({ code: 0, data: { page_num: pagina, page_size: 20, total_count: total, list: [] } });
    expect(N.proximaPagina(url, undefined, dados(1, 38))).toBe('https://affiliate.shopee.com.br/api/v3/report/list?page_size=20&page_num=2&version=1');
    expect(N.proximaPagina(url, undefined, dados(2, 38))).toBeNull();
    expect(N.proximaPagina(url, undefined, dados(1, 20))).toBeNull();
    expect(N.proximaPagina(url, undefined, dados(25, 9999))).toBeNull();
    expect(N.proximaPagina(url, undefined, { code: 1 })).toBeNull();
    expect(N.proximaPagina('https://www.amazon.com.br/associates/sitestripe/getShortUrl', undefined, dados(1, 50))).toBeNull();
  });
});
