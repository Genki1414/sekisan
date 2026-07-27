// LINEログイン用 Edge Function
// フロントから { code } をPOSTで受け取り、
// 1) LINEのauthorization codeをトークンと交換
// 2) IDトークンの署名・claimsを検証
// 3) line_user_id で profiles を検索、無ければ Supabase ユーザーを新規作成
// 4) magic link の token_hash を発行してフロントへ返す（フロントは verifyOtp でセッション確立）
//
// Studio の Edge Functions 画面で新規作成し、このファイルの中身をそのまま貼り付けてデプロイしてください。
// 必要な Secrets（Project Settings > Edge Functions > Secrets）:
//   LINE_CHANNEL_ID, LINE_CHANNEL_SECRET, LINE_REDIRECT_URI, ALLOWED_ORIGINS
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は Supabase が自動で注入するので設定不要。

import { createClient } from "npm:@supabase/supabase-js@2";

const LINE_CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID")!;
const LINE_CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET")!;
const LINE_REDIRECT_URI = Deno.env.get("LINE_REDIRECT_URI")!;
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

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, origin);
  }

  let code: string | undefined;
  try {
    const body = await req.json();
    code = body.code;
  } catch {
    return jsonResponse({ error: "invalid_body" }, 400, origin);
  }
  if (!code) return jsonResponse({ error: "missing_code" }, 400, origin);

  const tokenRes = await fetch("https://api.line.me/oauth2/v2.1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: LINE_REDIRECT_URI,
      client_id: LINE_CHANNEL_ID,
      client_secret: LINE_CHANNEL_SECRET,
    }),
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error("LINE token exchange failed", tokenRes.status, errText);
    return jsonResponse({ error: "token_exchange_failed", detail: errText }, 401, origin);
  }
  const tokenData = await tokenRes.json();

  const payload = await verifyLineIdToken(tokenData.id_token);
  if (!payload) return jsonResponse({ error: "invalid_id_token" }, 401, origin);

  const lineUserId = payload.sub as string;
  const name = (payload.name as string) ?? null;
  const picture = (payload.picture as string) ?? null;

  const { data: existingProfile, error: selectError } = await supabaseAdmin
    .from("profiles")
    .select("user_id, email")
    .eq("line_user_id", lineUserId)
    .maybeSingle();
  if (selectError) return jsonResponse({ error: "profile_lookup_failed" }, 500, origin);

  let email: string;
  if (existingProfile) {
    email = existingProfile.email;
  } else {
    email = `line-${lineUserId}@line.sekisan.local`;
    const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { line_user_id: lineUserId, name, picture },
    });
    if (createError || !created?.user) {
      return jsonResponse({ error: "user_create_failed" }, 500, origin);
    }

    const { error: insertError } = await supabaseAdmin.from("profiles").insert({
      user_id: created.user.id,
      line_user_id: lineUserId,
      email,
      name,
      picture,
    });
    if (insertError) return jsonResponse({ error: "profile_insert_failed" }, 500, origin);
  }

  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !linkData?.properties?.hashed_token) {
    return jsonResponse({ error: "session_issue_failed" }, 500, origin);
  }

  return jsonResponse(
    { token_hash: linkData.properties.hashed_token, type: "magiclink" },
    200,
    origin,
  );
});

async function verifyLineIdToken(idToken: string) {
  const [headerB64, payloadB64, signatureB64] = idToken.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) return null;

  const jwksRes = await fetch("https://api.line.me/oauth2/v2.1/certs");
  if (!jwksRes.ok) return null;
  const jwks = await jwksRes.json();

  const header = JSON.parse(base64UrlDecode(headerB64));
  const jwk = jwks.keys.find((k: { kid: string }) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBytes(signatureB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  if (!valid) return null;

  const payload = JSON.parse(base64UrlDecode(payloadB64));
  if (payload.iss !== "https://access.line.me") return null;
  if (payload.aud !== LINE_CHANNEL_ID) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function base64UrlDecode(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64);
}

function base64UrlToBytes(input: string) {
  const raw = base64UrlDecode(input);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
