/*
 * Cofilius · aba Criativos: carrossel, stories e reels de uma oferta.
 *
 * O roteiro vem do agente Criativo (com preço e desconto já preenchidos pelo sistema, do banco).
 * Aqui o navegador desenha as telas num canvas, baixa as imagens (PNG) e grava o vídeo do reels
 * (MP4 quando o Chrome permite, senão WebM). Nada sai do computador.
 */
'use strict';

(() => {
const { $, el, api, agir, avisar, estado } = window.Cofilius;

const TAMANHOS = { carrossel: [1080, 1350], stories: [1080, 1920], reels: [1080, 1920] };
const NOMES = { carrossel: 'Carrossel', stories: 'Stories', reels: 'Reels' };
const ESTADOS = { rascunho: 'Rascunho', aprovado: 'Aprovado', publicado: 'Publicado' };
const FONTE_TITULO = 'Gabarito, "Trebuchet MS", sans-serif';
const FONTE_TEXTO = 'Onest, system-ui, sans-serif';

/** Estilo (tema, cor e @ do perfil), guardado por cliente neste navegador. */
const estilo = { tema: 'claro', cor: '#e8476c', perfil: '' };
function carregarEstilo() {
  try { Object.assign(estilo, { tema: 'claro', cor: '#e8476c', perfil: '' }, JSON.parse(localStorage.getItem(`cofilius-estilo-${estado.cliente}`) || '{}')); } catch { /* sem armazenamento */ }
}
function salvarEstilo() {
  try { localStorage.setItem(`cofilius-estilo-${estado.cliente}`, JSON.stringify(estilo)); } catch { /* sem armazenamento */ }
}

/** Fotos trocadas pelo operador, por criativo (só nesta sessão). */
const fotosTrocadas = new Map();
/** Fotos já carregadas (Image), por endereço. */
const fotosCarregadas = new Map();

function luminancia(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function paleta() {
  const cor = estilo.cor;
  const sobreCor = luminancia(cor) > 0.45 ? '#1f1524' : '#ffffff';
  if (estilo.tema === 'escuro') return { fundo: '#1f1524', cartao: '#2b2034', texto: '#fff8f0', suave: '#cbbccd', destaque: cor, sobreDestaque: sobreCor };
  if (estilo.tema === 'cor') return { fundo: cor, cartao: '#ffffff', texto: sobreCor, suave: sobreCor, destaque: '#1f1524', sobreDestaque: '#ffffff' };
  return { fundo: '#fff8f0', cartao: '#ffffff', texto: '#1f1524', suave: '#5e5263', destaque: cor, sobreDestaque: sobreCor };
}

// ---------------------------------------------------------------------------
// Desenho
// ---------------------------------------------------------------------------

function retanguloRedondo(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Quebra o texto em linhas que cabem na largura; diminui a fonte até caber no máximo de linhas. */
function caberTexto(ctx, texto, largura, { tamanho, minimo, peso, familia, maxLinhas }) {
  for (let t = tamanho; t >= minimo; t -= 2) {
    ctx.font = `${peso} ${t}px ${familia}`;
    const linhas = [];
    let atual = '';
    for (const palavra of String(texto).split(/\s+/)) {
      const teste = atual ? `${atual} ${palavra}` : palavra;
      if (ctx.measureText(teste).width <= largura || !atual) atual = teste;
      else { linhas.push(atual); atual = palavra; }
    }
    if (atual) linhas.push(atual);
    if (linhas.length <= maxLinhas || t - 2 < minimo) return { linhas: linhas.slice(0, maxLinhas), tamanho: t };
  }
  return { linhas: [String(texto)], tamanho: minimo };
}

function escrever(ctx, texto, x, y, largura, opcoes) {
  const { linhas, tamanho } = caberTexto(ctx, texto, largura, opcoes);
  const altura = tamanho * (opcoes.entrelinha || 1.15);
  ctx.fillStyle = opcoes.cor;
  ctx.textAlign = opcoes.alinhar || 'left';
  ctx.textBaseline = 'top';
  const xx = opcoes.alinhar === 'center' ? x + largura / 2 : x;
  linhas.forEach((l, i) => ctx.fillText(l, xx, y + i * altura));
  return y + linhas.length * altura;
}

/** Foto "cobrindo" a área (corta o excesso), com zoom opcional para o vídeo. */
function desenharFoto(ctx, img, x, y, w, h, raio, zoom = 1) {
  ctx.save();
  retanguloRedondo(ctx, x, y, w, h, raio);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, w, h);
  // "contain": produto inteiro aparecendo, sobre fundo branco (fotos de loja costumam ter fundo branco).
  const escala = Math.min(w / img.width, h / img.height) * 0.92 * zoom;
  const iw = img.width * escala, ih = img.height * escala;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  ctx.restore();
}

function selo(ctx, texto, x, y, { tamanho, fundo, cor, alinhar = 'left' }) {
  ctx.font = `700 ${tamanho}px ${FONTE_TITULO}`;
  const w = ctx.measureText(texto).width + tamanho * 1.1;
  const h = tamanho * 1.6;
  const xx = alinhar === 'center' ? x - w / 2 : alinhar === 'right' ? x - w : x;
  retanguloRedondo(ctx, xx, y, w, h, h / 2);
  ctx.fillStyle = fundo;
  ctx.fill();
  ctx.fillStyle = cor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(texto, xx + w / 2, y + h / 2 + 2);
  return { w, h };
}

/**
 * As telas de um criativo: capa (gancho + foto), as telas do roteiro e a tela final (preço e chamada).
 * Cada tela é { tipo, titulo, texto }.
 */
function telasDo(c) {
  return [
    { tipo: 'capa', titulo: c.roteiro.gancho },
    ...c.roteiro.telas.map((t) => ({ tipo: 'tela', titulo: t.titulo, texto: t.texto })),
    { tipo: 'final', titulo: c.roteiro.cta },
  ];
}

/**
 * Desenha a tela i do criativo. `anim` (0 a 1) anima a entrada do texto e o zoom da foto (vídeo);
 * sem `anim`, desenha parada.
 */
function desenharTela(ctx, c, i, foto, anim = 1) {
  const [W, H] = TAMANHOS[c.formato];
  const p = paleta();
  const telas = telasDo(c);
  const t = telas[i];
  const vertical = H > 1500;
  const m = 80; // margem
  const entrada = Math.min(1, anim * 1.6);
  const desloc = (1 - easeOut(entrada)) * 60;

  ctx.fillStyle = p.fundo;
  ctx.fillRect(0, 0, W, H);
  // faixa decorativa
  ctx.fillStyle = p.destaque;
  ctx.globalAlpha = estilo.tema === 'cor' ? 0.12 : 1;
  ctx.fillRect(0, 0, W, 18);
  ctx.globalAlpha = 1;

  // rodapé: @ do perfil e contador (carrossel)
  ctx.font = `600 34px ${FONTE_TEXTO}`;
  ctx.fillStyle = p.suave;
  ctx.textBaseline = 'alphabetic';
  if (estilo.perfil) { ctx.textAlign = 'left'; ctx.fillText(estilo.perfil.startsWith('@') ? estilo.perfil : `@${estilo.perfil}`, m, H - 60); }
  // Carrossel: na capa, o convite para arrastar; nas outras, o contador.
  if (c.formato === 'carrossel') { ctx.textAlign = 'right'; ctx.fillText(i === 0 ? 'arrasta para o lado →' : `${i + 1}/${telas.length}`, W - m, H - 60); }

  ctx.globalAlpha = entrada;
  if (t.tipo === 'capa') {
    const fotoH = vertical ? 900 : 640;
    const fotoY = vertical ? 260 : 140;
    if (foto) {
      desenharFoto(ctx, foto, m, fotoY, W - 2 * m, fotoH, 48, 1 + 0.06 * anim);
      if (c.desconto) selo(ctx, `-${c.desconto}`, W - m - 24, fotoY + 24, { tamanho: 56, fundo: p.destaque, cor: p.sobreDestaque, alinhar: 'right' });
    }
    const y0 = foto ? fotoY + fotoH + 70 : (vertical ? 520 : 360);
    escrever(ctx, t.titulo, m, y0 + desloc, W - 2 * m, { tamanho: foto ? 92 : 120, minimo: 56, peso: 800, familia: FONTE_TITULO, maxLinhas: foto ? 3 : 5, cor: p.texto, entrelinha: 1.08 });
  } else if (t.tipo === 'tela') {
    const fotoTam = vertical ? 520 : 380;
    let y = vertical ? 300 : 150;
    if (foto) {
      desenharFoto(ctx, foto, (W - fotoTam) / 2, y, fotoTam, fotoTam, 40, 1 + 0.04 * anim);
      y += fotoTam + 80;
    } else {
      y += vertical ? 300 : 200;
    }
    ctx.fillStyle = p.destaque;
    ctx.fillRect(m, y + desloc, 120, 12);
    y += 52;
    y = escrever(ctx, t.titulo, m, y + desloc, W - 2 * m, { tamanho: 84, minimo: 50, peso: 800, familia: FONTE_TITULO, maxLinhas: 2, cor: p.texto, entrelinha: 1.08 });
    escrever(ctx, t.texto, m, y + 30 + desloc, W - 2 * m, { tamanho: 54, minimo: 36, peso: 500, familia: FONTE_TEXTO, maxLinhas: vertical ? 6 : 4, cor: p.suave, entrelinha: 1.3 });
  } else {
    // tela final: foto, preço (do banco), desconto e chamada
    let y = vertical ? 240 : 120;
    if (foto) {
      const tam = vertical ? 620 : 380;
      desenharFoto(ctx, foto, (W - tam) / 2, y, tam, tam, 40, 1 + 0.04 * anim);
      y += tam + 70;
    } else {
      y += 180;
      y = escrever(ctx, c.titulo, m, y, W - 2 * m, { tamanho: 64, minimo: 40, peso: 700, familia: FONTE_TITULO, maxLinhas: 3, cor: p.texto, alinhar: 'center' }) + 50;
    }
    ctx.font = `600 44px ${FONTE_TEXTO}`;
    ctx.fillStyle = p.suave;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('por apenas', W / 2, y + desloc);
    y += 70;
    const s = selo(ctx, c.preco, W / 2, y + desloc, { tamanho: 110, fundo: p.destaque, cor: p.sobreDestaque, alinhar: 'center' });
    y += s.h + 30;
    if (c.desconto) {
      selo(ctx, `${c.desconto} de desconto`, W / 2, y + desloc, { tamanho: 46, fundo: p.texto, cor: p.fundo, alinhar: 'center' });
      y += 100;
    }
    y += 30;
    escrever(ctx, t.titulo, m, y + desloc, W - 2 * m, { tamanho: 64, minimo: 40, peso: 800, familia: FONTE_TITULO, maxLinhas: vertical ? 3 : 2, cor: p.texto, alinhar: 'center', entrelinha: 1.1 });
    if (c.formato === 'stories') {
      // espaço para o sticker de link do Instagram
      ctx.globalAlpha = entrada;
      ctx.setLineDash([18, 14]);
      ctx.lineWidth = 5;
      ctx.strokeStyle = p.suave;
      retanguloRedondo(ctx, (W - 560) / 2, H - 330, 560, 130, 65);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `600 36px ${FONTE_TEXTO}`;
      ctx.fillStyle = p.suave;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('cole o sticker do link aqui', W / 2, H - 265);
    }
    ctx.globalAlpha = entrada * 0.75;
    ctx.font = `500 26px ${FONTE_TEXTO}`;
    ctx.fillStyle = p.suave;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    // Aviso de preço com data e hora (exigido pela Amazon; vale para todos: preço pode mudar).
    const quando = c.precoConferidoEm || c.criadoEm;
    const dataHora = new Date(quando).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    ctx.fillText(`preço consultado em ${dataHora}; sujeito a alteração`, W / 2, H - (c.formato === 'stories' ? 160 : 130));
  }
  ctx.globalAlpha = 1;
}

function easeOut(x) { return 1 - (1 - x) ** 3; }

// ---------------------------------------------------------------------------
// Foto, PNG e vídeo
// ---------------------------------------------------------------------------

function carregarImagem(src) {
  if (fotosCarregadas.has(src)) return fotosCarregadas.get(src);
  const promessa = new Promise((ok) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => ok(null);
    img.src = src;
  });
  fotosCarregadas.set(src, promessa);
  return promessa;
}

async function fotoDo(c) {
  if (fotosTrocadas.has(c.id)) return carregarImagem(fotosTrocadas.get(c.id));
  if (c.imagemUrl) return carregarImagem(`/api/imagem?url=${encodeURIComponent(c.imagemUrl)}`);
  return null;
}

async function fontesProntas() {
  try {
    await Promise.all([document.fonts.load(`800 80px Gabarito`), document.fonts.load(`500 40px Onest`), document.fonts.load(`600 40px Onest`)]);
  } catch { /* usa a fonte de reserva */ }
}

function novoCanvas(c) {
  const [W, H] = TAMANHOS[c.formato];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  return canvas;
}

function nomeArquivo(c, sufixo) {
  const base = c.titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-+$/, '');
  return `${base || 'criativo'}-${c.formato}-${sufixo}`;
}

function baixar(blob, nome) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function baixarImagens(c, botao) {
  botao.disabled = true;
  try {
    await fontesProntas();
    const foto = await fotoDo(c);
    const telas = telasDo(c);
    for (let i = 0; i < telas.length; i++) {
      const canvas = novoCanvas(c);
      desenharTela(canvas.getContext('2d'), c, i, foto);
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
      baixar(blob, `${nomeArquivo(c, String(i + 1).padStart(2, '0'))}.png`);
      await new Promise((r) => setTimeout(r, 350));
    }
    avisar(`${telas.length} imagens baixadas. Se o Chrome perguntar, permita vários downloads.`);
  } finally {
    botao.disabled = false;
  }
}

/** Duração de cada cena do reels, em segundos. */
const DURACOES = { capa: 2.6, tela: 2.3, final: 3.2 };

function tipoDeVideo() {
  const tipos = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return tipos.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || null;
}

async function gravarVideo(c, botao, saida) {
  const tipo = tipoDeVideo();
  if (!tipo) return avisar('Este navegador não grava vídeo. Use o Chrome atualizado.', true);
  botao.disabled = true;
  const textoBotao = botao.textContent;
  try {
    await fontesProntas();
    const foto = await fotoDo(c);
    const canvas = novoCanvas(c);
    const ctx = canvas.getContext('2d');
    const telas = telasDo(c);
    const tempos = telas.map((t) => DURACOES[t.tipo]);
    const total = tempos.reduce((a, b) => a + b, 0);
    desenharTela(ctx, c, 0, foto, 0);
    const fluxo = canvas.captureStream(30);
    const gravador = new MediaRecorder(fluxo, { mimeType: tipo, videoBitsPerSecond: 8_000_000 });
    const partes = [];
    gravador.ondataavailable = (e) => { if (e.data.size) partes.push(e.data); };
    const fim = new Promise((ok) => { gravador.onstop = ok; });
    gravador.start(250);
    const inicio = performance.now();
    await new Promise((ok) => {
      const quadro = () => {
        const s = (performance.now() - inicio) / 1000;
        if (s >= total) { ok(); return; }
        let acum = 0;
        let i = 0;
        while (i < tempos.length - 1 && s >= acum + tempos[i]) { acum += tempos[i]; i++; }
        desenharTela(ctx, c, i, foto, Math.min(1, (s - acum) / tempos[i]));
        botao.textContent = `Gravando… ${Math.ceil(total - s)} s`;
        requestAnimationFrame(quadro);
      };
      requestAnimationFrame(quadro);
    });
    gravador.stop();
    await fim;
    const ext = tipo.startsWith('video/mp4') ? 'mp4' : 'webm';
    const blob = new Blob(partes, { type: tipo.split(';')[0] });
    const video = el('video', { attrs: { controls: '', playsinline: '', muted: '' } });
    video.src = URL.createObjectURL(blob);
    const link = el('button', { classe: 'secundario', texto: `Baixar vídeo (.${ext})`, attrs: { type: 'button' } });
    link.addEventListener('click', () => baixar(blob, `${nomeArquivo(c, 'video')}.${ext}`));
    saida.replaceChildren(video, el('div', { classe: 'acoes' }, link),
      ext === 'webm' ? el('p', { classe: 'ajuda', texto: 'Este Chrome só gravou em WebM. Se o Instagram recusar, atualize o Chrome (as versões novas gravam em MP4).' }) : null,
      el('p', { classe: 'ajuda', texto: 'Sem música: escolha um áudio em alta no próprio Instagram ao postar.' }));
    avisar('Vídeo pronto.');
  } catch (e) {
    avisar(`Não consegui gravar o vídeo: ${e.message}`, true);
  } finally {
    botao.disabled = false;
    botao.textContent = textoBotao;
  }
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

let dados = null;

/**
 * Link próprio do Instagram (canal "ig" nos sub_ids), para medir o Instagram separado do WhatsApp.
 * Shopee: gerado pela API (com um clique) ou no painel da Shopee com os sub_ids mostrados aqui.
 */
function secaoLink(c) {
  const caixa = el('div', { classe: 'link-instagram' });
  if (c.link) {
    const d = c.desempenho;
    caixa.append(el('p', { classe: `desempenho ${d && d.pedidos ? 'vendeu' : ''}` },
      el('span', { classe: 'rotulo', texto: 'Instagram' }),
      el('span', { classe: 'num', texto: d ? `${d.cliques} ${d.cliques === 1 ? 'clique' : 'cliques'} · ${d.pedidos} ${d.pedidos === 1 ? 'pedido' : 'pedidos'}${d.comissao ? ` · ${window.Cofilius.reais(d.comissao)}` : ''}` : 'link próprio registrado' })));
    return caixa;
  }
  if (!c.preparoLink) {
    caixa.append(el('p', { classe: 'aviso', texto: c.plataforma === 'amazon'
      ? 'Amazon: para medir o Instagram separado, crie no painel de Associados um tracking ID só para o Instagram e gere o link do produto com ele.'
      : 'Link próprio do Instagram ainda não disponível para esta plataforma.' }));
    return caixa;
  }
  const p = c.preparoLink;
  caixa.append(el('p', { classe: 'aviso', texto: 'Este criativo precisa de um link só do Instagram (não use o link do WhatsApp), para saber o que vendeu em cada canal.' }));
  if (dados && dados.linkAutomatico) {
    const gerar = el('button', { texto: 'Gerar link do Instagram', attrs: { type: 'button' } });
    gerar.addEventListener('click', () => agir(gerar, () => api(`/api/criativos/${c.id}/link`, { automatico: true }), 'Link do Instagram gerado'));
    caixa.append(el('div', { classe: 'acoes' }, gerar));
    return caixa;
  }
  const subids = el('div', { classe: 'subids' });
  p.subIds.forEach((v, i) => {
    subids.append(el('span', { classe: 'subid' }, `Sub_id${i + 1}: ${v}`,
      el('button', { classe: 'secundario', texto: 'copiar', attrs: { type: 'button', 'aria-label': `Copiar Sub_id${i + 1}` },
        onclick: () => copiar(v, `Sub_id${i + 1} copiado`) })));
  });
  const campo = el('input', { attrs: { type: 'url', placeholder: 'Cole o link gerado no painel (https://s.shopee.com.br/...)', 'aria-label': 'Link do Instagram' } });
  const registrar = el('button', { texto: 'Registrar link do Instagram', attrs: { type: 'button' } });
  registrar.addEventListener('click', () => agir(registrar,
    () => api(`/api/criativos/${c.id}/link`, { link: campo.value, quando: p.quando }), 'Link do Instagram registrado'));
  caixa.append(
    el('p', { classe: 'motivo' }, 'No painel da Shopee, gere o link personalizado deste produto com estes Sub_ids (o segundo é "ig", de Instagram): ',
      el('a', { texto: 'abrir o produto', attrs: { href: p.urlProduto, target: '_blank', rel: 'noopener noreferrer' } })),
    subids,
    el('div', { classe: 'linha-form' }, campo, registrar));
  return caixa;
}

async function desenharMiniaturas(c, alvo) {
  await fontesProntas();
  const foto = await fotoDo(c);
  const telas = telasDo(c);
  alvo.replaceChildren(...telas.map((_, i) => {
    const canvas = novoCanvas(c);
    canvas.className = `miniatura ${c.formato === 'carrossel' ? 'retrato' : 'vertical'}`;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Tela ${i + 1} de ${telas.length}`);
    desenharTela(canvas.getContext('2d'), c, i, foto);
    return canvas;
  }));
}

function copiar(texto, msg) {
  navigator.clipboard.writeText(texto).then(() => avisar(msg)).catch(() => avisar('Não consegui copiar: selecione e use Ctrl+C.', true));
}

function cartao(c) {
  const miniaturas = el('div', { classe: 'tira' });
  const saidaVideo = el('div', { classe: 'saida-video' });
  const acoes = el('div', { classe: 'acoes' });
  const botao = (texto, classe, fn) => {
    const b = el('button', { classe, texto, attrs: { type: 'button' } });
    b.addEventListener('click', () => fn(b));
    acoes.append(b);
    return b;
  };
  if (c.formato === 'reels') botao('Gerar vídeo', '', (b) => gravarVideo(c, b, saidaVideo));
  else botao(`Baixar ${telasDo(c).length} imagens`, '', (b) => baixarImagens(c, b));
  botao('Copiar legenda', 'secundario', () => copiar(c.roteiro.legenda, 'Legenda copiada.'));
  if (c.link) botao(c.formato === 'stories' ? 'Copiar link do Instagram (sticker)' : 'Copiar link do Instagram (bio)', 'secundario', () => copiar(c.link, 'Link do Instagram copiado.'));
  if (c.estado === 'rascunho') botao('Aprovar', 'secundario', (b) => agir(b, () => api(`/api/criativos/${c.id}/aprovar`, {}), 'Criativo aprovado'));
  if (c.estado !== 'publicado') botao('Marcar como publicado', 'secundario', (b) => agir(b, () => api(`/api/criativos/${c.id}/publicado`, {}), 'Marcado como publicado'));
  if (c.estado !== 'publicado') botao('Descartar', 'perigo', (b) => { if (window.confirm('Descartar este criativo?')) agir(b, () => api(`/api/criativos/${c.id}/descartar`, {}), 'Descartado'); });

  const trocar = el('input', { attrs: { type: 'file', accept: 'image/*', 'aria-label': 'Trocar a foto do produto' } });
  trocar.addEventListener('change', () => {
    const f = trocar.files && trocar.files[0];
    if (!f) return;
    fotosTrocadas.set(c.id, URL.createObjectURL(f));
    desenharMiniaturas(c, miniaturas);
  });

  const conferido = c.precoConferidoEm
    ? `Preço conferido em ${new Date(c.precoConferidoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`
    : 'Preço da coleta (não conferido): confira na loja antes de postar.';
  const artigo = el('article', { classe: 'cartao criativo' },
    el('div', { classe: 'cartao-topo' },
      el('span', { classe: 'titulo' }, el('span', { classe: 'chip', texto: NOMES[c.formato] }), ` ${c.titulo}`),
      el('span', { classe: 'chip', texto: ESTADOS[c.estado] || c.estado })),
    el('p', { classe: 'motivo', texto: `${c.preco}${c.desconto ? ` · ${c.desconto} de desconto` : ''} · ${conferido}` }),
    miniaturas,
    el('label', { classe: 'trocar-foto' },
      c.imagemUrl ? 'Trocar a foto '
        : c.plataforma === 'amazon' ? 'Amazon: a foto da loja não pode ser usada. Escolha uma foto sua do produto '
          : 'Sem foto da loja. Escolha uma foto do produto ', trocar),
    el('details', { classe: 'legenda' }, el('summary', { texto: 'Legenda' }), el('div', { classe: 'conversa' }, el('div', { classe: 'balao', texto: c.roteiro.legenda }))),
    secaoLink(c),
    acoes,
    saidaVideo);
  desenharMiniaturas(c, miniaturas);
  return artigo;
}

function desenhar() {
  const d = dados;
  const sel = $('criativo-oferta');
  sel.replaceChildren(...d.ofertas.map((o) => el('option', {
    texto: `${o.escolhida ? '★ ' : ''}${o.titulo.slice(0, 70)}${o.temLink ? '' : ' (sem link ainda)'}${o.temFoto ? '' : ' · sem foto'}`,
    attrs: { value: o.id },
  })));
  $('form-criativo').querySelector('button[type=submit]').disabled = !d.ofertas.length || !d.iaDisponivel;
  $('criativo-aviso').textContent = !d.iaDisponivel ? 'Coloque a chave da IA na Configuração para criar criativos.'
    : !d.ofertas.length ? 'Nenhuma oferta neste dia. Importe as ofertas primeiro.' : '';
  $('criativo-aviso').hidden = !$('criativo-aviso').textContent;
  $('lista-criativos').replaceChildren(...(d.criativos.length ? d.criativos.map(cartao)
    : [el('p', { classe: 'vazio', texto: 'Nenhum criativo neste dia ainda.' })]));
}

async function carregar() {
  if (!estado.cliente) return;
  carregarEstilo();
  const f = $('form-estilo');
  f.elements.tema.value = estilo.tema;
  f.elements.cor.value = estilo.cor;
  f.elements.perfil.value = estilo.perfil;
  const data = $('criativo-data').value || window.Cofilius.dataLocal();
  $('criativo-data').value = data;
  dados = await api(`/api/criativos?cliente=${encodeURIComponent(estado.cliente)}&data=${data}`);
  desenhar();
}

window.Cofilius.registrar('criativos', {
  mostrar: carregar,
  iniciar() {
    $('criativo-data').addEventListener('change', carregar);
    $('form-estilo').addEventListener('input', () => {
      const f = $('form-estilo');
      estilo.tema = f.elements.tema.value;
      estilo.cor = f.elements.cor.value;
      estilo.perfil = f.elements.perfil.value.trim();
      salvarEstilo();
      if (dados) desenhar();
    });
    $('form-criativo').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget;
      const b = f.querySelector('button[type=submit]');
      const texto = b.textContent;
      b.textContent = 'A IA está escrevendo…';
      agir(b, () => api('/api/criativos', { ofertaId: f.elements.oferta.value, formato: f.elements.formato.value, data: $('criativo-data').value }),
        'Criativo criado. Confira as telas e a legenda.').finally(() => { b.textContent = texto; });
    });
  },
});
})();
