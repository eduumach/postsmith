import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const BASE_URL = "https://openrouter.ai/api/v1";

export const OUTPUT_DIR = resolve(process.env.POSTSMITH_OUTPUT_DIR ?? join(import.meta.dir, "..", "outputs"));

function authHeader(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  return { Authorization: `Bearer ${key}` };
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...authHeader(), "Content-Type": "application/json", "X-Title": "postsmith", ...init.headers },
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status} on ${path}: ${(await res.text()).slice(0, 2000)}`);
  return res;
}

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await call(path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  return (await res.json()) as T;
}

export async function download(path: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await call(path);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "" };
}

export type GeneratedImage = { bytes: Uint8Array; mime: string };

/** POST /images and normalize the result to bytes, whether the provider returned base64 or URLs. */
export async function generateImages(body: Record<string, unknown>): Promise<{ images: GeneratedImage[]; usage: unknown }> {
  const res = await request<{ data?: Array<{ b64_json?: string; url?: string; media_type?: string }>; usage?: unknown }>(
    "/images",
    body,
  );
  const images: GeneratedImage[] = [];
  for (const item of res.data ?? []) {
    if (item.b64_json) {
      images.push({ bytes: Buffer.from(item.b64_json, "base64"), mime: item.media_type ?? "image/png" });
    } else if (item.url) {
      const r = await fetch(item.url);
      images.push({ bytes: new Uint8Array(await r.arrayBuffer()), mime: item.media_type ?? r.headers.get("content-type") ?? "image/png" });
    }
  }
  if (!images.length) throw new Error(`No images returned: ${JSON.stringify(res).slice(0, 2000)}`);
  return { images, usage: res.usage };
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export function extensionFor(mime: string, fallback: string): string {
  return EXT_BY_MIME[mime.split(";")[0]!.trim()] ?? fallback;
}

/** Accepts an http(s) URL, a data URL or a local file path; returns something OpenRouter accepts as an image. */
export async function toImageUrl(source: string): Promise<string> {
  if (/^(https?:|data:)/.test(source)) return source;
  const path = resolve(source.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  const mime = MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mime) throw new Error(`Unsupported image extension: ${path}`);
  return `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
}

export const imageRef = async (source: string) => ({ type: "image_url", image_url: { url: await toImageUrl(source) } });

export async function saveMedia(prefix: string, ext: string, bytes: Uint8Array): Promise<string> {
  const dir = join(OUTPUT_DIR, "media");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
  await writeFile(path, bytes);
  return path;
}
