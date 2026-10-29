import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { listBrandImages, loadBrand, type Brand } from "./brands.ts";
import { OUTPUT_DIR } from "./openrouter.ts";

export const FORMATS = {
  feed: { width: 1080, height: 1350, use: "Post único ou carrossel no feed (4:5 ocupa mais tela que quadrado)." },
  square: { width: 1080, height: 1080, use: "Post quadrado; só quando o conteúdo pede (ex.: série com grid uniforme)." },
  story: {
    width: 1080,
    height: 1920,
    use: "Stories. Deixe livres os 250px do topo e 340px da base (UI do Instagram e sticker de link).",
  },
  "reel-cover": {
    width: 1080,
    height: 1920,
    use: "Capa de Reels. O grid do perfil corta para o centro 1080x1350: título e personagem dentro dessa área.",
  },
} as const;

export type Format = keyof typeof FORMATS;

export const GOALS = {
  salvar_compartilhar: {
    format: "feed (carrossel 5-8 slides)",
    why: "Carrossel educativo é o formato que mais gera salvamentos e envios por DM, e o Instagram reexibe carrosséis para quem não deslizou.",
    structure:
      "Slide 1 = gancho que cria curiosidade (número, pergunta, afirmação surpreendente). Meio = 1 ideia por slide. Último = resumo + CTA ('salve para consultar' / 'envie para quem precisa').",
  },
  alcance: {
    format: "reel-cover + roteiro de Reels na legenda",
    why: "Reels é o formato que mais alcança não-seguidores.",
    structure: "Capa com promessa clara em até 6 palavras. Entregue também um roteiro curto (gancho nos 2 primeiros segundos, 3 cenas, CTA).",
  },
  conversao: {
    format: "story (sequência de 3-4) + 1 post feed com o CTA",
    why: "Stories com sticker de link são o caminho mais curto até a ação; o post no feed sustenta a prova.",
    structure: "Story 1 problema, story 2 como o produto resolve, story 3 prova/número, story 4 CTA com espaço para o sticker. Um único CTA: o da marca.",
  },
  anuncio: {
    format: "feed (post único)",
    why: "Novidade ou data cabe em uma peça; se precisa explicar, vira carrossel.",
    structure: "Uma mensagem, um elemento dominante, CTA no rodapé.",
  },
  prova_social: {
    format: "feed (post único ou carrossel curto) ou story",
    why: "Depoimento e uso real convencem mais que promessa.",
    structure: "Citação grande ou conversa desenhada; quem é o cliente; resultado concreto.",
  },
} as const;

export type Goal = keyof typeof GOALS;

const GENERAL_RULES = [
  "Use apenas as cores da paleta da marca (pode usar opacidade delas). Nada de outros matizes.",
  "Toda peça tem o handle discreto. Carrossel tem numeração (1/N).",
  "Hierarquia forte: um elemento domina cada slide; o resto é bem menor.",
  "Margens generosas (>= 80px), exceto quando um elemento sangra para fora do canvas de propósito.",
  "Gráficos e números são HTML/SVG desenhados com os dados reais, nunca imagem gerada. Nunca invente números.",
  "Não use modelo de imagem para montar o post; ele só serve para criar variações de assets (asset_variation).",
];

const CAPTION_RULES = [
  "Primeira linha = gancho (aparece antes do 'mais'; até ~125 caracteres). Não comece com o nome da marca.",
  "Corpo curto em parágrafos de 1-2 linhas, mesma voz dos slides; acrescente algo que não está na imagem.",
  "Use termos que o público pesquisaria (veja brand.keywords): a busca do Instagram lê a legenda.",
  "Um único CTA no fim, o brand.cta (ou 'salve para consultar' em conteúdo educativo).",
  "3-5 hashtags específicas no final (parta de brand.hashtags).",
  "Cite a fonte e a data dos dados quando houver número.",
];

