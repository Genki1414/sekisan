// 積算(このアプリ)で計算した資材数量を、AshiBase資材管理(別アプリ・別Supabaseプロジェクト)へ
// 送るためのブリッジEdge Function。
//
// フロントは { action: "resolve" | "commit", clientName, siteName, materials, decisions? } をPOSTし、
// Authorizationヘッダにログイン中ユーザーのaccess_token(anon keyではない)を付ける。
//
// 処理の流れ:
//   1) 積算側の有料プラン契約を確認(pdf_usage。無料ユーザーはこの連携を使えない)。
//   2) profiles.line_user_id(LINEログイン時にLINEが検証済みのuser id)を取得。
//   3) 資材管理側のAPI(/api/sekisan-bridge/resolve|commit)へ、共有シークレットで認証しつつ
//      lineUserIdを添えて転送する。実際の元請・現場・資材の照合/書き込みは資材管理側で行う。
//
// 必要なSecrets（Project Settings > Edge Functions > Secrets）:
//   ZAIMU_APP_URL, SEKISAN_BRIDGE_SECRET, ALLOWED_ORIGINS
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は自動注入。

import { createClient } from "npm:@supabase/supabase-js@2";

const ZAIMU_APP_URL = Deno.env.get("ZAIMU_APP_URL")!;
const SEKISAN_BRIDGE_SECRET = Deno.env.get("SEKISAN_BRIDGE_SECRET")!;
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
// (create-checkout-sessionと同じ方針)
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

function isPdfUsagePaid(row: { plan: string; plan_expires_at: string | null } | null): boolean {
  if (!row) return false;
  if (row.plan !== "monthly" && row.plan !== "annual") return false;
  return !!row.plan_expires_at && new Date(row.plan_expires_at).getTime() > Date.now();
}

const ACTION_PATH: Record<string, string> = { resolve: "resolve", commit: "commit" };

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

  let body: { action?: string; clientName?: string; siteName?: string; materials?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_body" }, 400, origin);
  }
  const action = body.action ?? "";
  const upstreamPath = ACTION_PATH[action];
  if (!upstreamPath) {
    return jsonResponse({ error: "invalid_action" }, 400, origin);
  }

  const { data: usage, error: usageErr } = await supabaseAdmin
    .from("pdf_usage")
    .select("plan, plan_expires_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (usageErr) return jsonResponse({ error: "server_error" }, 500, origin);
  if (!isPdfUsagePaid(usage)) {
    return jsonResponse({ error: "sekisan_plan_required" }, 402, origin);
  }

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from("profiles")
    .select("line_user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (profileErr) return jsonResponse({ error: "server_error" }, 500, origin);
  if (!profile?.line_user_id) {
    return jsonResponse({ error: "line_profile_missing" }, 500, origin);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${ZAIMU_APP_URL}/api/sekisan-bridge/${upstreamPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SEKISAN_BRIDGE_SECRET}`,
      },
      body: JSON.stringify({
        lineUserId: profile.line_user_id,
        clientName: body.clientName,
        siteName: body.siteName,
        materials: body.materials,
      }),
    });
  } catch (err) {
    console.error("zaimu-bridge upstream fetch failed", err);
    return jsonResponse({ error: "zaimu_unreachable" }, 502, origin);
  }

  const upstreamBody = await upstreamRes.json().catch(() => ({ error: "zaimu_invalid_response" }));
  return jsonResponse(upstreamBody, upstreamRes.status, origin);
});
