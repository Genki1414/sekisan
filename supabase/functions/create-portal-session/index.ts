// ログイン中ユーザー向けにStripeカスタマーポータルのセッションURLを発行するEdge Function
// ここからユーザー自身がサブスクの解約・支払い方法の変更ができる。
//
// 事前準備（Stripeダッシュボード側、1回だけ）:
//   設定 → 課金 →「カスタマーポータル」を有効化し、解約を許可する設定にしておくこと。
//   これをやっていないとAPIがエラーを返す。
//
// 必要なSecrets: STRIPE_SECRET_KEY, APP_URL, ALLOWED_ORIGINS
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は自動注入。

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const APP_URL = Deno.env.get("APP_URL")!;
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function corsHeaders(origin: string) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] ?? "");
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function jsonResponse(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// ゲートウェイ側で署名検証済みのJWTなので、ここでは中身をデコードするだけでよい
function decodeUserFromJwt(jwt: string): { id: string } | null {
  try {
    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    if (!payload.sub) return null;
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
    return { id: payload.sub };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, origin);
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const user = decodeUserFromJwt(jwt);
  if (!user) {
    return jsonResponse({ error: "not_authenticated" }, 401, origin);
  }

  const { data: usageRow, error: usageError } = await supabaseAdmin
    .from("pdf_usage")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (usageError || !usageRow?.stripe_customer_id) {
    return jsonResponse({ error: "no_stripe_customer" }, 404, origin);
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: usageRow.stripe_customer_id,
      return_url: APP_URL,
    });
    return jsonResponse({ url: session.url }, 200, origin);
  } catch (err) {
    console.error("portal session creation failed", err);
    return jsonResponse({ error: "portal_session_failed" }, 500, origin);
  }
});
