import { describe, expect, it } from 'vitest';
import { aplicarConformidade, AVISO_PRECO_AMAZON, DECLARACAO_AMAZON, lerConformidade, linkOficial, REGRAS } from './regras.ts';

describe('conformidade', () => {
  it('identificação no começo; Amazon com aviso de preço e declaração exata', () => {
    expect(aplicarConformidade('Achado R$ 10 👉 https://s.shopee.com.br/x', { plataforma: 'shopee', identificacao: '#publi', temPreco: true }))
      .toBe('#publi Achado R$ 10 👉 https://s.shopee.com.br/x');
    const a = aplicarConformidade('Achado 👉 https://amzn.to/x', { plataforma: 'amazon', identificacao: 'Publicidade', temPreco: true });
    expect(a.split('\n')).toEqual(['Publicidade Achado 👉 https://amzn.to/x', AVISO_PRECO_AMAZON, DECLARACAO_AMAZON]);
    expect(DECLARACAO_AMAZON).toBe('Como participante do Programa de Associados da Amazon, sou remunerado pelas compras qualificadas efetuadas.');
    expect(aplicarConformidade('Oi', { plataforma: 'amazon', identificacao: '#publi', temPreco: false })).toBe(`#publi Oi\n${DECLARACAO_AMAZON}`);
    // não duplica se o texto já começa com a identificação
    expect(aplicarConformidade('#publi Oi', { plataforma: 'shopee', identificacao: '#publi', temPreco: false })).toBe('#publi Oi');
  });

  it('só links dos domínios oficiais, sem encurtador de terceiros', () => {
    expect(linkOficial('shopee', 'https://s.shopee.com.br/AbC')).toBe(true);
    expect(linkOficial('amazon', 'https://link.amazon/B04ld')).toBe(true);
    expect(linkOficial('amazon', 'https://amzn.to/3x')).toBe(true);
    expect(linkOficial('mercado_livre', 'https://mercadolivre.com/sec/1a2b')).toBe(true);
    expect(linkOficial('shopee', 'https://bit.ly/x')).toBe(false);
    expect(linkOficial('amazon', 'http://amzn.to/x')).toBe(false);
    expect(linkOficial('shopee', 'https://s.shopee.com.br.golpe.net/x')).toBe(false);
  });

  it('padrão #publi; regras com fonte; ids únicos', () => {
    expect(lerConformidade(null)).toEqual({ identificacao: '#publi', checklist: {} });
    expect(lerConformidade({ identificacao: '  ', checklist: { a: 'x' } })).toEqual({ identificacao: '#publi', checklist: { a: 'x' } });
    expect(new Set(REGRAS.map((r) => r.id)).size).toBe(REGRAS.length);
    expect(REGRAS.every((r) => r.fonte && r.titulo && r.explicacao)).toBe(true);
  });
});
