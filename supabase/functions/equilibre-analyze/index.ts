// Fonction serveur d'Équilibre : estime les calories et nutriments d'un plat
// à partir d'une photo (et d'une description facultative), avec l'API Claude.
// La clé ANTHROPIC_API_KEY reste dans les secrets Supabase, jamais dans l'app.

import Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
import { createClient } from "npm:@supabase/supabase-js@2";

// Modèle modifiable sans redéploiement : secret EQUILIBRE_MODEL.
const MODEL = Deno.env.get("EQUILIBRE_MODEL") || "claude-opus-5-5";

// Garde-fous contre une dépense incontrôlée (sur 24 heures glissantes).
const DAILY_LIMIT_PER_USER = 20;
const DAILY_LIMIT_TOTAL = 60;

const MAX_IMAGE_BASE64 = 6_000_000; // ≈ 4,5 Mo d'image
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Tarifs en dollars par million de tokens (entrée, sortie), pour le coût estimé.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `Tu estimes la valeur nutritionnelle d'un repas à partir d'une photo, pour une application personnelle de suivi calorique. L'utilisateur vérifie et corrige ton estimation avant de l'enregistrer : vise la valeur la plus probable, sans la minorer ni la majorer par prudence.

Méthode :
- Identifie chaque composant du plat et estime son poids tel que servi, en t'aidant des repères visibles (taille de l'assiette, couverts, verre, main, emballage).
- Compte les matières grasses de cuisson et les sauces quand elles sont probables, même si elles se voient peu.
- Si une description accompagne la photo, elle fait foi pour les ingrédients, les quantités et le mode de cuisson : utilise-la en priorité et complète avec la photo.
- Pour chaque composant, donne le poids en grammes, les calories, les protéines, les glucides et les fibres de la portion servie (pas pour 100 g).
- Si la photo montre plusieurs portions, estime ce qui est visiblement destiné à une personne, sauf indication contraire dans la description.

Réponse :
- "dish" : nom court du plat en français, comme on l'écrirait dans un journal alimentaire.
- "note" : une phrase en français sur la principale source d'incertitude de cette estimation (portion, matières grasses, ingrédient non visible…).
- "confidence" : "high" si les ingrédients et les quantités sont clairs ou décrits, "medium" si la portion est estimée à l'œil, "low" si le plat est difficile à identifier.
- Si l'image ne montre aucun aliment ni boisson, mets "is_food" à false, laisse "items" vide et explique-le dans "note".`;

