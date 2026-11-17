import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lerCsv, numeroBr } from '../../harness/csv.ts';
import { lerPlanilhaOfertas } from './importarPlanilhaShopee.ts';
import { horarioLocalParaData } from '../etiquetas/etiquetas.ts';
import { validarLinkDoPainel } from '../links/linksManuaisShopee.ts';

describe('lerCsv', () => {
  it('separador ";" com aspas e BOM', () => {
    expect(lerCsv('﻿a;b\n"x;1";"diz ""oi"""\r\n\n')).toEqual([['a', 'b'], ['x;1', 'diz "oi"']]);
  });
  it('separador ","', () => {
    expect(lerCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
  it('quebra de linha dentro de aspas', () => {
    expect(lerCsv('a;b\n"linha1\nlinha2";2')).toEqual([['a', 'b'], ['linha1\nlinha2', '2']]);
  });
});

describe('numeroBr', () => {
  it('formatos aceitos', () => {
    expect(numeroBr('R$ 1.299,90')).toBe(1299.9);
    expect(numeroBr('29,90')).toBe(29.9);
    expect(numeroBr('29.90')).toBe(29.9);
    expect(numeroBr('25%')).toBe(25);
    expect(numeroBr('')).toBeNull();
    expect(numeroBr('-')).toBeNull();
    expect(numeroBr('abc')).toBeNaN();
  });
});

describe('lerPlanilhaOfertas', () => {
  it('lê o modelo de docs/modelos', () => {
    const texto = readFileSync(join(import.meta.dirname, '../../docs/modelos/ofertas-shopee.csv'), 'utf8');
    const r = lerPlanilhaOfertas(texto, null);
    expect(r.erros).toEqual([]);
    expect(r.itens).toHaveLength(2);
    expect(r.itens[0]).toMatchObject({
      linha: 2,
      nicho: 'casa',
      oferta: {
        produtoId: '22912345678', lojaId: '334455667', preco: '29.90', descontoPct: '25.0000',
        comissaoPct: '12.0000', comissaoValor: '3.59',
        urlProduto: 'https://shopee.com.br/product/334455667/22912345678',
      },
    });
    expect(r.itens[1]!.oferta).toMatchObject({ preco: '289.90', descontoPct: null, comissaoPct: '7.5000', comissaoValor: null });
  });

  it('aceita cabeçalho com acento e maiúsculas, e usa o nicho padrão', () => {
    const r = lerPlanilhaOfertas('Link,Título,Preço (R$)\nhttps://shopee.com.br/x-i.1.2,Produto,"10,00"', 'beleza');
    expect(r.erros).toEqual([]);
    expect(r.itens[0]).toMatchObject({ nicho: 'beleza', oferta: { produtoId: '2', preco: '10.00' } });
  });

  it('recusa linhas com problema e diz o motivo', () => {
    const texto = [
      'link;titulo;preco;comissao',
      'https://s.shopee.com.br/AbC;Curto;10;5',
      'https://amazon.com.br/x;Fora;10;5',
      'https://shopee.com.br/x-i.1.2;;10;5',
      'https://shopee.com.br/x-i.1.3;Sem preço;;5',
      'https://shopee.com.br/x-i.1.4;Comissão alta;10;150',
      'https://shopee.com.br/x-i.1.5;Ok;10;5',
      'https://shopee.com.br/y-i.1.5;Repetido;10;5',
    ].join('\n');
    const r = lerPlanilhaOfertas(texto, null);
    expect(r.itens.map((i) => i.oferta.produtoId)).toEqual(['5']);
    expect(r.erros.map((e) => e.linha)).toEqual([2, 3, 4, 5, 6, 8]);
    expect(r.erros[0]!.motivo).toContain('link completo');
    expect(r.erros[1]!.motivo).toContain('não é da Shopee');
    expect(r.erros[2]!.motivo).toContain('título');
    expect(r.erros[3]!.motivo).toContain('preço');
    expect(r.erros[4]!.motivo).toContain('comissão');
    expect(r.erros[5]!.motivo).toContain('linha 7');
  });

  it('recusa planilha sem as colunas obrigatórias', () => {
    expect(() => lerPlanilhaOfertas('nome;valor\nx;1', null)).toThrow('link');
  });
});

describe('horarioLocalParaData', () => {
  it('converte horário de São Paulo para UTC', () => {
    expect(horarioLocalParaData('2026-11-12 08:15').toISOString()).toBe('2026-11-12T11:15:00.000Z');
    expect(horarioLocalParaData('2026-11-12T23:30', 'America/Manaus').toISOString()).toBe('2026-11-13T03:30:00.000Z');
  });
  it('recusa formato errado', () => {
    expect(() => horarioLocalParaData('12/11/2026 08:15')).toThrow('AAAA-MM-DD');
    expect(() => horarioLocalParaData('2026-13-01 08:15')).toThrow();
  });
});

describe('validarLinkDoPainel', () => {
  it('aceita links da Shopee e recusa os outros', () => {
    expect(validarLinkDoPainel(' https://s.shopee.com.br/AbC ')).toBe('https://s.shopee.com.br/AbC');
    expect(validarLinkDoPainel('https://shope.ee/xyz')).toBe('https://shope.ee/xyz');
    expect(() => validarLinkDoPainel('http://s.shopee.com.br/AbC')).toThrow();
    expect(() => validarLinkDoPainel('https://bit.ly/x')).toThrow('Shopee');
    expect(() => validarLinkDoPainel('lixo')).toThrow('inválido');
  });
});
