-- AMH Staff Credentials Portal: database, storage and access rules.
-- Run once in Supabase: SQL Editor -> New query -> paste this file -> Run.
--
-- How access works:
--   * Staff do NOT sign in. Anyone with the portal link can SUBMIT (insert) documents
--     and signatures, but cannot read anything back: not their own, not anyone else's.
--   * The administrator signs in with email + password (created in the Supabase dashboard,
--     no emails are sent) and is the only one who can read, review and export.
--   * Optional staff roster: if public.roster has any rows, only listed employee IDs can submit.

-- ---------------------------------------------------------------
-- Administrator
-- ---------------------------------------------------------------
create table if not exists public.admins (email text primary key);
-- The first administrator. Add others from the portal (Users & roles tab).
insert into public.admins (email) values ('malelfy@kfshrc.edu.sa') on conflict do nothing;
alter table public.admins add column if not exists added_at timestamptz default now();
alter table public.admins add column if not exists added_by text;
alter table public.admins add column if not exists full_name text;
-- Roles: admin (full access), hr (full access + final job description sign-off),
--        head (signs job descriptions for staff in their departments),
--        director (signs job descriptions for department heads in their departments).
alter table public.admins add column if not exists role text not null default 'admin';
alter table public.admins add column if not exists depts text[] not null default '{}';

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) and role in ('admin', 'hr'));
$$;
create or replace function public.is_hr() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) and role = 'hr');
$$;
alter table public.admins enable row level security;
drop policy if exists "admins visible to admin" on public.admins;
create policy "admins visible to admin" on public.admins for select to authenticated using (public.is_admin());

-- The signed-in person's own account (role and departments), used by the portal after sign-in.
drop function if exists public.my_account();
create or replace function public.my_account() returns table (email text, full_name text, role text, depts text[])
language sql stable security definer set search_path = public as $$
  select email, full_name, role, depts from public.admins where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

