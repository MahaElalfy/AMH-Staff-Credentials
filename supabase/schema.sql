-- AMH Staff Credentials Portal: database, storage and access rules.
-- Run once in Supabase: SQL Editor -> New query -> paste this file -> Run.
-- Safe to re-run: tables use IF NOT EXISTS and policies are dropped first.

-- ---------------------------------------------------------------
-- Who may use the portal and who is the administrator
-- ---------------------------------------------------------------
create table if not exists public.admins (email text primary key);
create table if not exists public.allowed_domains (domain text primary key);

-- The only administrator. Change or add rows to grant admin access.
insert into public.admins (email) values ('malelfy@kfshrc.edu.sa') on conflict do nothing;
-- Staff must sign in with an email on one of these domains.
insert into public.allowed_domains (domain) values ('kfshrc.edu.sa') on conflict do nothing;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

create or replace function public.email_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowed_domains
                 where domain = lower(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 2)));
$$;

alter table public.admins enable row level security;
alter table public.allowed_domains enable row level security;
drop policy if exists "admins visible to admin" on public.admins;
create policy "admins visible to admin" on public.admins for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------
-- Requirements matrix (one JSON document)
-- ---------------------------------------------------------------
create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
drop policy if exists "settings read" on public.settings;
drop policy if exists "settings write" on public.settings;
create policy "settings read" on public.settings for select to authenticated using (public.email_allowed() or public.is_admin());
create policy "settings write" on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------
-- Staff profiles: each person writes only their own
-- ---------------------------------------------------------------
create table if not exists public.staff_profiles (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  email text not null,
  full_name text not null,
  employee_id text not null unique,
  dept text not null,
  position text not null,
  mobile text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.staff_profiles enable row level security;
drop policy if exists "profile read" on public.staff_profiles;
drop policy if exists "profile insert" on public.staff_profiles;
drop policy if exists "profile update" on public.staff_profiles;
drop policy if exists "profile delete" on public.staff_profiles;
create policy "profile read" on public.staff_profiles for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "profile insert" on public.staff_profiles for insert to authenticated
  with check (user_id = auth.uid() and public.email_allowed() and lower(email) = lower(auth.jwt() ->> 'email'));
create policy "profile update" on public.staff_profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and lower(email) = lower(auth.jwt() ->> 'email'));
create policy "profile delete" on public.staff_profiles for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------
-- Credential submissions: every upload is kept; staff cannot edit or approve them
-- ---------------------------------------------------------------
create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.staff_profiles(user_id) on delete cascade,
  cred_id text not null,
  number text,
  classification text,
  specialty text,
  issue_date date,
  expiry_date date,
  file_path text not null,
  file_name text,
  file_type text,
  file_size integer,
  uploaded_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  review_note text,
  reviewed_at timestamptz,
  reviewed_by text
);
create index if not exists submissions_user_cred on public.submissions (user_id, cred_id, uploaded_at desc);
alter table public.submissions enable row level security;
drop policy if exists "submission read" on public.submissions;
drop policy if exists "submission insert" on public.submissions;
drop policy if exists "submission review" on public.submissions;
create policy "submission read" on public.submissions for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "submission insert" on public.submissions for insert to authenticated
  with check (user_id = auth.uid() and public.email_allowed() and status = 'pending'
              and reviewed_at is null and reviewed_by is null and review_note is null
              and split_part(file_path, '/', 1) = auth.uid()::text);
create policy "submission review" on public.submissions for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Latest submission per person and credential (respects the rules above)
create or replace view public.current_submissions with (security_invoker = on) as
  select distinct on (user_id, cred_id) * from public.submissions
  order by user_id, cred_id, uploaded_at desc;

-- ---------------------------------------------------------------
-- Job descriptions and signatures
-- ---------------------------------------------------------------
create table if not exists public.job_descriptions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  code text,
  dept text not null default '*',
  positions text[] not null default '{}',
  file_path text not null,
  file_name text,
  version integer not null default 1,
  archived boolean not null default false,
  history jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.job_descriptions enable row level security;
drop policy if exists "jd read" on public.job_descriptions;
drop policy if exists "jd write" on public.job_descriptions;
create policy "jd read" on public.job_descriptions for select to authenticated using (public.email_allowed() or public.is_admin());
create policy "jd write" on public.job_descriptions for all to authenticated using (public.is_admin()) with check (public.is_admin());

create table if not exists public.jd_signatures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.staff_profiles(user_id) on delete cascade,
  jd_id uuid not null references public.job_descriptions(id) on delete cascade,
  version integer not null,
  typed_name text not null,
  signature_path text not null,
  signed_at timestamptz not null default now()
);
alter table public.jd_signatures enable row level security;
drop policy if exists "signature read" on public.jd_signatures;
drop policy if exists "signature insert" on public.jd_signatures;
create policy "signature read" on public.jd_signatures for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "signature insert" on public.jd_signatures for insert to authenticated
  with check (user_id = auth.uid() and public.email_allowed() and split_part(signature_path, '/', 1) = auth.uid()::text);

