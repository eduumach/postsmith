import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export const BRANDS_DIR = resolve(process.env.POSTSMITH_BRANDS_DIR ?? join(import.meta.dir, "..", "brands"));

const IMAGE_FILE = /\.(png|jpe?g|webp|svg)$/i;

export const brandSchema = z.object({
  name: z.string(),
  handle: z.string().describe("Instagram handle shown on every piece, e.g. @marca"),
  description: z.string().describe("What the brand/product is, in one or two sentences"),
  tagline: z.string().optional(),
  website: z.string().optional(),
  facts: z
    .array(z.string())
    .default([])
    .describe("Verified product facts posts can cite (features, how it works, FAQ). Never claim beyond them"),
  audience: z.string(),
  language: z.string().default("pt-BR"),
  palette: z
    .record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string())
    .describe("Color name -> hex. Each name becomes a CSS variable, e.g. forest -> var(--forest)"),
  fonts: z.object({
    display: z.string().describe("Google Fonts family for headlines"),
    text: z.string().describe("Google Fonts family for body text"),
    stylesheet: z.string().optional().describe("Custom font CSS URL, for fonts without a 300..900 weight axis"),
  }),
  voice: z.array(z.string()).default([]),
  rules: z.array(z.string()).default([]).describe("Brand-specific visual rules, on top of the general ones"),
  cta: z.string().describe("The one call to action posts should end with"),
  keywords: z.array(z.string()).default([]).describe("Terms the audience searches for, used in captions"),
  hashtags: z.array(z.string()).default([]),
});

export type Brand = z.infer<typeof brandSchema> & { id: string; dir: string };

export async function listBrands(): Promise<string[]> {
  const entries = await readdir(BRANDS_DIR, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** Resolves the brand id: explicit > POSTSMITH_BRAND > the only brand there is. */
export async function resolveBrandId(id?: string): Promise<string> {
  const brands = await listBrands();
  const chosen = id ?? process.env.POSTSMITH_BRAND ?? (brands.length === 1 ? brands[0] : undefined);
  if (!chosen) throw new Error(`Specify a brand. Available: ${brands.join(", ") || "none, create one with save_brand"}`);
  if (!brands.includes(chosen)) throw new Error(`Unknown brand "${chosen}". Available: ${brands.join(", ")}`);
  return chosen;
}

export async function loadBrand(id?: string): Promise<Brand> {
  const brandId = await resolveBrandId(id);
  const dir = join(BRANDS_DIR, brandId);
  const raw = JSON.parse(await readFile(join(dir, "brand.json"), "utf8"));
  return { ...brandSchema.parse(raw), id: brandId, dir };
}

export async function saveBrand(id: string, data: z.infer<typeof brandSchema>): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Brand id must be kebab-case");
  const dir = join(BRANDS_DIR, id);
  await mkdir(join(dir, "assets"), { recursive: true });
  await mkdir(join(dir, "referencias"), { recursive: true });
  const file = join(dir, "brand.json");
  await writeFile(file, JSON.stringify(brandSchema.parse(data), null, 2) + "\n");
  return file;
}

/** Image files in a brand subfolder, as paths relative to the brand dir (how slides reference them). */
export async function listBrandImages(brand: Brand, folder: "assets" | "referencias"): Promise<string[]> {
  const files = await readdir(join(brand.dir, folder)).catch(() => []);
  return files.filter((f) => IMAGE_FILE.test(f)).sort().map((f) => `${folder}/${f}`);
}