-- User management from the portal (Users & roles tab). Each function checks the caller is an admin.
drop function if exists public.admin_list();
create or replace function public.admin_list()
returns table (email text, full_name text, role text, depts text[], added_at timestamptz, added_by text, has_account boolean, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
    select a.email, a.full_name, a.role, a.depts, a.added_at, a.added_by, u.id is not null, u.last_sign_in_at
    from public.admins a left join auth.users u on lower(u.email) = lower(a.email)
    order by a.added_at nulls first, a.email;
end $$;

drop function if exists public.admin_add(text);
create or replace function public.admin_add(new_email text, new_name text default null, new_role text default 'admin', new_depts text[] default '{}') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if new_email is null or new_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email'; end if;
  if new_role not in ('admin', 'hr', 'head', 'director') then raise exception 'invalid role'; end if;
  insert into public.admins (email, full_name, role, depts, added_by)
    values (lower(trim(new_email)), nullif(trim(new_name), ''), new_role, coalesce(new_depts, '{}'), auth.jwt() ->> 'email')
    on conflict (email) do update set full_name = excluded.full_name, role = excluded.role, depts = excluded.depts;
end $$;

create or replace function public.admin_update(target text, new_name text, new_role text, new_depts text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if new_role not in ('admin', 'hr', 'head', 'director') then raise exception 'invalid role'; end if;
  if lower(target) = lower(auth.jwt() ->> 'email') and new_role not in ('admin', 'hr') then raise exception 'You cannot remove your own admin access'; end if;
  update public.admins set full_name = nullif(trim(new_name), ''), role = new_role, depts = coalesce(new_depts, '{}') where lower(email) = lower(target);
end $$;

-- Removes the person's login so they can set a new password from the sign-in screen.
create or replace function public.admin_reset(target text) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if lower(target) = lower(auth.jwt() ->> 'email') then raise exception 'cannot reset yourself'; end if;
  if not exists (select 1 from public.admins where lower(email) = lower(target)) then raise exception 'not a portal user'; end if;
  delete from auth.users where lower(email) = lower(target);
end $$;

create or replace function public.admin_remove(target text) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if lower(target) = lower(auth.jwt() ->> 'email') then raise exception 'cannot remove yourself'; end if;
  delete from public.admins where lower(email) = lower(target);
  delete from auth.users where lower(email) = lower(target);
end $$;
revoke execute on function public.admin_list(), public.admin_add(text, text, text, text[]), public.admin_update(text, text, text, text[]), public.admin_reset(text), public.admin_remove(text) from public, anon;
grant execute on function public.admin_list(), public.admin_add(text, text, text, text[]), public.admin_update(text, text, text, text[]), public.admin_reset(text), public.admin_remove(text) to authenticated;

-- Only invited emails (any role) can create a login ("First time? Set your password" in the portal).
-- Their account is confirmed straight away, so no email is needed.
create or replace function public.only_invited_signups() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.admins where lower(email) = lower(new.email)) then
    raise exception 'This email has not been added to the portal';
  end if;
  new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
  return new;
end $$;
drop trigger if exists only_invited_signups on auth.users;
create trigger only_invited_signups before insert on auth.users for each row execute function public.only_invited_signups();

-- ---------------------------------------------------------------
-- Optional staff roster (import a CSV in Table Editor -> roster -> Insert -> Import data from CSV)
-- ---------------------------------------------------------------
create table if not exists public.roster (
  employee_id text primary key,
  full_name text,
  dept text,
  position text
);
alter table public.roster enable row level security;
drop policy if exists "roster admin" on public.roster;
create policy "roster admin" on public.roster for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- True when the roster is empty (no check) or the ID is on it. Callable by the public form.
create or replace function public.employee_ok(eid text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.roster)
      or exists (select 1 from public.roster where lower(employee_id) = lower(trim(eid)));
$$;
grant execute on function public.employee_ok(text) to anon, authenticated;

-- ---------------------------------------------------------------
-- Requirements matrix (one JSON document): everyone reads, admin writes
-- ---------------------------------------------------------------
create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
drop policy if exists "settings read" on public.settings;
drop policy if exists "settings write" on public.settings;
create policy "settings read" on public.settings for select to anon, authenticated using (true);
create policy "settings write" on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------
-- Credential submissions: public can insert only; admin reads and reviews
-- ---------------------------------------------------------------
create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  employee_id text not null check (length(trim(employee_id)) between 1 and 40),
  full_name text not null check (length(trim(full_name)) between 2 and 120),
  dept text not null,
  position text not null,
  mobile text,
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
-- Job title chosen on the form (code of a library job description, e.g. JD-HRM-016). Safe to re-run.
alter table public.submissions add column if not exists job_code text;
alter table public.submissions add column if not exists designation text;
alter table public.submissions add column if not exists job_code2 text;
create index if not exists submissions_emp_cred on public.submissions (employee_id, cred_id, uploaded_at desc);
alter table public.submissions enable row level security;
drop policy if exists "submission insert" on public.submissions;
drop policy if exists "submission admin read" on public.submissions;
drop policy if exists "submission review" on public.submissions;
create policy "submission insert" on public.submissions for insert to anon, authenticated
  with check (status = 'pending' and reviewed_at is null and reviewed_by is null and review_note is null
              and file_path like 'incoming/%' and public.employee_ok(employee_id));
create policy "submission admin read" on public.submissions for select to authenticated using (public.is_admin());
create policy "submission review" on public.submissions for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Latest submission per employee and credential (admin only, through the rules above)
create or replace view public.current_submissions with (security_invoker = on) as
  select distinct on (employee_id, cred_id) * from public.submissions
  order by employee_id, cred_id, uploaded_at desc;

-- ---------------------------------------------------------------
-- Job descriptions (everyone reads so staff can sign; admin writes) and signatures
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
-- Department label for library job descriptions (dept = '@title' means staff pick it by job title). Safe to re-run.
alter table public.job_descriptions add column if not exists category text;
alter table public.job_descriptions enable row level security;
drop policy if exists "jd read" on public.job_descriptions;
drop policy if exists "jd write" on public.job_descriptions;
create policy "jd read" on public.job_descriptions for select to anon, authenticated using (true);
create policy "jd write" on public.job_descriptions for all to authenticated using (public.is_admin()) with check (public.is_admin());

create table if not exists public.jd_signatures (
  id uuid primary key default gen_random_uuid(),
  employee_id text not null,
  full_name text not null,
  dept text,
  position text,
  jd_id uuid not null references public.job_descriptions(id) on delete cascade,
  version integer not null,
  typed_name text not null,
  signature_path text not null,
  signed_at timestamptz not null default now()
);
alter table public.jd_signatures add column if not exists job_code text;
alter table public.jd_signatures add column if not exists designation text;
alter table public.jd_signatures add column if not exists job_code2 text;
-- Approval chain: employee -> department head (or director, for a department head's own JDs) -> HR manager.
alter table public.jd_signatures add column if not exists mgr_email text;
alter table public.jd_signatures add column if not exists mgr_name text;
alter table public.jd_signatures add column if not exists mgr_role text;
alter table public.jd_signatures add column if not exists mgr_signature_path text;
alter table public.jd_signatures add column if not exists mgr_signed_at timestamptz;
alter table public.jd_signatures add column if not exists hr_email text;
alter table public.jd_signatures add column if not exists hr_name text;
alter table public.jd_signatures add column if not exists hr_signature_path text;
alter table public.jd_signatures add column if not exists hr_signed_at timestamptz;
alter table public.jd_signatures enable row level security;
drop policy if exists "signature insert" on public.jd_signatures;
drop policy if exists "signature admin read" on public.jd_signatures;
create policy "signature insert" on public.jd_signatures for insert to anon, authenticated
  with check (signature_path like 'incoming/%' and public.employee_ok(employee_id)
              and mgr_signed_at is null and mgr_signature_path is null and hr_signed_at is null and hr_signature_path is null);
create policy "signature admin read" on public.jd_signatures for select to authenticated using (public.is_admin());

-- True when the signed-in person is the manager who signs this signature:
-- the department head for staff, or the director for department heads.
create or replace function public.is_jd_manager(p_dept text, p_designation text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and a.role = case when p_designation = 'Department Head' then 'director' else 'head' end
      and (p_dept = any(a.depts) or '*' = any(a.depts)));
$$;

-- Signatures the signed-in head or director can see (waiting for them, or already signed by them).
create or replace function public.manager_queue() returns setof public.jd_signatures
language sql stable security definer set search_path = public as $$
  select * from public.jd_signatures s where public.is_jd_manager(s.dept, s.designation) order by s.signed_at;
$$;

create or replace function public.jd_manager_sign(sig uuid, signer_name text, sig_path text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.jd_signatures; acct public.admins;
begin
  select * into r from public.jd_signatures where id = sig;
  if not found then raise exception 'signature not found'; end if;
  if not public.is_jd_manager(r.dept, r.designation) then raise exception 'You are not the manager for this signature'; end if;
  if r.mgr_signed_at is not null then raise exception 'Already signed by the manager'; end if;
  if sig_path not like 'incoming/%' or coalesce(trim(signer_name), '') = '' then raise exception 'signature missing'; end if;
  select * into acct from public.admins where lower(email) = lower(auth.jwt() ->> 'email');
  update public.jd_signatures set mgr_email = acct.email, mgr_name = trim(signer_name), mgr_role = acct.role,
    mgr_signature_path = sig_path, mgr_signed_at = now() where id = sig;
end $$;

create or replace function public.jd_hr_sign(sig uuid, signer_name text, sig_path text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.jd_signatures;
begin
  if not public.is_hr() then raise exception 'Only the HR manager can give the final sign-off'; end if;
  select * into r from public.jd_signatures where id = sig;
  if not found then raise exception 'signature not found'; end if;
  if r.mgr_signed_at is null then raise exception 'The manager has not signed yet'; end if;
  if r.hr_signed_at is not null then raise exception 'Already signed by HR'; end if;
  if sig_path not like 'incoming/%' or coalesce(trim(signer_name), '') = '' then raise exception 'signature missing'; end if;
  update public.jd_signatures set hr_email = auth.jwt() ->> 'email', hr_name = trim(signer_name),
    hr_signature_path = sig_path, hr_signed_at = now() where id = sig;
end $$;
-- Lets a head or director open the employee's signature image for signatures routed to them.
create or replace function public.manager_can_view(obj_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.jd_signatures s where s.signature_path = obj_name and public.is_jd_manager(s.dept, s.designation));
$$;
revoke execute on function public.manager_queue(), public.jd_manager_sign(uuid, text, text), public.jd_hr_sign(uuid, text, text) from public, anon;
grant execute on function public.manager_queue(), public.jd_manager_sign(uuid, text, text), public.jd_hr_sign(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------
-- Private file storage
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('credentials', 'credentials', false, 5242880, array['application/pdf', 'image/jpeg', 'image/png']),
  ('jds', 'jds', false, 20971520, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "credentials public upload" on storage.objects;
drop policy if exists "credentials admin read" on storage.objects;
drop policy if exists "jds read" on storage.objects;
drop policy if exists "jds admin insert" on storage.objects;
drop policy if exists "jds admin update" on storage.objects;
drop policy if exists "jds admin delete" on storage.objects;
create policy "credentials public upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'credentials' and (storage.foldername(name))[1] = 'incoming');
create policy "credentials admin read" on storage.objects for select to authenticated
  using (bucket_id = 'credentials' and public.is_admin());
drop policy if exists "credentials manager read" on storage.objects;
create policy "credentials manager read" on storage.objects for select to authenticated
  using (bucket_id = 'credentials' and public.manager_can_view(name));
create policy "jds read" on storage.objects for select to anon, authenticated using (bucket_id = 'jds');
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
  "positions": ["Consultant", "Associate Consultant", "Assistant Consultant", "Specialist", "Resident", "Nurse Manager", "Charge Nurse", "Staff Nurse"],
  "rules": [
    {"id": "r-all", "dept": "*", "positions": [], "creds": ["scfhs", "dataflow", "cv"]},
    {"id": "r-em", "dept": "em", "positions": ["Consultant", "Associate Consultant", "Assistant Consultant", "Specialist", "Resident"], "creds": ["acls", "bls", "atls", "pals"]},
    {"id": "r-anes-c", "dept": "anes", "positions": ["Consultant"], "creds": ["acls", "pals"]},
    {"id": "r-anes-o", "dept": "anes", "positions": ["Associate Consultant", "Assistant Consultant", "Specialist", "Resident"], "creds": ["acls"]},
    {"id": "r-icu", "dept": "icu", "positions": [], "creds": ["acls"]},
    {"id": "r-nicu", "dept": "nicu", "positions": [], "creds": ["nrp"]},
    {"id": "r-nurse", "dept": "*", "positions": ["Nurse Manager", "Charge Nurse", "Staff Nurse"], "creds": ["bls"]},
    {"id": "r-em-n", "dept": "em", "positions": ["Nurse Manager", "Charge Nurse", "Staff Nurse"], "creds": ["acls", "pals"]},
    {"id": "r-or-n", "dept": "or", "positions": ["Nurse Manager", "Charge Nurse", "Staff Nurse"], "creds": ["acls"]}
  ]
}
$json$::jsonb) on conflict (key) do nothing;

-- ---------------------------------------------------------------
-- One-time updates to a requirements list saved before these changes. Each runs once only,
-- so a later change on the Requirements tab is never overwritten.
-- ---------------------------------------------------------------
do $$
begin
  if not exists (select 1 from public.settings where key = 'migr_assistant_consultant') then
    -- Add "Assistant Consultant" after "Associate Consultant", with the same requirements.
    update public.settings set value = jsonb_set(jsonb_set(value,
      '{positions}', coalesce((
        select jsonb_agg(x order by o, sub) from (
          select e as x, o, 0 as sub from jsonb_array_elements(value -> 'positions') with ordinality t(e, o)
          union all
          select '"Assistant Consultant"'::jsonb, o, 1 from jsonb_array_elements(value -> 'positions') with ordinality t(e, o) where e = '"Associate Consultant"'::jsonb
        ) q), '[]'::jsonb)),
      '{rules}', coalesce((
        select jsonb_agg(case when r -> 'positions' ? 'Associate Consultant'
          then jsonb_set(r, '{positions}', (r -> 'positions') || '"Assistant Consultant"'::jsonb) else r end order by o)
        from jsonb_array_elements(value -> 'rules') with ordinality t(r, o)), '[]'::jsonb))
    where key = 'matrix' and not (value -> 'positions') ? 'Assistant Consultant';
    -- If there was no "Associate Consultant" to place it after, add it at the end.
    update public.settings set value = jsonb_set(value, '{positions}', (value -> 'positions') || '"Assistant Consultant"'::jsonb)
    where key = 'matrix' and not (value -> 'positions') ? 'Assistant Consultant';
    insert into public.settings (key, value) values ('migr_assistant_consultant', 'true'::jsonb);
  end if;
end $$;
