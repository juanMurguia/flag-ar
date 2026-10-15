import "server-only";
import sharp from "sharp";

// Automatic NSFW check on uploaded logos. nsfwjs (MobileNetV2, model bundled in the package)
// on the pure-JS TensorFlow backend: about 1 s per image on a serverless CPU, no native build.
// It runs after the upload response (next/server `after`), so the founder never waits for it.

type Model = { classify(img: unknown, topk?: number): Promise<{ className: string; probability: number }[]> };
let model: Promise<Model> | null = null;

// Import only the MobileNetV2 model. The "nsfwjs" entry point pulls in all three models (38 MB),
// and every function that imports this file ships them.
async function load(): Promise<Model> {
  const [{ load }, { MobileNetV2Model }] = await Promise.all([
    import("nsfwjs/core"),
    import("nsfwjs/models/mobilenet_v2"),
  ]);
  return (await load("MobileNetV2", { modelDefinitions: [MobileNetV2Model] })) as unknown as Model;
}

/** Thresholds per class. A logo is a drawing, so "Hentai" needs a higher bar than "Porn". */
const LIMITS: Record<string, number> = { Porn: 0.6, Hentai: 0.75, Sexy: 0.85 };

export interface NsfwResult {
  score: number; // highest unsafe probability
  unsafe: boolean;
}

export async function checkNsfw(png: Buffer): Promise<NsfwResult> {
  model ??= load();
  const tf = await import("@tensorflow/tfjs");
  const m = await model;
  const { data, info } = await sharp(png)
    .flatten({ background: "#ffffff" })
    .resize(224, 224, { fit: "contain", background: "#ffffff" })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], "int32");
  try {
    const preds = await m.classify(img, 5);
    let score = 0, unsafe = false;
    for (const p of preds) {
      const limit = LIMITS[p.className];
      if (limit === undefined) continue;
      score = Math.max(score, p.probability);
      if (p.probability >= limit) unsafe = true;
    }
    return { score, unsafe };
  } finally {
    img.dispose();
  }
}
