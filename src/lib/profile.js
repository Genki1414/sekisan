import { supabase } from "./supabaseClient";

// profilesの自社情報カラム <-> アプリ内のsettings state のキー対応
const FIELD_MAP = {
  jisha: "company_name",
  jusho: "company_address",
  tel: "company_phone",
  tanto: "company_contact",
};

export async function fetchCompanySettings() {
  const { data, error } = await supabase
    .from("profiles")
    .select("company_name, company_address, company_phone, company_contact")
    .maybeSingle();
  if (error) throw error;
  if (!data) return { jisha: "", jusho: "", tel: "", tanto: "" };

  return Object.fromEntries(
    Object.entries(FIELD_MAP).map(([localKey, column]) => [localKey, data[column] ?? ""]),
  );
}

export async function saveCompanySettings(settings) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const user = userData.user;
  if (!user) throw new Error("not_authenticated");

  const patch = Object.fromEntries(
    Object.entries(FIELD_MAP).map(([localKey, column]) => [column, settings[localKey] ?? ""]),
  );

  const { error } = await supabase.from("profiles").update(patch).eq("user_id", user.id);
  if (error) throw error;
}
