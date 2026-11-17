import { describe, expect, it } from 'vitest';
import { regrasCriativo, type EntradaCriativo, type SaidaCriativo } from '../../agents/criativo/regras.ts';
import { verificarTextoModelo } from '../lista/marcadores.ts';
import { buscarImagem, imagemPermitida } from './imagem.ts';

const entrada: EntradaCriativo = { formato: 'carrossel', oferta: { titulo: 'Organizador', nicho: 'casa', tem_desconto: false }, tom: '', telas: 2 };
const saida = (o: Partial<SaidaCriativo> = {}): SaidaCriativo => ({
  gancho: 'Achei o organizador perfeito', telas: [{ titulo: 'Gaveta bagunçada?', texto: 'Acabou.' }, { titulo: 'Cabe tudo', texto: 'Por {{preco}} vale muito.' }],
  cta: 'Comenta EU QUERO', legenda: 'Organização sem complicação ✨ #achadinhos #casa', ...o,
});

describe('regras do Criativo', () => {
  it('aceita roteiro com marcadores e sem link', () => {
    expect(regrasCriativo(entrada, saida())).toEqual([]);
  });
  it('recusa número, preço, link, {{link}}, desconto sem desconto, telas a mais e hashtags demais', () => {
    const p = regrasCriativo(entrada, saida({
      gancho: 'Só R$ 29,90 hoje', cta: 'Link: {{link}}', legenda: 'Corre que tem {{desconto}} #a #b #c #d #e #f',
      telas: [{ titulo: 'Seis divisórias', texto: 'São 6 espaços' }, { titulo: 'Veja', texto: 'shopee.com.br' }, { titulo: 'Extra', texto: 'Mais uma' }],
    }));
    expect(p.join(' | ')).toMatch(/gancho: valor em dinheiro/);
    expect(p.join(' | ')).toMatch(/tela 1 \(texto\): número escrito/);
    expect(p.join(' | ')).toMatch(/tela 2 \(texto\): link escrito/);
    expect(p.join(' | ')).toMatch(/cta: não use \{\{link\}\}/);
    expect(p.join(' | ')).toMatch(/legenda: usou \{\{desconto\}\}/);
    expect(p.join(' | ')).toMatch(/exatamente 2 telas/);
    expect(p.join(' | ')).toMatch(/6 hashtags/);
  });
  it('recusa o nome da loja no conteúdo de rede social', () => {
    const p = regrasCriativo(entrada, saida({ gancho: 'Achado da Shopee pra você', legenda: 'Corre no Mercado Livre ✨' }));
    expect(p.join(' | ')).toMatch(/gancho: não cite o nome da loja \("Shopee"\)/);
    expect(p.join(' | ')).toMatch(/legenda: não cite o nome da loja \("Mercado Livre"\)/);
  });
  it('a conferência de mensagem continua exigindo {{link}} por padrão', () => {
    expect(verificarTextoModelo('Oferta boa por {{preco}}').map((x) => x.tipo)).toEqual(['sem_link']);
    expect(verificarTextoModelo('Oferta boa por {{preco}}', { exigirLink: false })).toEqual([]);
  });
});

describe('foto do produto (proxy)', () => {
  it('só domínios de imagem das plataformas, por https', () => {
    expect(imagemPermitida('https://down-br.img.susercontent.com/file/abc')).not.toBeNull();
    expect(imagemPermitida('https://m.media-amazon.com/images/I/x.jpg')).toBeNull(); // Amazon não permite guardar as imagens
    expect(imagemPermitida('https://http2.mlstatic.com/D_x.jpg')).not.toBeNull();
    expect(imagemPermitida('http://down-br.img.susercontent.com/x')).toBeNull();
    expect(imagemPermitida('https://susercontent.com.golpe.net/x')).toBeNull();
    expect(imagemPermitida('https://127.0.0.1/x')).toBeNull();
    expect(imagemPermitida('https://user:senha@down-br.img.susercontent.com/x')).toBeNull();
  });
  it('recusa o que não é imagem e tenta de novo em erro passageiro', async () => {
    let chamadas = 0;
    const falso = (async () => {
      chamadas++;
      if (chamadas === 1) return new Response('x', { status: 503 });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    }) as unknown as typeof fetch;
    const img = await buscarImagem('https://down-br.img.susercontent.com/file/x', falso);
    expect(img.tipo).toBe('image/jpeg');
    expect(chamadas).toBe(2);
    const html = (async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(buscarImagem('https://down-br.img.susercontent.com/x', html)).rejects.toThrow('Não é uma imagem');
    await expect(buscarImagem('https://exemplo.com/x.jpg', html)).rejects.toThrow('não permitido');
  });
});
