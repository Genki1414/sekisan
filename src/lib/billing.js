import { supabase } from "./supabaseClient";

const CHECKOUT_FUNCTION_URL = import.meta.env.VITE_CHECKOUT_FUNCTION_URL;
const PORTAL_FUNCTION_URL = import.meta.env.VITE_PORTAL_FUNCTION_URL;

async function postWithAuth(url, body) {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("not_authenticated");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  const responseBody = await res.json();
  if (!res.ok || !responseBody.url) throw new Error(responseBody.error ?? "request_failed");
  return responseBody.url;
}

export async function startCheckout(plan) {
  const url = await postWithAuth(CHECKOUT_FUNCTION_URL, { plan });
  window.location.href = url;
}

export async function openBillingPortal() {
  const url = await postWithAuth(PORTAL_FUNCTION_URL, {});
  window.location.href = url;
}
