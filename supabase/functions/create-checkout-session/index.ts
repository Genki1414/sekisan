// ログイン中ユーザー向けにStripe Checkout Session(サブスク)を作成するEdge Function
// フロントは { plan: "monthly" | "annual" } をPOSTし、Authorizationヘッダに
// ログイン中ユーザーのaccess_token(anon keyではない)を付ける。
//
// 必要なSecrets（Project Settings > Edge Functions > Secrets）:
//   STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL, APP_URL, ALLOWED_ORIGINS
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は自動注入。

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_PRICE_MONTHLY = Deno.env.get("STRIPE_PRICE_MONTHLY")!;
const STRIPE_PRICE_ANNUAL = Deno.env.get("STRIPE_PRICE_ANNUAL")!;
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
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return jsonResponse({ error: "not_authenticated" }, 401, origin);
  }
  const user = userData.user;

  let plan: string | undefined;
  try {
    const body = await req.json();
    plan = body.plan;
  } catch {
    return jsonResponse({ error: "invalid_body" }, 400, origin);
  }
  if (plan !== "monthly" && plan !== "annual") {
    return jsonResponse({ error: "invalid_plan" }, 400, origin);
  }
  const price = plan === "monthly" ? STRIPE_PRICE_MONTHLY : STRIPE_PRICE_ANNUAL;

  const { data: usageRow } = await supabaseAdmin
    .from("pdf_usage")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      client_reference_id: user.id,
      customer: usageRow?.stripe_customer_id ?? undefined,
      customer_email: usageRow?.stripe_customer_id ? undefined : (user.email ?? undefined),
      metadata: { supabase_user_id: user.id, plan },
      subscription_data: { metadata: { supabase_user_id: user.id, plan } },
      success_url: `${APP_URL}?checkout=success`,
      cancel_url: `${APP_URL}?checkout=cancel`,
    });
    return jsonResponse({ url: session.url }, 200, origin);
  } catch (err) {
    console.error("checkout session creation failed", err);
    return jsonResponse({ error: "checkout_session_failed" }, 500, origin);
  }
});
