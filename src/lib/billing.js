import { supabase } from "./supabaseClient";

const CHECKOUT_FUNCTION_URL = import.meta.env.VITE_CHECKOUT_FUNCTION_URL;

export async function startCheckout(plan) {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("not_authenticated");

  const res = await fetch(CHECKOUT_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ plan }),
  });

  const body = await res.json();
  if (!res.ok || !body.url) throw new Error(body.error ?? "checkout_failed");

  window.location.href = body.url;
}
