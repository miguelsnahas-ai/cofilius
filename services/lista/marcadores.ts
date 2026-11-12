/**
 * Marcadores das mensagens.
 *
 * Regra do projeto: a IA (ou quem escrever o texto) nunca escreve link, preço ou desconto.
 * O texto vem com marcadores e o código preenche com valores do banco.
 *
 *   {{preco}}     preço atual da oferta, ex.: "R$ 29,90"
 *   {{desconto}}  desconto da oferta, ex.: "25%"
 *   {{link}}      link de afiliado gravado em `links`
 *
 * O texto modelo é recusado se trouxer, fora dos marcadores: link ou domínio, valor em dinheiro,
 * percentual, ou número solto. Números grudados em letras (4L, 128GB, 2x) são aceitos, porque fazem
 * parte do nome do produto; "6 divisórias" não é: escreva "seis divisórias".
 */

export const MARCADORES = ['preco', 'desconto', 'link'] as const;
export type Marcador = (typeof MARCADORES)[number];

const RE_MARCADOR = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

export interface ProblemaTexto {
  tipo: 'marcador_desconhecido' | 'sem_link' | 'link_escrito' | 'dinheiro_escrito' | 'percentual_escrito' | 'numero_escrito' | 'vazio';
  trecho: string;
}

/** Confere o texto modelo. Lista vazia = texto aceito. */
export function verificarTextoModelo(texto: string): ProblemaTexto[] {
  const problemas: ProblemaTexto[] = [];
  if (!texto.trim()) return [{ tipo: 'vazio', trecho: '' }];

  const usados = new Set<string>();
  for (const m of texto.matchAll(RE_MARCADOR)) {
    const nome = m[1]!.toLowerCase();
    if (!(MARCADORES as readonly string[]).includes(nome)) problemas.push({ tipo: 'marcador_desconhecido', trecho: m[0] });
    usados.add(nome);
  }
  if (!usados.has('link')) problemas.push({ tipo: 'sem_link', trecho: '' });

  const semMarcadores = texto.replace(RE_MARCADOR, ' ');
  const regras: [ProblemaTexto['tipo'], RegExp][] = [
    ['link_escrito', /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(com|br|net|ee|to|ly|me)(\.br)?\b(\/\S*)?)/gi],
    ['dinheiro_escrito', /(R\$\s*\d[\d.,]*|\$\s*\d[\d.,]*|\d[\d.,]*\s*(reais|real)\b)/gi],
    ['percentual_escrito', /\d[\d.,]*\s*(%|por\s*cento)/gi],
    ['numero_escrito', /(?<![\p{L}\d])\d[\d.,]*(?![\p{L}\d])/gu],
  ];
  const jaApontado: string[] = [];
  for (const [tipo, re] of regras) {
    for (const m of semMarcadores.matchAll(re)) {
      if (jaApontado.some((t) => t.includes(m[0]) || m[0].includes(t))) continue;
      jaApontado.push(m[0]);
      problemas.push({ tipo, trecho: m[0].trim() });
    }
  }
  return problemas;
}

export function descreverProblema(p: ProblemaTexto): string {
  switch (p.tipo) {
    case 'vazio': return 'texto vazio';
    case 'sem_link': return 'falta o marcador {{link}}';
    case 'marcador_desconhecido': return `marcador desconhecido: ${p.trecho} (use {{preco}}, {{desconto}} ou {{link}})`;
    case 'link_escrito': return `link escrito no texto: "${p.trecho}" (use {{link}})`;
    case 'dinheiro_escrito': return `valor em dinheiro escrito no texto: "${p.trecho}" (use {{preco}})`;
    case 'percentual_escrito': return `percentual escrito no texto: "${p.trecho}" (use {{desconto}})`;
    case 'numero_escrito': return `número escrito no texto: "${p.trecho}" (escreva por extenso ou use um marcador)`;
  }
}

export interface ValoresMensagem {
  /** Preço em texto decimal, como vem do banco ("29.90"). */
  preco: string;
  /** Desconto em pontos percentuais ("25.0000"), ou null. */
  desconto: string | null;
  link: string;
}

const formatoReais = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatarPreco(preco: string): string {
  const n = Number(preco);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Preço inválido: ${preco}`);
  return formatoReais.format(n).replace(/ /g, ' ');
}

export function formatarDesconto(desconto: string): string {
  const n = Number(desconto);
  if (!Number.isFinite(n) || n <= 0 || n > 100) throw new Error(`Desconto inválido: ${desconto}`);
  return `${Math.round(n)}%`;
}

/** Preenche os marcadores. Lança erro se o texto não passar na conferência ou faltar valor. */
export function preencherMensagem(textoModelo: string, valores: ValoresMensagem): string {
  const problemas = verificarTextoModelo(textoModelo);
  if (problemas.length) throw new Error(`Texto recusado: ${problemas.map(descreverProblema).join('; ')}`);
  return textoModelo.replace(RE_MARCADOR, (_t, nome: string) => {
    switch (nome.toLowerCase() as Marcador) {
      case 'preco':
        return formatarPreco(valores.preco);
      case 'desconto':
        if (valores.desconto === null || Number(valores.desconto) <= 0) {
          throw new Error('O texto usa {{desconto}}, mas a oferta não tem desconto.');
        }
        return formatarDesconto(valores.desconto);
      case 'link':
        if (!/^https:\/\//.test(valores.link)) throw new Error(`Link inválido: ${valores.link}`);
        return valores.link;
    }
  });
}
