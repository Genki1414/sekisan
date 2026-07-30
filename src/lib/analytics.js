import { supabase } from "./supabaseClient";

const VISITOR_ID_KEY = "sekisan_visitor_id";

function getVisitorId() {
  let id = localStorage.getItem(VISITOR_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(VISITOR_ID_KEY, id);
  }
  return id;
}

// 個人情報を含まない匿名の訪問記録。失敗しても画面には一切影響させない。
export function recordPageView() {
  supabase
    .from("page_views")
    .insert({ visitor_id: getVisitorId() })
    .then(() => {})
    .catch(() => {});
}
