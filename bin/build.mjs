#!/usr/bin/env node
// Reconstroi a biblioteca de midia:
//   originais/<tipo>/<grupo>/<arquivo>  ->  cdn/<tipo>/<grupo>/<arquivo>--<formato>.jpg
// e regenera indice.csv + index.html.
//
// Incremental: so reprocessa o que mudou (hash do arquivo de origem) e apaga
// derivados orfaos. Rodar de novo sem mudanca nenhuma nao altera nenhum arquivo.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR_ORIGINAIS = join(RAIZ, 'originais');
const DIR_CDN = join(RAIZ, 'cdn');
const ARQ_CACHE = join(RAIZ, '.midia-cache.json');

const EXTENSOES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tiff', '.gif']);

const cfg = JSON.parse(readFileSync(join(RAIZ, 'midia.config.json'), 'utf8'));

const urlCdn = (p) =>
  `https://cdn.jsdelivr.net/gh/${cfg.repositorio}@${cfg.branch}/${encodeURI(p)}`;
const urlRaw = (p) =>
  `https://raw.githubusercontent.com/${cfg.repositorio}/${cfg.branch}/${encodeURI(p)}`;

/** Lista recursivamente os arquivos de imagem sob `dir`. */
async function listarImagens(dir) {
  if (!existsSync(dir)) return [];
  const achados = [];
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    if (entrada.name.startsWith('.')) continue;
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...(await listarImagens(caminho)));
    else if (EXTENSOES.has(extname(entrada.name).toLowerCase())) achados.push(caminho);
  }
  return achados;
}

/** Lista recursivamente todos os arquivos sob `dir` (usado para achar orfaos). */
async function listarTudo(dir) {
  if (!existsSync(dir)) return [];
  const achados = [];
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    if (entrada.name.startsWith('.')) continue;
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...(await listarTudo(caminho)));
    else achados.push(caminho);
  }
  return achados;
}

const hashDe = (caminho) => createHash('sha1').update(readFileSync(caminho)).digest('hex');

const cache = existsSync(ARQ_CACHE) ? JSON.parse(readFileSync(ARQ_CACHE, 'utf8')) : {};
const cacheNovo = {};

const origens = (await listarImagens(DIR_ORIGINAIS)).sort();
const linhas = [];
const esperados = new Set();
let gerados = 0;
let reaproveitados = 0;

for (const origem of origens) {
  const rel = relative(DIR_ORIGINAIS, origem).split(sep);
  const tipo = rel[0];                                   // produtos | campanhas
  const grupo = rel.length > 2 ? rel[1] : '(sem grupo)'; // SKU ou nome da campanha
  const nomeBase = basename(origem, extname(origem));

  const ajuste = cfg.ajustePorPasta?.[tipo] ?? 'contain';
  const hash = hashDe(origem);
  const relOrigem = join('originais', relative(DIR_ORIGINAIS, origem)).split(sep).join('/');

  let meta;
  try {
    meta = await sharp(origem).metadata();
  } catch (erro) {
    console.error(`  ! ignorado (nao e imagem valida): ${relOrigem} — ${erro.message}`);
    continue;
  }

  // A origem em resolucao cheia tambem ganha link.
  linhas.push({
    tipo, grupo, arquivo: nomeBase, formato: 'original',
    largura: meta.width ?? '', altura: meta.height ?? '',
    peso_kb: Math.round((await stat(origem)).size / 1024),
    caminho: relOrigem,
  });

  const saidas = [];
  for (const [nomeFormato, dim] of Object.entries(cfg.formatos)) {
    const extensoes = cfg.gerarWebp ? ['jpg', 'webp'] : ['jpg'];

    for (const ext of extensoes) {
      const relSaida = join('cdn', tipo, grupo === '(sem grupo)' ? '' : grupo,
        `${nomeBase}--${nomeFormato}.${ext}`).split(sep).join('/');
      const destino = join(RAIZ, relSaida);
      esperados.add(relSaida);
      saidas.push(relSaida);

      const registro = cache[relOrigem];
      const jaValido = registro?.hash === hash
        && registro?.ajuste === ajuste
        && registro?.qualidade === cfg.qualidade
        && registro?.fundo === cfg.fundo
        && registro?.saidas?.includes(relSaida)
        && existsSync(destino);

      if (!jaValido) {
        mkdirSync(dirname(destino), { recursive: true });
        let pipe = sharp(origem).resize(dim.largura, dim.altura, {
          fit: ajuste,
          background: cfg.fundo,
          withoutEnlargement: false,
        });
        pipe = ext === 'webp'
          ? pipe.webp({ quality: cfg.qualidade })
          : pipe.flatten({ background: cfg.fundo }).jpeg({ quality: cfg.qualidade, mozjpeg: true });
        await pipe.toFile(destino);
        gerados++;
      } else {
        reaproveitados++;
      }

      linhas.push({
        tipo, grupo, arquivo: nomeBase, formato: `${nomeFormato} (${ext})`,
        largura: dim.largura, altura: dim.altura,
        peso_kb: Math.round((await stat(destino)).size / 1024),
        caminho: relSaida,
      });
    }
  }

  cacheNovo[relOrigem] = { hash, ajuste, qualidade: cfg.qualidade, fundo: cfg.fundo, saidas };
}

