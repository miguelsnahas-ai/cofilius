/* Cofilius · configuração inicial (só aparece enquanto o painel não tem banco e senha). */
'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('form-configurar');
  const mensagem = document.getElementById('mensagem');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(form).entries());
    if (d.senha !== d.senha2) { mensagem.textContent = 'As duas senhas não são iguais.'; return; }
    const botao = form.querySelector('button');
    botao.disabled = true;
    mensagem.textContent = 'Conectando ao banco e criando as tabelas… (pode levar alguns segundos)';
    try {
      const r = await fetch('/api/configurar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cofilius': '1' },
        body: JSON.stringify({ databaseUrl: d.databaseUrl, senha: d.senha, operador: d.operador, anthropicKey: d.anthropicKey }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
      mensagem.textContent = 'Pronto! Abrindo o painel… Quando o navegador pedir, use qualquer usuário e a senha que você acabou de criar.';
      setTimeout(() => { location.href = '/'; }, 1500);
    } catch (e) {
      mensagem.textContent = e.message;
      botao.disabled = false;
    }
  });
});