-- ---------------------------------------------------------------
-- Private file storage
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('credentials', 'credentials', false, 5242880, array['application/pdf', 'image/jpeg', 'image/png']),
  ('jds', 'jds', false, 20971520, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "credentials upload own" on storage.objects;
drop policy if exists "credentials read own or admin" on storage.objects;
drop policy if exists "jds read" on storage.objects;
drop policy if exists "jds admin insert" on storage.objects;
drop policy if exists "jds admin update" on storage.objects;
drop policy if exists "jds admin delete" on storage.objects;
create policy "credentials upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'credentials' and (storage.foldername(name))[1] = auth.uid()::text and public.email_allowed());
create policy "credentials read own or admin" on storage.objects for select to authenticated
  using (bucket_id = 'credentials' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy "jds read" on storage.objects for select to authenticated
  using (bucket_id = 'jds' and (public.email_allowed() or public.is_admin()));
create policy "jds admin insert" on storage.objects for insert to authenticated with check (bucket_id = 'jds' and public.is_admin());
create policy "jds admin update" on storage.objects for update to authenticated using (bucket_id = 'jds' and public.is_admin());
create policy "jds admin delete" on storage.objects for delete to authenticated using (bucket_id = 'jds' and public.is_admin());

-- ---------------------------------------------------------------
-- Starting requirements (edit later on the Requirements tab)
-- ---------------------------------------------------------------
insert into public.settings (key, value) values ('matrix', $json$
{
  "credentials": [
    {"id": "acls", "short": "ACLS", "name": "Advanced Cardiovascular Life Support", "validityMonths": 24, "expiry": "required"},
    {"id": "bls", "short": "BLS", "name": "Basic Life Support", "validityMonths": 24, "expiry": "required"},
    {"id": "atls", "short": "ATLS", "name": "Advanced Trauma Life Support", "validityMonths": 48, "expiry": "required"},
    {"id": "pals", "short": "PALS", "name": "Pediatric Advanced Life Support", "validityMonths": 24, "expiry": "required"},
    {"id": "nrp", "short": "NRP", "name": "Neonatal Resuscitation Program", "validityMonths": 24, "expiry": "required"},
    {"id": "scfhs", "short": "SCFHS", "name": "SCFHS Registration & Professional Classification", "validityMonths": 0, "expiry": "required"},
    {"id": "dataflow", "short": "DF", "name": "DataFlow Primary Source Verification", "validityMonths": 0, "expiry": "none"},
    {"id": "cv", "short": "CV", "name": "Updated Curriculum Vitae", "validityMonths": 12, "expiry": "required"}
  ],
  "departments": [
    {"id": "em", "name": "Emergency Medicine"}, {"id": "anes", "name": "Anesthesia"},
    {"id": "icu", "name": "Intensive Care Unit"}, {"id": "nicu", "name": "Neonatal ICU"},
    {"id": "or", "name": "Operating Room & PACU"}, {"id": "ward", "name": "Inpatient Wards"},
    {"id": "opd", "name": "Outpatient Clinics"}
  ],
  "positions": ["Consultant", "Associate Consultant", "Specialist", "Resident", "Nurse Manager", "Charge Nurse", "Staff Nurse"],
  "rules": [
    {"id": "r-all", "dept": "*", "positions": [], "creds": ["scfhs", "dataflow", "cv"]},
    {"id": "r-em", "dept": "em", "positions": ["Consultant", "Associate Consultant", "Specialist", "Resident"], "creds": ["acls", "bls", "atls", "pals"]},
    {"id": "r-anes-c", "dept": "anes", "positions": ["Consultant"], "creds": ["acls", "pals"]},
    {"id": "r-anes-o", "dept": "anes", "positions": ["Associate Consultant", "Specialist", "Resident"], "creds": ["acls"]},
    {"id": "r-icu", "dept": "icu", "positions": [], "creds": ["acls"]},
    {"id": "r-nicu", "dept": "nicu", "positions": [], "creds": ["nrp"]},
    {"id": "r-nurse", "dept": "*", "positions": ["Nurse Manager", "Charge Nurse", "Staff Nurse"], "creds": ["bls"]},
    {"id": "r-em-n", "dept": "em", "positions": ["Nurse Manager", "Charge Nurse", "Staff Nurse"], "creds": ["acls", "pals"]},
    {"id": "r-or-n", "dept": "or", "positions": ["Nurse Manager", "Charge Nurse", "Staff Nurse"], "creds": ["acls"]}
  ]
}
$json$::jsonb) on conflict (key) do nothing;
