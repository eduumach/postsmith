#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { brandSchema, listBrandImages, listBrands, loadBrand, saveBrand } from "./brands.ts";
import { download, extensionFor, generateImages, imageRef, request, saveMedia } from "./openrouter.ts";
import { buildBrief, closeBrowser, FORMATS, GOALS, renderPost, type Format, type Goal } from "./posts.ts";

const FORMAT_IDS = Object.keys(FORMATS) as [Format, ...Format[]];
const GOAL_IDS = Object.keys(GOALS) as [Goal, ...Goal[]];

const INSTRUCTIONS = `postsmith: cria posts de Instagram para várias marcas e gera mídia via OpenRouter.

MARCAS: cada marca é uma pasta brands/<id>/ com brand.json (paleta, fontes, voz, CTA), assets/ (mascote, logo, PNG transparente)
e referencias/ (posts bons, régua de qualidade). Use list_brands; se o usuário não disser a marca e houver mais de uma, pergunte.
Marca nova: save_brand com os dados. Se o usuário tiver um mascote/logo com fundo, use asset_variation com
prompt "exatamente como na referência" e a imagem dele como reference para obter o PNG transparente em assets/.

FLUXO PARA CRIAR UM POST:
1. Entenda o tema. Se envolver dados/notícia, pesquise e anote fonte + data. Nunca invente números.
2. post_brief(brand, topic, goal, slides). Sem objetivo informado, escolha em goal.choose_from o que mais converte para o tema.
3. Escolha UMA das creative_options como ideia central e use o color_scheme e o type_treatment sorteados. Não repita
   avoid_repeating; cada post deve parecer desenhado do zero. Olhe as references para calibrar a qualidade.
4. Escreva cada slide em HTML+CSS seguindo html_contract e rules. Gráficos em SVG com os dados reais.
5. Escreva a legenda seguindo caption_rules.
6. render_post(brand, slug, format, slides, css, caption, directions, notes, post_at). Se o usuário disser quando vai postar,
   passe post_at (ex.: 2026-10-30:21). OLHE as imagens: texto cortado, sobreposição,
   contraste ruim, vazio sem intenção ou layout genérico -> corrija e chame de novo com o mesmo slug.
7. Entregue a pasta (PNGs na ordem + legenda.txt) e a legenda no chat.

Nunca use generate_image para montar o post. Mídia avulsa: generate_image, generate_video/get_video. Outros LLMs: chat.`;

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// Larger previews are skipped so the client context isn't flooded.
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;

const text = (value: unknown): ToolContent => ({
  type: "text",
  text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
});

const preview = (bytes: Uint8Array, mime: string): ToolContent[] =>
  mime.startsWith("image/") && mime !== "image/svg+xml" && bytes.length <= MAX_INLINE_IMAGE_BYTES
    ? [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime }]
    : [];

async function guarded(fn: () => Promise<ToolContent[]>) {
  try {
    return { content: await fn() };
  } catch (err) {
    return { content: [text(err instanceof Error ? err.message : String(err))], isError: true };
  }
}

const brandParam = z.string().optional().describe("Brand id (folder in brands/). Optional when there is only one brand");

const server = new McpServer({ name: "postsmith", version: "0.3.0" }, { instructions: INSTRUCTIONS });

server.registerPrompt(
  "criar_post",
  {
    description: "Cria um post de Instagram do zero (imagens + legenda) para uma marca.",
    argsSchema: {
      marca: z.string().optional().describe("Id da marca"),
      tema: z.string().describe("Sobre o que é o post, com dados/links se houver"),
      objetivo: z.string().optional().describe(`Um de: ${GOAL_IDS.join(", ")}. Vazio = escolher o que mais converte`),
    },
  },
  ({ marca, tema, objetivo }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `${INSTRUCTIONS}\n\nTAREFA: crie o post${marca ? ` da marca ${marca}` : ""} sobre: ${tema}\nObjetivo: ${objetivo || "escolha o que mais converte e explique em 1 frase"}`,
        },
      },
    ],
  }),
);

// ---------- Brands ----------

