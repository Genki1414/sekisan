// Stripe Webhook受信用 Edge Function
// checkout完了・サブスク更新・解約イベントを受けて pdf_usage.plan / plan_expires_at を同期する。
//
// このFunctionはStripeから直接呼ばれ、SupabaseのJWTを持たないため、
// Studio上でこのFunctionだけ「Verify JWT」設定をOFFにしてデプロイすること。
// 認証はStripeの署名検証(STRIPE_WEBHOOK_SECRET)で行う。
//
// 必要なSecrets:
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は自動注入。
//
// Stripeダッシュボードのwebhookエンドポイント設定で、最低限以下のイベントを購読すること:
//   checkout.session.completed, customer.subscription.updated,
//   customer.subscription.deleted

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const STRIPE_PRICE_MONTHLY = Deno.env.get("STRIPE_PRICE_MONTHLY")!;
const STRIPE_PRICE_ANNUAL = Deno.env.get("STRIPE_PRICE_ANNUAL")!;

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function planFromPriceId(priceId: string | undefined) {
  if (priceId === STRIPE_PRICE_MONTHLY) return "monthly";
  if (priceId === STRIPE_PRICE_ANNUAL) return "annual";
  return null;
}

async function syncSubscription(
  subscription: Stripe.Subscription,
  fallbackUserId: string | undefined,
) {
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  let userId = subscription.metadata?.supabase_user_id || fallbackUserId;
  if (!userId) {
    const { data } = await supabaseAdmin
      .from("pdf_usage")
      .select("user_id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    userId = data?.user_id;
  }
  if (!userId) {
    console.error("stripe-webhook: no supabase user id resolved for subscription", subscription.id);
    return;
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = planFromPriceId(priceId) ?? "monthly";
  const isActive = subscription.status === "active" || subscription.status === "trialing";
  const periodEnd = new Date(subscription.current_period_end * 1000).toISOString();

  const { error } = await supabaseAdmin.from("pdf_usage").upsert(
    {
      user_id: userId,
      plan: isActive ? plan : "none",
      plan_expires_at: isActive ? periodEnd : null,
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) console.error("stripe-webhook: pdf_usage upsert failed", error);
}

async function clearSubscription(subscription: Stripe.Subscription) {
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const userId = subscription.metadata?.supabase_user_id;

  const query = supabaseAdmin
    .from("pdf_usage")
    .update({ plan: "none", plan_expires_at: null, updated_at: new Date().toISOString() });

  const { error } = userId
    ? await query.eq("user_id", userId)
    : await query.eq("stripe_customer_id", customerId);
  if (error) console.error("stripe-webhook: pdf_usage clear failed", error);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  const body = await req.text();
  if (!signature) return new Response("missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("stripe-webhook: signature verification failed", err);
    return new Response("invalid signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription" && session.subscription) {
          const subId =
            typeof session.subscription === "string" ? session.subscription : session.subscription.id;
          const subscription = await stripe.subscriptions.retrieve(subId);
          await syncSubscription(subscription, session.client_reference_id ?? undefined);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await syncSubscription(subscription, undefined);
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await clearSubscription(subscription);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("stripe-webhook: handler error", err);
    return new Response("handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
