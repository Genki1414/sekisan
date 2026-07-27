import { supabase } from "./supabaseClient";

const LINE_CHANNEL_ID = import.meta.env.VITE_LINE_CHANNEL_ID;
const LINE_REDIRECT_URI = import.meta.env.VITE_LINE_REDIRECT_URI;
const LINE_LOGIN_FUNCTION_URL = import.meta.env.VITE_LINE_LOGIN_FUNCTION_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const STATE_STORAGE_KEY = "line_login_state";

// 「LINEでログイン」ボタンから呼ぶ。LINEの認可画面へリダイレクトする。
export function startLineLogin() {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_STORAGE_KEY, state);

  const url = new URL("https://access.line.me/oauth2/v2.1/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", LINE_CHANNEL_ID);
  url.searchParams.set("redirect_uri", LINE_REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "openid profile");
  window.location.href = url.toString();
}

// アプリ起動時に一度呼ぶ。LINEからのコールバック（?code=...&state=...）を検出したら
// Edge Functionでセッションを確立してSupabaseにログインする。
// コールバックでなければ何もせず false を返す。
export async function completeLineLoginIfNeeded() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");

  if (!code && !error) return false;

  // 一度きりのcode/stateなので、成否に関わらずURLからは即座に消す
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("code");
  cleanUrl.searchParams.delete("state");
  cleanUrl.searchParams.delete("error");
  window.history.replaceState({}, "", cleanUrl.toString());

  const savedState = sessionStorage.getItem(STATE_STORAGE_KEY);
  sessionStorage.removeItem(STATE_STORAGE_KEY);

  if (error) {
    throw new Error(`line_login_denied: ${error}`);
  }
  if (!state || state !== savedState) {
    throw new Error("line_login_state_mismatch");
  }

  const res = await fetch(LINE_LOGIN_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ code }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`line_login_failed: ${data.error ?? res.status}${data.detail ? " - " + data.detail : ""}`);
  }

  const { error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: data.token_hash,
    type: data.type,
  });
  if (verifyError) throw verifyError;

  return true;
}

export async function signOut() {
  await supabase.auth.signOut();
}
