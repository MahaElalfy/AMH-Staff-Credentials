// Fill these in from Supabase: Project Settings -> API.
// The anon (public) key is meant to be in the page; the access rules in supabase/schema.sql protect the data.
// Never put the service_role key here.
window.AMH_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT-REF.supabase.co",
  supabaseAnonKey: "YOUR-ANON-PUBLIC-KEY",
  // Must match public.allowed_domains in the database
  allowedDomains: ["kfshrc.edu.sa"],
  officeEmail: "malelfy@kfshrc.edu.sa"
};
