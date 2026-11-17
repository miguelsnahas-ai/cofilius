import { describe, expect, it } from 'vitest';
import { descreverProblema, formatarPreco, preencherMensagem, verificarTextoModelo } from './marcadores.ts';

const valores = { preco: '29.90', desconto: '25.0000', link: 'https://s.shopee.com.br/AbC' };

describe('verificarTextoModelo', () => {
  it('aceita texto só com marcadores e números colados em letras', () => {
    expect(verificarTextoModelo('Organizador de gaveta por {{preco}} ({{desconto}} off)! Air Fryer 4L e kit 2x. 👉 {{link}}')).toEqual([]);
    expect(verificarTextoModelo('Corre: {{ link }}')).toEqual([]);
  });

  it('recusa link, dinheiro, percentual e número escritos', () => {
    const tipos = (t: string) => verificarTextoModelo(t).map((p) => p.tipo);
    expect(tipos('Compre aqui https://shopee.com.br/x {{link}}')).toEqual(['link_escrito']);
    expect(tipos('Veja em shopee.com.br {{link}}')).toEqual(['link_escrito']);
    expect(tipos('Só R$ 29,90! {{link}}')).toEqual(['dinheiro_escrito']);
    expect(tipos('Só 29,90 reais {{link}}')).toEqual(['dinheiro_escrito']);
    expect(tipos('Com 25% de desconto {{link}}')).toEqual(['percentual_escrito']);
    expect(tipos('Com 25 por cento {{link}}')).toEqual(['percentual_escrito']);
    expect(tipos('Kit com 6 divisórias {{link}}')).toEqual(['numero_escrito']);
    expect(tipos('Antes 59,90 {{link}}')).toEqual(['numero_escrito']);
  });

  it('exige {{link}} e recusa marcador desconhecido', () => {
    expect(verificarTextoModelo('Só {{preco}}').map((p) => p.tipo)).toEqual(['sem_link']);
    expect(verificarTextoModelo('{{comissao}} {{link}}').map((p) => p.tipo)).toEqual(['marcador_desconhecido']);
    expect(verificarTextoModelo('  ').map((p) => p.tipo)).toEqual(['vazio']);
  });

  it('descreve o problema em português', () => {
    expect(descreverProblema({ tipo: 'dinheiro_escrito', trecho: 'R$ 29' })).toContain('{{preco}}');
  });
});

describe('preencherMensagem', () => {
  it('preenche com os valores do banco', () => {
    expect(preencherMensagem('Por {{preco}}, {{desconto}} off: {{link}}', valores)).toBe(
      'Por R$ 29,90, 25% off: https://s.shopee.com.br/AbC',
    );
  });

  it('formata milhar', () => {
    expect(formatarPreco('1299.9')).toBe('R$ 1.299,90');
  });

  it('recusa {{desconto}} sem desconto e texto com problema', () => {
    expect(() => preencherMensagem('{{desconto}} {{link}}', { ...valores, desconto: null })).toThrow('não tem desconto');
    expect(() => preencherMensagem('{{desconto}} {{link}}', { ...valores, desconto: '0.0000' })).toThrow('não tem desconto');
    expect(() => preencherMensagem('R$ 10 {{link}}', valores)).toThrow('Texto recusado');
    expect(() => preencherMensagem('{{link}}', { ...valores, link: 'javascript:x' })).toThrow('Link inválido');
  });
});