server.registerTool(
  "list_brands",
  { description: "List the brands available for posts, with their name, handle and assets.", inputSchema: {} },
  () =>
    guarded(async () => {
      const brands = await Promise.all(
        (await listBrands()).map(async (id) => {
          const brand = await loadBrand(id);
          return { id, name: brand.name, handle: brand.handle, assets: await listBrandImages(brand, "assets") };
        }),
      );
      return [text(brands)];
    }),
);

server.registerTool(
  "save_brand",
  {
    description: "Create a brand or replace its brand.json. Creates brands/<id>/ with assets/ and referencias/ folders.",
    inputSchema: { id: z.string().describe("kebab-case folder name"), brand: brandSchema },
  },
  ({ id, brand }) => guarded(async () => [text({ saved: await saveBrand(id, brand) })]),
);

server.registerTool(
  "asset_variation",
  {
    description:
      "Create a new version of a brand asset (mascot pose/expression, or a clean transparent copy of an image with background) with an image model, using a reference image. Saves a transparent PNG to brands/<id>/assets/.",
    inputSchema: {
      brand: brandParam,
      name: z.string().describe("kebab-case file name, e.g. mascote-cafe"),
      prompt: z.string().describe("What changes, e.g. 'segurando uma xícara de café, sorrindo' or 'exatamente como na referência'"),
      reference: z.string().optional().describe("Path relative to the brand folder, absolute path or URL. Default: first file in assets/"),
      model: z.string().default("openai/gpt-image-2.5-flare").describe("Must support input_references and transparent background"),
    },
  },
  ({ brand: brandId, name, prompt, reference, model }) =>
    guarded(async () => {
      const brand = await loadBrand(brandId);
      const ref = reference ?? (await listBrandImages(brand, "assets"))[0];
      if (!ref) throw new Error("No reference: pass one or add an image to the brand's assets/");
      const source = /^(https?:|data:|\/|~)/.test(ref) ? ref : join(brand.dir, ref);
      const { images, usage } = await generateImages({
        model,
        prompt:
          `The exact same character/object as the reference image (same shape, colors, face, details, material and lighting), ${prompt}. ` +
          "Single subject, whole subject visible, centered, fully transparent background, no ground shadow, no text.",
        input_references: [await imageRef(source)],
        background: "transparent",
        output_format: "png",
        aspect_ratio: "1:1",
      });
      const image = images[0]!;
      const file = join(brand.dir, "assets", `${name.replace(/[^a-z0-9-]+/gi, "-")}.png`);
      await writeFile(file, image.bytes);
      return [text({ file, use_as: `assets/${file.split("/").pop()}`, usage }), ...preview(image.bytes, image.mime)];
    }),
);

// ---------- Posts ----------

server.registerTool(
  "post_brief",
  {
    description:
      "Start an Instagram post (single, carousel, stories or reels cover) for a brand: returns the brand kit, assets, reference posts, which format converts best per goal, caption rules, randomly drawn creative directions (avoiding recent ones) and the HTML contract for render_post. Call before writing any slide.",
    inputSchema: {
      brand: brandParam,
      topic: z.string().describe("What the post is about, including key facts/numbers and sources"),
      goal: z.enum(GOAL_IDS).optional().describe("Omit to get every goal and choose"),
      format: z.enum(FORMAT_IDS).optional(),
      slides: z.number().int().min(1).max(10).default(1),
    },
  },
  (input) => guarded(async () => [text(await buildBrief(input))]),
);

