import { describe, expect, it } from 'vitest';
import './nucleo.js';

const N = (globalThis as any).CofiliusNucleo;

describe('deveGravar', () => {
  it('grava só Mercado Livre e ignora métricas', () => {
    expect(N.deveGravar('https://www.mercadolivre.com.br/afiliados/api/links')).toBe(true);
    expect(N.deveGravar('https://api.mercadolibre.com/users/me')).toBe(true);
    expect(N.deveGravar('/api/relatorio', 'https://www.mercadolivre.com.br/afiliados')).toBe(true);
    expect(N.deveGravar('https://shopee.com.br/api')).toBe(false);
    expect(N.deveGravar('https://mercadolivre.com.br.golpe.com/x')).toBe(false);
    expect(N.deveGravar('https://www.mercadolivre.com.br/melidata/tracks')).toBe(false);
    expect(N.deveGravar('https://www.google-analytics.com/collect')).toBe(false);
    expect(N.deveGravar('data:text/plain,oi')).toBe(false);
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
    const a = N.montarArquivo([{ tipo: 'visita' }], { versao: '0.1.0' });
    expect(a).toMatchObject({ formato: 'cofilius-gravacao', versao: 1, plataforma: 'mercado_livre', extensao: '0.1.0', total: 1 });
  });
});
