import { describe, expect, it } from 'vitest';
import { gerarEtiquetas, normalizar, semanaIso, type EntradaEtiquetas } from './etiquetas.ts';

// 12/nov/2026 08:15 em São Paulo (UTC-3) = 11:15 UTC
const base: EntradaEtiquetas = {
  cliente: { codigo: 'c1' },
  canal: 'wa',
  quando: new Date('2026-11-12T11:15:00Z'),
  nicho: 'casa',
  oferta: { produtoId: '22912345' },
};

describe('gerarEtiquetas · Shopee', () => {
  it('monta os 5 sub_ids na ordem aprovada', () => {
    const e = gerarEtiquetas(base);
    expect(e.shopee.subIds).toEqual(['c1', 'wa', '20261112', '22912345', '0815']);
    expect(e.shopee.chave).toBe('c1-wa-20261112-22912345-0815');
  });

  it('usa o fuso do cliente para data e horário (virada do dia)', () => {
    // 02:30 UTC do dia 13 = 23:30 do dia 12 em São Paulo
    const e = gerarEtiquetas({ ...base, quando: new Date('2026-11-13T02:30:00Z') });
    expect(e.shopee.subIds[2]).toBe('20261112');
    expect(e.shopee.subIds[4]).toBe('2330');
  });

  it('respeita outro fuso', () => {
    const e = gerarEtiquetas({ ...base, fusoHorario: 'America/Manaus' }); // UTC-4
    expect(e.shopee.subIds[4]).toBe('0715');
  });

  it('meia-noite vira 0000, não 2400', () => {
    const e = gerarEtiquetas({ ...base, quando: new Date('2026-11-12T03:00:00Z') });
    expect(e.shopee.subIds[2]).toBe('20261112');
    expect(e.shopee.subIds[4]).toBe('0000');
  });

  it('link sem produto conhecido usa "avulso" no campo da oferta', () => {
    expect(gerarEtiquetas({ ...base, oferta: undefined }).shopee.subIds[3]).toBe('avulso');
    expect(gerarEtiquetas({ ...base, oferta: { produtoId: null } }).shopee.subIds[3]).toBe('avulso');
    expect(gerarEtiquetas({ ...base, oferta: { produtoId: '  ' } }).shopee.subIds[3]).toBe('avulso');
  });

  it('normaliza maiúsculas, acentos e símbolos', () => {
    const e = gerarEtiquetas({ ...base, cliente: { codigo: 'C1' }, canal: 'WhatsApp!', nicho: 'Decoração' });
    expect(e.shopee.subIds.slice(0, 2)).toEqual(['c1', 'whatsapp']);
    expect(e.mercadoLivre.etiqueta).toBe('whatsapp-s46-decoracao');
  });

  it('todo sub_id tem só letras minúsculas e números', () => {
    const e = gerarEtiquetas({ ...base, oferta: { produtoId: 'ABC-123_x' } });
    for (const s of e.shopee.subIds) expect(s).toMatch(/^[a-z0-9]+$/);
    expect(e.shopee.subIds[3]).toBe('abc123x');
  });

  it('recusa campo que fica vazio', () => {
    expect(() => gerarEtiquetas({ ...base, canal: '---' })).toThrow('canal');
    expect(() => gerarEtiquetas({ ...base, cliente: { codigo: '' } })).toThrow('cliente');
    expect(() => gerarEtiquetas({ ...base, nicho: ' ' })).toThrow('nicho');
  });

  it('recusa data inválida', () => {
    expect(() => gerarEtiquetas({ ...base, quando: new Date('x') })).toThrow('data');
  });
});

describe('gerarEtiquetas · Mercado Livre', () => {
  it('canal + semana ISO + nicho', () => {
    expect(gerarEtiquetas(base).mercadoLivre.etiqueta).toBe('wa-s46-casa');
  });

  it('semana com dois dígitos', () => {
    const e = gerarEtiquetas({ ...base, quando: new Date('2026-01-07T15:00:00Z') });
    expect(e.mercadoLivre.etiqueta).toBe('wa-s02-casa');
  });

  it('virada de ano segue a semana ISO', () => {
    // 1/jan/2027 (sexta) pertence à semana 53 de 2026
    const e = gerarEtiquetas({ ...base, quando: new Date('2027-01-01T15:00:00Z') });
    expect(e.mercadoLivre.etiqueta).toBe('wa-s53-casa');
  });
});

describe('gerarEtiquetas · Amazon', () => {
  it('sem tracking ID cadastrado: sugere nome e avisa', () => {
    expect(gerarEtiquetas(base).amazon).toEqual({ trackingId: null, sugestao: 'wa-casa', precisaCriarNoPainel: true });
  });

  it('com tracking ID cadastrado para canal e nicho: usa ele', () => {
    const e = gerarEtiquetas({ ...base, trackingIdsAmazon: { 'wa-casa': 'lojadela-20', 'wa-beleza': 'outro-20' } });
    expect(e.amazon).toEqual({ trackingId: 'lojadela-20', sugestao: 'wa-casa', precisaCriarNoPainel: false });
  });
});

describe('auxiliares', () => {
  it('semanaIso em datas conhecidas', () => {
    expect(semanaIso(2026, 11, 12)).toBe(46);
    expect(semanaIso(2026, 1, 1)).toBe(1); // quinta
    expect(semanaIso(2027, 1, 4)).toBe(1);
    expect(semanaIso(2021, 1, 3)).toBe(53); // domingo, ainda semana 53 de 2020
  });

  it('normalizar', () => {
    expect(normalizar('Ação & Cozinha 2')).toBe('acaocozinha2');
  });
});