// Composition ideas, not layouts: each brief draws a few so consecutive posts look different.
const DIRECTIONS = [
  { id: "bleed-number", idea: "Um número ou palavra gigante (500px+) que sangra para fora do canvas; o resto do texto se encaixa no espaço que sobra." },
  { id: "split-field", idea: "Canvas dividido em dois campos de cor (horizontal, vertical ou diagonal); cada metade conta um lado da história." },
  { id: "stacked-poster", idea: "Pôster tipográfico: frase empilhada em linhas de pesos/cores alternadas, preenchendo a largura toda." },
  { id: "character-peek", idea: "Personagem/asset enorme cortado pela borda, espiando o conteúdo ou reagindo a ele." },
  { id: "character-annotator", idea: "Personagem/asset pequeno como anotador: aponta para um dado, segura uma etiqueta, comenta o gráfico." },
  { id: "editorial", idea: "Layout de jornal/revista: colunas, fios finos, kicker em caixa alta, manchete pela escala." },
  { id: "timeline", idea: "Linha do tempo vertical ou horizontal com marcos; datas como o elemento de maior peso." },
  { id: "chat-thread", idea: "Conversa de mensagens desenhada em HTML (balões, horário, ticks) mostrando o produto em uso real." },
  { id: "bento", idea: "Grade bento de 3-5 blocos de tamanhos diferentes, cada um com um dado ou ícone; um bloco domina." },
  { id: "object", idea: "Peça em formato de um objeto do universo da marca: recibo, etiqueta, ingresso, ficha, caderneta, carimbo." },
  { id: "versus", idea: "Comparação antes/depois ou isso/aquilo em duas colunas, com contraste visual forte entre os lados." },
  { id: "big-quote", idea: "Citação ou pergunta enorme com aspas gráficas gigantes; quem disse em letra pequena." },
  { id: "checklist", idea: "Checklist com caixas marcadas/desmarcadas; o item que falta é o gancho." },
  { id: "data-hero", idea: "Um gráfico (barras, linha, waffle, pontos) desenhado em SVG ocupa o slide inteiro; o título fica dentro dele." },
  { id: "pattern", idea: "Padrão gráfico em SVG ligado ao tema (curvas de nível, grid, ondas, pontos) como fundo, texto limpo por cima." },
  { id: "one-word", idea: "Ritmo de carrossel: uma palavra ou frase curtíssima por slide, cores de fundo alternando a cada slide." },
  { id: "glass-card", idea: "Fundo com gradiente suave + grão, cartão de vidro (backdrop blur) com o conteúdo e um CTA." },
  { id: "stamp", idea: "Selo/carimbo rotacionado ou faixa diagonal atravessando o slide com a mensagem-chave." },
  { id: "map-pin", idea: "Mapa estilizado em SVG (país, estado, bairro, planta baixa) com pinos e rótulos." },
  { id: "question-answer", idea: "Slide-pergunta seguido de slide-resposta; a pergunta ocupa o canvas, a resposta é seca e curta." },
] as const;

const COLOR_SCHEMES = [
  "fundo na cor mais escura, texto na mais clara, uma cor de destaque",
  "fundo na cor mais clara, texto na mais escura, destaque em uma cor média",
  "fundo preto/quase preto, texto claro, destaque na cor mais viva",
  "fundo na cor mais viva da paleta, texto escuro",
  "alternar fundo escuro e claro a cada slide",
  "gradiente entre duas cores escuras da paleta com grão, texto claro",
];

const TYPE_TREATMENTS = [
  "display 900 bem apertado (letter-spacing -0.05em), linhas coladas",
  "contraste de peso: palavra-chave 900, resto 300 no mesmo tamanho",
  "texto vazado (outline) para o elemento gigante, sólido para o resto",
  "marca-texto: bloco de cor de destaque atrás das palavras-chave",
  "kicker em caixa alta espaçada + manchete em minúsculas",
  "números tabulares enormes com unidade pequena alinhada no topo",
];

type HistoryEntry = { slug: string; date: string; format: Format; directions?: string[]; notes?: string; dir: string };

const historyFile = (brand: Brand) => join(OUTPUT_DIR, brand.id, "history.json");

async function readHistory(brand: Brand): Promise<HistoryEntry[]> {
  return JSON.parse(await readFile(historyFile(brand), "utf8").catch(() => "[]"));
}

function pick<T>(items: readonly T[], n: number): T[] {
  return [...items].sort(() => Math.random() - 0.5).slice(0, n);
}

export async function buildBrief(input: { brand?: string; topic: string; slides: number; goal?: Goal; format?: Format }) {
  const brand = await loadBrand(input.brand);
  const [assets, references, history] = await Promise.all([
    listBrandImages(brand, "assets"),
    listBrandImages(brand, "referencias"),
    readHistory(brand),
  ]);
  const recent = history.slice(-6);
  const recentIds = new Set(recent.flatMap((h) => h.directions ?? []));
  const fresh = DIRECTIONS.filter((d) => !recentIds.has(d.id));
  const { dir, ...brandInfo } = brand;

  return {
    topic: input.topic,
    slides: input.slides,
    goal: input.goal ? GOALS[input.goal] : { choose_from: GOALS },
    format: input.format ?? "escolha pelo objetivo",
    formats: FORMATS,
    brand: brandInfo,
    assets,
    references: references.map((r) => join(dir, r)),
    creative_options: pick(fresh.length >= 3 ? fresh : DIRECTIONS, 3),
    color_scheme: pick(COLOR_SCHEMES, 1)[0],
    type_treatment: pick(TYPE_TREATMENTS, 1)[0],
    avoid_repeating: recent.map(({ slug, directions, notes }) => ({ slug, directions, notes })),
    rules: [...GENERAL_RULES, ...brand.rules],
    caption_rules: CAPTION_RULES,
    html_contract: [
      "Cada slide é o conteúdo do <body>; o body tem exatamente o tamanho do formato, position:relative, overflow hidden.",
      `Cores: ${Object.keys(brand.palette).map((c) => `var(--${c})`).join(" ")}.`,
      `Fontes carregadas: '${brand.fonts.display}' (títulos) e '${brand.fonts.text}' (texto, padrão do body).`,
      'Assets: <img src="assets/arquivo.png"> (caminho relativo à pasta da marca).',
      "references são posts que a marca considera bons: olhe-os como régua de qualidade, não como layout a copiar.",
    ],
  };
}