// Remove derivados de origens que sumiram ou de formatos que saíram da config.
let removidos = 0;
for (const arquivo of await listarTudo(DIR_CDN)) {
  const rel = relative(RAIZ, arquivo).split(sep).join('/');
  if (!esperados.has(rel)) {
    rmSync(arquivo);
    removidos++;
  }
}

writeFileSync(ARQ_CACHE, JSON.stringify(cacheNovo, null, 2) + '\n');

// ---------------------------------------------------------------- indice.csv
const COLUNAS = ['tipo', 'grupo', 'arquivo', 'formato', 'largura', 'altura', 'peso_kb', 'url_cdn', 'url_raw'];
const csvCampo = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csv = [COLUNAS.join(',')];
for (const l of linhas) {
  csv.push([l.tipo, l.grupo, l.arquivo, l.formato, l.largura, l.altura, l.peso_kb,
    urlCdn(l.caminho), urlRaw(l.caminho)].map(csvCampo).join(','));
}
writeFileSync(join(RAIZ, 'indice.csv'), '﻿' + csv.join('\n') + '\n');

// ----------------------------------------------------------------- index.html
const dadosGaleria = linhas.map((l) => ({
  ...l, url_cdn: urlCdn(l.caminho), url_raw: urlRaw(l.caminho),
}));
writeFileSync(join(RAIZ, 'index.html'), montarGaleria(dadosGaleria));

console.log(`origens: ${origens.length} | derivados gerados: ${gerados} | reaproveitados: ${reaproveitados} | orfaos removidos: ${removidos}`);
console.log(`linhas no indice: ${linhas.length}`);