const SCHEMA = {
  type: "object",
  properties: {
    is_food: { type: "boolean" },
    dish: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          grams: { type: "number" },
          kcal: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fiber_g: { type: "number" },
        },
        required: ["name", "grams", "kcal", "protein_g", "carbs_g", "fiber_g"],
        additionalProperties: false,
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    note: { type: "string" },
  },
  required: ["is_food", "dish", "items", "confidence", "note"],
  additionalProperties: false,
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
  if (!apiKey) return json({ error: "La clé de l'IA n'est pas configurée sur le serveur." }, 500);
  // Le secret doit contenir la clé seule, pas une commande ou un texte autour.
  if (!/^sk-ant-[A-Za-z0-9_-]+$/.test(apiKey)) {
    return json({ error: "Le secret ANTHROPIC_API_KEY de Supabase n'a pas le bon format : il doit contenir uniquement la clé (sk-ant-…)." }, 500);
  }

  // Utilisateur connecté (le jeton est vérifié auprès de Supabase).
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth?.user) return json({ error: "Connecte-toi pour utiliser l'analyse photo." }, 401);
  const userId = auth.user.id;

  let body: { image?: unknown; media_type?: unknown; description?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Requête invalide." }, 400);
  }
  const image = typeof body.image === "string" ? body.image : "";
  const mediaType = typeof body.media_type === "string" ? body.media_type : "";
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 600) : "";
  if (!image || !MEDIA_TYPES.includes(mediaType)) return json({ error: "Photo manquante ou format non pris en charge." }, 400);
  if (image.length > MAX_IMAGE_BASE64) return json({ error: "Photo trop lourde." }, 413);

  // Plafonds quotidiens.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [mine, all] = await Promise.all([
    admin.from("equilibre_ai_usage").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since),
    admin.from("equilibre_ai_usage").select("id", { count: "exact", head: true }).gte("created_at", since),
  ]);
  if (mine.error || all.error) {
    console.error("usage count failed", mine.error || all.error);
    return json({ error: "Le suivi des analyses est indisponible. Réessaie plus tard." }, 500);
  }
  if ((mine.count ?? 0) >= DAILY_LIMIT_PER_USER || (all.count ?? 0) >= DAILY_LIMIT_TOTAL) {
    return json({ error: `Limite de ${DAILY_LIMIT_PER_USER} analyses par 24 heures atteinte. Réessaie demain ou saisis le plat à la main.` }, 429);
  }

  const client = new Anthropic({ apiKey });
  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Si le modèle décline la demande, l'API la relance sur un modèle de repli.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg", data: image } },
            {
              type: "text",
              text: description
                ? `Description donnée par l'utilisateur : ${description}`
                : "Aucune description fournie : estime à partir de la photo seule.",
            },
          ],
        },
      ],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("anthropic auth", error.message);
      return json({ error: "La clé de l'IA est refusée. Vérifie-la dans les secrets Supabase." }, 502);
    }
    if (error instanceof Anthropic.RateLimitError) {
      return json({ error: "L'IA est très sollicitée. Réessaie dans une minute." }, 503);
    }
    if (error instanceof Anthropic.BadRequestError) {
      console.error("anthropic bad request", error.message);
      // Solde épuisé : l'API répond par une erreur de requête sur le crédit.
      const credit = error.error && typeof error.error === "object" && JSON.stringify(error.error).includes("credit");
      return json({ error: credit ? "Le crédit de l'IA est épuisé. Recharge-le dans la console Anthropic." : "L'IA n'a pas pu lire cette photo. Essaie avec une autre photo." }, 502);
    }
    if (error instanceof Anthropic.APIError) {
      console.error("anthropic api", error.status, error.message);
      return json({ error: "L'IA est indisponible pour le moment. Réessaie plus tard." }, 502);
    }
    // Ne jamais écrire la clé dans les journaux, même via un message d'erreur.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error("unexpected", message.split(apiKey).join("[clé]").slice(0, 300));
    return json({ error: "Erreur inattendue pendant l'analyse." }, 500);
  }

  // Journal d'usage (même si la réponse s'avère inutilisable : elle a été facturée).
  const usage = response.usage;
  const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? 0;
  const [pIn, pOut] = PRICES[response.model] ?? PRICES[MODEL] ?? [4, 20];
  const cost = (inputTokens * pIn + outputTokens * pOut) / 1_000_000;
  const { error: logError } = await admin
    .from("equilibre_ai_usage")
    .insert({ user_id: userId, model: response.model, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost });
  if (logError) console.error("usage insert failed", logError);

  if (response.stop_reason === "refusal") return json({ error: "L'IA a refusé d'analyser cette photo." }, 422);
  if (response.stop_reason === "max_tokens") return json({ error: "L'analyse a été interrompue. Réessaie." }, 502);

  let parsed;
  try {
    const text = response.content.find((b) => b.type === "text");
    parsed = JSON.parse(text && text.type === "text" ? text.text : "");
  } catch {
    console.error("unparseable answer", JSON.stringify(response.content).slice(0, 500));
    return json({ error: "La réponse de l'IA est illisible. Réessaie." }, 502);
  }

  const items = (Array.isArray(parsed.items) ? parsed.items : []).map((it: Record<string, unknown>) => ({
    name: String(it.name ?? ""),
    grams: Math.round(num(it.grams)),
    kcal: Math.round(num(it.kcal)),
    protein: round1(num(it.protein_g)),
    carbs: round1(num(it.carbs_g)),
    fiber: round1(num(it.fiber_g)),
  }));
  const sum = (k: "kcal" | "protein" | "carbs" | "fiber") => items.reduce((t: number, it: Record<string, number>) => t + it[k], 0);

  return json({
    is_food: Boolean(parsed.is_food) && items.length > 0,
    dish: String(parsed.dish ?? ""),
    items,
    // Totaux recalculés ici plutôt que demandés au modèle.
    total: { kcal: Math.round(sum("kcal")), protein: round1(sum("protein")), carbs: round1(sum("carbs")), fiber: round1(sum("fiber")) },
    confidence: ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "medium",
    note: String(parsed.note ?? ""),
    cost_usd: Math.round(cost * 10000) / 10000,
  });
});