let browser: Browser | undefined;

async function getBrowser(): Promise<Browser> {
  if (!browser?.isConnected()) {
    const executablePath = process.env.POSTSMITH_CHROME_PATH;
    browser = await chromium.launch(executablePath ? { executablePath } : { channel: "chrome" });
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close().catch(() => {});
  browser = undefined;
}

function fontStylesheet(brand: Brand): string {
  if (brand.fonts.stylesheet) return brand.fonts.stylesheet;
  const families = [...new Set([brand.fonts.display, brand.fonts.text])]
    .map((f) => `family=${f.replace(/ /g, "+")}:wght@300..900`)
    .join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=block`;
}

function slideDocument(brand: Brand, format: Format, body: string, css: string): string {
  const { width, height } = FORMATS[format];
  const vars = Object.entries(brand.palette).map(([name, hex]) => `--${name}: ${hex};`).join(" ");
  return `<!doctype html>
<html lang="${brand.language}"><head><meta charset="utf-8">
<base href="${pathToFileURL(brand.dir + "/").href}">
<link rel="stylesheet" href="${fontStylesheet(brand)}">
<style>
:root { ${vars} }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
body { position: relative; font-family: "${brand.fonts.text}", sans-serif; -webkit-font-smoothing: antialiased; }
${css}
</style></head><body>${body}</body></html>`;
}

// Accepts "2026-10-30", "2026-10-30:21", "2026-10-30 21h", "2026-10-30T21:30".
// Returns the folder date and a filesystem-safe file prefix (no ':', which Finder shows as '/').
export function parsePostAt(value: string): { date: string; prefix: string } {
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T:_-]?(\d{1,2})(?:[:h]?(\d{2}))?h?)?$/i);
  if (!m) throw new Error(`Invalid post_at "${value}". Use YYYY-MM-DD, optionally with an hour: 2026-10-30:21 or 2026-10-30T21:30`);
  const [, date = "", hour, minute] = m;
  if (!hour) return { date, prefix: `${date}_` };
  if (Number(hour) > 23 || Number(minute ?? 0) > 59) throw new Error(`Invalid time in post_at "${value}"`);
  const time = `${hour.padStart(2, "0")}h${minute && minute !== "00" ? minute : ""}`;
  return { date, prefix: `${date}_${time}_` };
}

export async function renderPost(input: {
  brand?: string;
  slug: string;
  format: Format;
  slides: string[];
  css?: string;
  caption?: string;
  directions?: string[];
  notes?: string;
  post_at?: string;
}): Promise<{ dir: string; files: string[]; caption?: string }> {
  const brand = await loadBrand(input.brand);
  const { width, height } = FORMATS[input.format];
  const slug = input.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "post";
  const suffix = input.format === "feed" ? "" : `-${input.format}`;
  const { date, prefix } = input.post_at ? parsePostAt(input.post_at) : { date: new Date().toISOString().slice(0, 10), prefix: "" };
  const dir = join(OUTPUT_DIR, brand.id, "posts", `${date}-${slug}${suffix}`);
  await mkdir(join(dir, "html"), { recursive: true });

  const page = await (await getBrowser()).newPage({ viewport: { width, height } });
  const files: string[] = [];
  try {
    for (const [i, body] of input.slides.entries()) {
      const name = `slide-${String(i + 1).padStart(2, "0")}`;
      const htmlPath = join(dir, "html", `${name}.html`);
      await writeFile(htmlPath, slideDocument(brand, input.format, body, input.css ?? ""));
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
      await page.evaluate("document.fonts.ready");
      const pngPath = join(dir, `${prefix}${name}.png`);
      await page.screenshot({ path: pngPath });
      files.push(pngPath);
    }
  } finally {
    await page.close();
  }

  let captionPath: string | undefined;
  if (input.caption) {
    captionPath = join(dir, `${prefix}legenda.txt`);
    await writeFile(captionPath, input.caption.trim() + "\n");
  }

  const history = (await readHistory(brand)).filter((h) => h.dir !== dir);
  history.push({ slug, date: new Date().toISOString(), format: input.format, directions: input.directions, notes: input.notes, dir });
  await writeFile(historyFile(brand), JSON.stringify(history.slice(-50), null, 2));
  return { dir, files, caption: captionPath };
}