server.registerTool(
  "render_post",
  {
    description:
      "Render slides written as HTML into PNGs with headless Chrome and save the caption as legenda.txt in the same folder. Returns paths and previews to review. Re-call with the same slug to overwrite after fixes.",
    inputSchema: {
      brand: brandParam,
      slug: z.string().describe("Short kebab-case name for the post folder"),
      format: z.enum(FORMAT_IDS).default("feed").describe("feed 1080x1350, square 1080x1080, story / reel-cover 1080x1920"),
      slides: z.array(z.string()).min(1).max(10).describe("One HTML string per slide: the inner content of <body>"),
      css: z.string().optional().describe("CSS shared by all slides"),
      caption: z.string().optional().describe("Ready-to-paste Instagram caption, hashtags included"),
      directions: z.array(z.string()).optional().describe("creative_options ids used, for the anti-repetition history"),
      notes: z.string().optional().describe("One sentence describing the layout, for the history"),
      post_at: z
        .string()
        .optional()
        .describe(
          "When the post will be published, e.g. 2026-10-30:21 or 2026-10-30T21:30. Sets the folder date and prefixes files (2026-10-30_21h_slide-01.png). Omit to use today's date and no prefix",
        ),
    },
  },
  (input) =>
    guarded(async () => {
      const result = await renderPost(input);
      const previews = await Promise.all(result.files.map(async (f) => preview(await readFile(f), "image/png")));
      return [text(result), ...previews.flat()];
    }),
);

// ---------- Media ----------

server.registerTool(
  "generate_image",
  {
    description: "Generate images (text-to-image or image-to-image) via OpenRouter. Saves to outputs/media and returns paths plus previews.",
    inputSchema: {
      model: z.string().describe("Image model slug; see list_models kind=image"),
      prompt: z.string(),
      aspect_ratio: z.string().optional().describe("e.g. 1:1, 16:9, 9:16, 4:3, 21:9, auto"),
      resolution: z.enum(["512", "768", "1K", "1.5K", "2K", "4K"]).optional(),
      n: z.number().int().min(1).max(10).optional(),
      quality: z.enum(["auto", "low", "medium", "high"]).optional(),
      output_format: z.enum(["png", "jpeg", "webp", "svg"]).optional(),
      background: z.enum(["auto", "transparent", "opaque"]).optional(),
      seed: z.number().int().optional(),
      input_images: z.array(z.string()).optional().describe("Reference images: local paths, http(s) URLs or data URLs"),
    },
  },
  ({ input_images, ...params }) =>
    guarded(async () => {
      const body: Record<string, unknown> = { ...params };
      if (input_images?.length) body.input_references = await Promise.all(input_images.map(imageRef));
      const { images, usage } = await generateImages(body);
      const files = await Promise.all(
        images.map((img) => saveMedia("image", extensionFor(img.mime, params.output_format ?? "png"), img.bytes)),
      );
      return [text({ files, usage }), ...images.flatMap((img) => preview(img.bytes, img.mime))];
    }),
);

type VideoJob = { id: string; status: string; unsigned_urls?: string[]; usage?: unknown; error?: unknown };

async function pollVideo(id: string, waitSeconds: number): Promise<VideoJob> {
  const deadline = Date.now() + waitSeconds * 1000;
  let job = await request<VideoJob>(`/videos/${id}`);
  while (job.status !== "completed" && job.status !== "failed" && Date.now() < deadline) {
    await Bun.sleep(Math.min(10_000, deadline - Date.now()));
    job = await request<VideoJob>(`/videos/${id}`);
  }
  return job;
}

async function reportVideo(job: VideoJob): Promise<ToolContent[]> {
  if (job.status === "failed") return [text({ id: job.id, status: job.status, error: job.error })];
  if (job.status !== "completed") {
    return [text({ id: job.id, status: job.status, hint: "Still running. Call get_video with this id to check again." })];
  }
  const files: string[] = [];
  for (let index = 0; index < Math.max(job.unsigned_urls?.length ?? 0, 1); index++) {
    const { bytes, mime } = await download(`/videos/${job.id}/content?index=${index}`);
    files.push(await saveMedia("video", extensionFor(mime, "mp4"), bytes));
  }
  return [text({ id: job.id, status: job.status, files, usage: job.usage })];
}

const waitParam = z.number().int().min(0).max(600).default(0).describe("Seconds to keep polling; 0 returns immediately");

