import { supabase } from "./supabaseClient";

const ZAIMU_BRIDGE_FUNCTION_URL = import.meta.env.VITE_ZAIMU_BRIDGE_FUNCTION_URL;

// zaimu-bridge Edge Functionを呼ぶ共通処理。
// 成否をthrowではなく { ok, status, body } で返す
// （resolve/commitとも「失敗」がエラーというより「案内すべき状態」なことが多いため）。
async function callBridge(action, payload) {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("not_authenticated");

  const res = await fetch(ZAIMU_BRIDGE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// 元請・現場・資材が資材管理側とどう照合されるかのプレビュー（書き込みなし）
export async function resolveZaimuTarget({ clientName, siteName, materials }) {
  return callBridge("resolve", { clientName, siteName, materials });
}

// ユーザー確認後の実際の送信（元請・現場・資材の作成/紐付け、数量の反映）
export async function commitZaimuTarget({ clientName, siteName, materials }) {
  return callBridge("commit", { clientName, siteName, materials });
}