function montarGaleria(itens) {
  const totalOriginais = itens.filter((i) => i.formato === 'original').length;
  const grupos = [...new Set(itens.map((i) => `${i.tipo}/${i.grupo}`))];

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Biblioteca de mídia — produtos e campanhas</title>
<style>
  :root {
    --fundo: #fbfaf9; --superficie: #fff; --borda: #e5e1dc;
    --texto: #1c1a17; --suave: #6b645c; --destaque: #b8552a; --ok: #2c7a4b;
  }
  :root:not([data-theme="light"]) { }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --fundo: #161513; --superficie: #201e1b; --borda: #35322e;
      --texto: #f0ece7; --suave: #a49b91; --destaque: #e4835a; --ok: #6bbd8b;
    }
  }
  :root[data-theme="dark"] {
    --fundo: #161513; --superficie: #201e1b; --borda: #35322e;
    --texto: #f0ece7; --suave: #a49b91; --destaque: #e4835a; --ok: #6bbd8b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--fundo); color: var(--texto);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { padding: 28px 20px 16px; max-width: 1400px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: -0.01em; }
  .sub { color: var(--suave); font-size: 14px; }
  .controles { position: sticky; top: 0; z-index: 5; background: var(--fundo);
    border-bottom: 1px solid var(--borda); padding: 12px 20px; }
  .controles .caixa { max-width: 1400px; margin: 0 auto; display: flex; gap: 10px; flex-wrap: wrap; }
  input[type=search], select {
    background: var(--superficie); color: var(--texto); border: 1px solid var(--borda);
    border-radius: 8px; padding: 8px 12px; font: inherit; font-size: 14px; }
  input[type=search] { flex: 1; min-width: 220px; }
  main { max-width: 1400px; margin: 0 auto; padding: 20px; }
  .grade { display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .cartao { background: var(--superficie); border: 1px solid var(--borda);
    border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
  .cartao img { width: 100%; aspect-ratio: 1; object-fit: contain;
    background: repeating-conic-gradient(#00000008 0% 25%, transparent 0% 50%) 50%/16px 16px; }
  .corpo { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .nome { font-weight: 600; font-size: 13px; word-break: break-word; }
  .meta { color: var(--suave); font-size: 12px; }
  .etiqueta { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 99px;
    border: 1px solid var(--borda); color: var(--suave); }
  .acoes { display: flex; gap: 6px; margin-top: auto; }
  button { flex: 1; cursor: pointer; font: inherit; font-size: 12px; padding: 6px 8px;
    border-radius: 7px; border: 1px solid var(--borda); background: transparent; color: var(--texto); }
  button:hover { border-color: var(--destaque); color: var(--destaque); }
  button.feito { border-color: var(--ok); color: var(--ok); }
  .vazio { text-align: center; color: var(--suave); padding: 60px 20px; }
  code { background: #80808018; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Biblioteca de mídia</h1>
  <div class="sub">${totalOriginais} imagem(ns) de origem · ${itens.length} link(s) disponíveis · ${grupos.length} grupo(s)</div>
</header>

<div class="controles"><div class="caixa">
  <input type="search" id="busca" placeholder="Buscar por produto, SKU, campanha ou arquivo…">
  <select id="fTipo"><option value="">Todos os tipos</option></select>
  <select id="fFormato"><option value="">Todos os formatos</option></select>
</div></div>

<main><div class="grade" id="grade"></div><div class="vazio" id="vazio" hidden>Nada encontrado.</div></main>

<script>
const ITENS = ${JSON.stringify(itens)};
const grade = document.getElementById('grade');
const vazio = document.getElementById('vazio');
const busca = document.getElementById('busca');
const fTipo = document.getElementById('fTipo');
const fFormato = document.getElementById('fFormato');

for (const v of [...new Set(ITENS.map(i => i.tipo))].sort())
  fTipo.append(Object.assign(document.createElement('option'), { value: v, textContent: v }));
for (const v of [...new Set(ITENS.map(i => i.formato))].sort())
  fFormato.append(Object.assign(document.createElement('option'), { value: v, textContent: v }));

function copiar(texto, botao) {
  navigator.clipboard.writeText(texto).then(() => {
    const antes = botao.textContent;
    botao.textContent = 'copiado'; botao.classList.add('feito');
    setTimeout(() => { botao.textContent = antes; botao.classList.remove('feito'); }, 1400);
  });
}

function desenhar() {
  const q = busca.value.trim().toLowerCase();
  const t = fTipo.value, f = fFormato.value;
  const visiveis = ITENS.filter(i =>
    (!t || i.tipo === t) && (!f || i.formato === f) &&
    (!q || \`\${i.grupo} \${i.arquivo} \${i.tipo}\`.toLowerCase().includes(q)));

  grade.replaceChildren();
  vazio.hidden = visiveis.length > 0;

  for (const i of visiveis) {
    const cartao = document.createElement('div');
    cartao.className = 'cartao';

    const img = document.createElement('img');
    img.loading = 'lazy'; img.src = i.url_cdn; img.alt = i.arquivo;
    cartao.append(img);

    const corpo = document.createElement('div');
    corpo.className = 'corpo';
    const nome = document.createElement('div');
    nome.className = 'nome'; nome.textContent = i.arquivo;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = \`\${i.grupo} · \${i.largura}×\${i.altura} · \${i.peso_kb} KB\`;
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta'; etiqueta.textContent = i.formato;

    const acoes = document.createElement('div');
    acoes.className = 'acoes';
    const bCdn = document.createElement('button');
    bCdn.textContent = 'copiar link'; bCdn.onclick = () => copiar(i.url_cdn, bCdn);
    const bAbrir = document.createElement('button');
    bAbrir.textContent = 'abrir'; bAbrir.onclick = () => window.open(i.url_cdn, '_blank');
    acoes.append(bCdn, bAbrir);

    corpo.append(nome, meta, etiqueta, acoes);
    cartao.append(corpo);
    grade.append(cartao);
  }
}

busca.oninput = desenhar; fTipo.onchange = desenhar; fFormato.onchange = desenhar;
desenhar();
</script>
</body>
</html>
`;
}