server.registerTool(
  "generate_video",
  {
    description:
      "Submit a video job (text-to-video, image-to-video, reference-to-video). With wait_seconds it waits and downloads the result to outputs/media; otherwise returns a job id for get_video.",
    inputSchema: {
      model: z.string().describe("Video model slug; see list_models kind=video"),
      prompt: z.string(),
      duration: z.number().optional().describe("Seconds; must be one of the model's supported_durations"),
      resolution: z.enum(["480p", "720p", "768p", "1080p", "1K", "2K", "4K"]).optional(),
      aspect_ratio: z.string().optional(),
      first_frame: z.string().optional().describe("Local path or URL of the first frame (image-to-video)"),
      last_frame: z.string().optional().describe("Local path or URL of the last frame"),
      reference_images: z.array(z.string()).optional().describe("Style/content references (local paths or URLs)"),
      generate_audio: z.boolean().optional(),
      seed: z.number().int().optional(),
      wait_seconds: waitParam,
    },
  },
  ({ first_frame, last_frame, reference_images, wait_seconds, ...params }) =>
    guarded(async () => {
      const body: Record<string, unknown> = { ...params };
      const frames = [
        ...(first_frame ? [{ src: first_frame, frame_type: "first_frame" }] : []),
        ...(last_frame ? [{ src: last_frame, frame_type: "last_frame" }] : []),
      ];
      if (frames.length) {
        body.frame_images = await Promise.all(frames.map(async ({ src, frame_type }) => ({ ...(await imageRef(src)), frame_type })));
      }
      if (reference_images?.length) body.input_references = await Promise.all(reference_images.map(imageRef));
      const job = await request<VideoJob>("/videos", body);
      return reportVideo(wait_seconds ? await pollVideo(job.id, wait_seconds) : job);
    }),
);

server.registerTool(
  "get_video",
  {
    description: "Check a video job; downloads the output to outputs/media when completed.",
    inputSchema: { id: z.string(), wait_seconds: waitParam },
  },
  ({ id, wait_seconds }) => guarded(async () => reportVideo(await pollVideo(id, wait_seconds))),
);

// ---------- OpenRouter misc ----------

server.registerTool(
  "chat",
  {
    description: "Send a prompt to any OpenRouter chat model, optionally with images for vision models.",
    inputSchema: {
      model: z.string().describe("e.g. openai/gpt-5, google/gemini-2.5-pro"),
      prompt: z.string(),
      system: z.string().optional(),
      images: z.array(z.string()).optional().describe("Local paths or URLs"),
      temperature: z.number().min(0).max(2).optional(),
      max_tokens: z.number().int().positive().optional(),
    },
  },
  ({ model, prompt, system, images, temperature, max_tokens }) =>
    guarded(async () => {
      const content = images?.length ? [{ type: "text", text: prompt }, ...(await Promise.all(images.map(imageRef)))] : prompt;
      const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content }];
      const res = await request<{ choices: Array<{ message: { content: string | null } }>; usage?: unknown }>(
        "/chat/completions",
        { model, messages, temperature, max_tokens },
      );
      return [text(res.choices[0]?.message.content ?? ""), text({ usage: res.usage })];
    }),
);

server.registerTool(
  "list_models",
  {
    description: "List OpenRouter models. kind=image or video includes each model's supported parameters.",
    inputSchema: {
      kind: z.enum(["image", "video", "text"]).default("image"),
      search: z.string().optional().describe("Case-insensitive filter on model id/name"),
      limit: z.number().int().min(1).max(200).default(50),
    },
  },
  ({ kind, search, limit }) =>
    guarded(async () => {
      const path = { image: "/images/models", video: "/videos/models", text: "/models" }[kind];
      const { data } = await request<{ data: Array<Record<string, unknown>> }>(path);
      const needle = search?.toLowerCase();
      const models = data
        .filter((m) => !needle || `${m.id} ${m.name}`.toLowerCase().includes(needle))
        .map((m) => (kind === "text" ? { id: m.id, name: m.name, context_length: m.context_length, pricing: m.pricing } : m));
      return [text({ total: models.length, models: models.slice(0, limit) })];
    }),
);

server.registerTool(
  "get_credits",
  { description: "Show OpenRouter credits and usage.", inputSchema: {} },
  () => guarded(async () => [text(await request("/credits"))]),
);

// Chrome keeps the event loop alive, so exit explicitly when the client disconnects.
const shutdown = () => closeBrowser().finally(() => process.exit(0));
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await server.connect(new StdioServerTransport());
