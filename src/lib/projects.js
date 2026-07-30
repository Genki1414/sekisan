import { supabase } from "./supabaseClient";

export async function listProjects() {
  const { data, error } = await supabase
    .from("projects")
    .select("id, client_name, site_name, input, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

export async function saveProject({ clientName, siteName, input }) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const user = userData.user;
  if (!user) throw new Error("not_authenticated");

  const { error } = await supabase.from("projects").insert({
    user_id: user.id,
    client_name: clientName || "",
    site_name: siteName || "",
    input,
  });
  if (error) throw error;
}

export async function deleteProject(id) {
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) throw error;
}
