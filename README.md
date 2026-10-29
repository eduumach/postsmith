# postsmith

Servidor [MCP](https://modelcontextprotocol.io) que transforma o seu agente (Claude Code, opencode, Cursor...) num estúdio de posts de Instagram para várias marcas.

Cada marca tem paleta, fontes, voz, CTA e assets próprios. O agente escreve os slides em HTML+CSS, o postsmith renderiza em PNG no tamanho certo e salva junto com a legenda. Também gera imagens, vídeos e variações de mascote via [OpenRouter](https://openrouter.ai).

## Como funciona

1. **`post_brief`** monta um briefing para o tema: objetivo (salvar, alcance, conversão...), ideias criativas, esquema de cores e tipografia sorteados, regras de layout e de legenda, e os posts recentes da marca para não repetir.
2. O agente escreve cada slide em HTML+CSS (gráficos em SVG com dados reais) e a legenda.
3. **`render_post`** renderiza os slides com Chrome (Playwright), devolve as imagens para o agente revisar e salva tudo em `outputs/<marca>/posts/<data>-<slug>/`.

## Ferramentas

| Ferramenta | O que faz |
| --- | --- |
| `list_brands` / `save_brand` | Lista e cria/atualiza marcas |
| `asset_variation` | Gera uma nova pose do mascote ou uma cópia com fundo transparente a partir de uma referência |
| `post_brief` | Briefing criativo para um post |
| `render_post` | Renderiza os slides em PNG e salva a legenda |
| `generate_image` | Imagem avulsa (texto→imagem ou imagem→imagem) |
| `generate_video` / `get_video` | Vídeo avulso (texto, imagem ou referência→vídeo) |
| `chat` | Prompt para qualquer modelo de chat do OpenRouter |
| `list_models` / `get_credits` | Modelos disponíveis e saldo no OpenRouter |

Formatos: `feed` (1080×1350), `square` (1080×1080) e `story` (1080×1920).

## Requisitos

- [Bun](https://bun.sh)
- Google Chrome instalado (ou o caminho de outro Chromium em `POSTSMITH_CHROME_PATH`)
- Uma chave do [OpenRouter](https://openrouter.ai/keys), necessária só para gerar mídia e usar `chat`

## Instalação

```sh
git clone https://github.com/<você>/postsmith.git
cd postsmith
bun install
export OPENROUTER_API_KEY=sk-or-...
```

O repositório já traz `.mcp.json` (Claude Code) e `opencode.json` (opencode). É só abrir o agente dentro da pasta. Em outro cliente MCP:

```json
{
  "mcpServers": {
    "postsmith": {
      "command": "bun",
      "args": ["/caminho/para/postsmith/src/index.ts"],
      "env": { "OPENROUTER_API_KEY": "sk-or-..." }
    }
  }
}
```

Depois é só pedir: *"cria um carrossel da marca exemplo sobre os métodos de preparo de café"*.

## Marcas

Cada marca é uma pasta em `brands/<id>/`:

```
brands/exemplo/
├── brand.json     # nome, @, público, paleta, fontes, voz, regras, CTA, hashtags, fatos verificados
├── assets/        # logo, mascote e outros PNGs transparentes que os slides podem usar
└── referencias/   # posts que a marca considera bons, usados como régua de qualidade
```

Veja [`brands/exemplo/brand.json`](brands/exemplo/brand.json). Também dá para criar uma marca pedindo ao agente, que usa `save_brand`. As marcas ficam fora do git (só a de exemplo é versionada).

## Variáveis de ambiente

| Variável | Padrão | Uso |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | | Chave do OpenRouter |
| `POSTSMITH_BRANDS_DIR` | `./brands` | Pasta das marcas |
| `POSTSMITH_OUTPUT_DIR` | `./outputs` | Onde salvar posts e mídia |
| `POSTSMITH_BRAND` | | Marca padrão quando há mais de uma |
| `POSTSMITH_CHROME_PATH` | Chrome do sistema | Executável do navegador para renderizar |

## Desenvolvimento

```sh
bun start          # roda o servidor via stdio
bun run typecheck
```
