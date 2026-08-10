# Biblioteca de mídia — produtos e campanhas

Repositório onde as imagens ficam organizadas e ganham **link público permanente**, para colar em campanhas sem subir o arquivo bruto toda vez.

Você joga a imagem numa pasta. O robô gera os recortes de cada canal, atualiza a planilha de links e a galeria. Você copia o link e usa.

## Como adicionar uma imagem

Tudo pela interface web do GitHub — não precisa instalar nada.

1. Entre na pasta certa:
   - **`originais/produtos/<SKU>/`** — fotos de produto do catálogo
   - **`originais/campanhas/<nome-da-campanha>/`** — artes que não existem na loja
2. **Add file → Upload files** (ou arraste os arquivos para a janela)
3. **Commit changes**

Em cerca de um minuto a aba **Actions** mostra o build concluído, e os links já existem. Se a pasta do produto ou da campanha ainda não existe, crie escrevendo o caminho no campo de nome ao subir o arquivo: `produtos/CAM-AZUL-M/frente.jpg`.

## Onde ficam os links

| Onde | O que é |
|---|---|
| **`index.html`** | Galeria visual com miniatura, busca e botão de copiar link |
| **`indice.csv`** | Uma linha por imagem: tipo, grupo, formato, dimensões, peso e as duas URLs |

Para abrir a galeria no navegador, ligue o GitHub Pages uma vez: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `/ (root)` → Save**. A galeria passa a viver em `https://raphavianna.github.io/midia-produtos/`.

## Formatos gerados

Cada imagem de origem vira cinco recortes, além do original em resolução cheia:

| Formato | Tamanho | Uso típico |
|---|---|---|
| `quadrado-1x1` | 1080×1080 | Feed Meta e Instagram, Google Shopping |
| `vertical-4x5` | 1080×1350 | Feed vertical Meta (ocupa mais tela) |
| `story-9x16` | 1080×1920 | Stories e Reels |
| `wide-16x9` | 1200×675 | Google Display, prévia de link, e-mail |
| `thumb` | 400×400 | Miniatura, listagem, catálogo interno |

A saída é **JPG**, porque Meta e Google Ads não aceitam WebP em criativos. Se precisar de WebP para site ou e-mail, mude `gerarWebp` para `true` em `midia.config.json`.

### Produto e campanha são recortados de formas diferentes

- **Produtos** usam `contain`: a foto cabe inteira no quadro e a sobra vira fundo branco. Nunca corta o produto.
- **Campanhas** usam `cover`: a arte preenche o quadro e as bordas são cortadas. É o comportamento certo para peça gráfica, que já vem composta.

Isso vale por pasta e está em `ajustePorPasta`, no `midia.config.json`.

## Duas regras que evitam dor de cabeça

**Não substitua um arquivo pelo mesmo nome.** O CDN guarda a versão antiga por até 12 horas, então a troca não aparece na hora. Suba como versão nova — `frente-v2.jpg` — e use o link novo. Caminho novo, link novo, sem cache velho.

**Tudo aqui é público.** Qualquer pessoa com o link vê a imagem, e o histórico do git preserva o que já foi enviado mesmo depois de apagado. Para criativo de campanha isso é irrelevante, já que vai virar anúncio. Não use para material não lançado.

## Qual das duas URLs usar

O `indice.csv` traz duas para cada imagem:

- **`url_cdn`** (jsDelivr) — é a que você usa. CDN global, rápida, sem limite prático de tráfego.
- **`url_raw`** (raw.githubusercontent) — reflete a mudança na hora, mas tem limite de requisições e não é CDN. Serve para conferir se acabou de subir algo.

## Rodar o build localmente (opcional)

Só é necessário se você quiser gerar os recortes sem passar pelo GitHub. O Action já faz isso sozinho.

```bash
npm install
npm run build
```

Requer Node 20 ou superior.

## Estrutura

```
originais/          o que você sobe
  produtos/<SKU>/
  campanhas/<campanha>/
cdn/                gerado pelo robô — não edite à mão
indice.csv          gerado
index.html          gerado
midia.config.json   formatos, qualidade, recorte por pasta
```
