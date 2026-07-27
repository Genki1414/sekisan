import { supabase } from "./supabaseClient";

// 表示用の参考値（実際の消費・リセット判定はconsume_pdf_credit()側で行う）
export async function peekPdfStatus() {
  const { data, error } = await supabase
    .from("pdf_usage")
    .select("free_period_start, free_used_this_period, plan, plan_expires_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) return { remainingFree: 3, plan: "none" };

  const isPaid =
    (data.plan === "monthly" || data.plan === "annual") &&
    data.plan_expires_at &&
    new Date(data.plan_expires_at) > new Date();
  if (isPaid) return { remainingFree: null, plan: data.plan };

  const thisMonth = new Date().toISOString().slice(0, 7);
  const usedThisMonth = data.free_period_start?.slice(0, 7) === thisMonth ? data.free_used_this_period : 0;
  return { remainingFree: Math.max(0, 3 - usedThisMonth), plan: "none" };
}

// 見積書PDF作成の直前に呼ぶ。1回消費してよいかどうかをサーバー側で判定・記録する。
export async function consumePdfCredit() {
  const { data, error } = await supabase.rpc("consume_pdf_credit");
  if (error) throw error;
  return data?.[0] ?? { allowed: false, remaining_free: 0, plan: "none" };
}
