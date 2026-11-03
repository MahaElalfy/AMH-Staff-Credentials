# AMH Staff Credentials Portal

AlMather Hospital staff open the portal link (no sign-in, no emails), enter their employee ID, full name, department and position, then upload their required credentials (ACLS, BLS, ATLS, PALS, NRP, SCFHS registration and classification, DataFlow, CV) and sign their job description. Only the administrator signs in, with a password, to see and review everything.

- **Page:** static files hosted on GitHub Pages (`index.html`, `app.js`, `config.js`, `logo.png`).
- **Data and files:** Supabase (database and private file storage).
- **Access rules:** enforced by the database (`supabase/schema.sql`), not just the page:
  - Anyone with the link can **submit** documents and signatures, but **cannot read anything back**, not even their own.
  - Only the admin email in `public.admins` can sign in to view, verify, export, upload job descriptions and change requirements.
  - Optional **staff roster**: once you import one, only listed employee IDs can submit, and the Compliance view also shows who hasn't submitted yet.

> Because staff don't sign in, anyone who has the link can submit under any employee ID. The admin review (checking each document against the primary source) and the optional roster are the safeguards. Share the link only internally.
>
> Before going live, confirm with KFSHRC IT / data protection that storing staff personal data in Supabase (an external cloud service) is approved under PDPL and hospital policy.

## Setup (about 20 minutes)

### 1. Create the Supabase project
1. Sign up at https://supabase.com and create a new project.
2. **Region:** choose **Middle East (Bahrain)** if it's offered.
3. Save the database password somewhere safe.

### 2. Create the tables, storage and access rules
1. Open **SQL Editor → New query**.
2. Paste the whole of `supabase/schema.sql` and click **Run**. You should see "Success. No rows returned".
3. The admin email is set near the top of that file (`malelfy@kfshrc.edu.sa`). Change it before running if needed.

### 3. Create your admin login (no email is sent)
1. Open **Authentication → Users → Add user → Create new user**.
2. Enter the admin email and a strong password, and tick **Auto Confirm User**.
3. Click **Create user**. You'll use this email and password with the portal's **Admin sign in** button.
4. Optional: in **Authentication → Sign In / Providers → Email**, turn off **Allow new users to sign up** so nobody else can create an account.

### 4. Connect the page
1. Open **Project Settings → API Keys** (on some projects it's under **Data API**).
2. Copy the **Project URL** and the **anon / publishable** key into `config.js`.
3. Never use the `service_role` or secret key.

### 5. Publish on GitHub Pages
1. Upload these files to a public GitHub repository, for example `amh-credentials-portal`.
2. **Settings → Pages:** Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)`, then **Save**.
3. After about a minute the portal is at `https://<your-github-name>.github.io/amh-credentials-portal/`.

### 6. Optional: import a staff roster
Do this in the portal: sign in as admin and open the **Staff roster** tab.
1. Export the staff list from HR and save it from Excel as **CSV UTF-8**, with the columns `employee_id,full_name,dept,position`. Only `employee_id` is required. `dept` can be the department name (for example *Intensive Care Unit*) or its code (`em`, `anes`, `icu`, `nicu`, `or`, `ward`, `opd`). Click **CSV template** for an example.
2. Click **Import CSV**, choose the file and check the summary: new people, updated people, and any rows that were skipped or had an unknown department or position.
3. Choose **Add new people and update existing ones**, or **Replace the roster** to also remove anyone not in the file (use this for leavers). Then click **Import**.
4. From then on only those employee IDs can submit or sign. Anyone else sees "That employee ID isn't on the staff list". The database enforces this too, not just the page.
5. Use **Add person**, **Edit** and **Remove** for single changes, and **Export roster** to download the list with who has submitted. **Remove everyone** turns the check off again.
6. If people submitted before you imported the roster, the tab offers to add them in one click.

### 6b. Load the job description library
1. Sign in as admin, open **Job descriptions** and click **Import JD library**.
2. Choose `AMH-JD-Library-import.json` (110 job descriptions as AMH-formatted PDFs) and click **Import**. Keep the page open until it finishes.
3. Staff then pick their **Job title** on the form and are asked to sign that job description. Job descriptions already in the portal (same code) are skipped, so the import is safe to run again.

### 7. Test before sending to staff
1. Open the portal. Enter a test employee ID, name, department and position, upload one certificate, and click **I'm finished**.
2. Click **Admin sign in** and sign in. The submission should be in the **Review queue**. Open it and verify it.
3. Sign out, reload, and check that the public page shows no one's data.

## Limits and costs
- Supabase free plan: 1 GB file storage and 500 MB database, roughly 300–500 staff with compressed uploads. Pro plan is about US$25/month for 100 GB.
- Free-plan projects pause after a week with no activity; upgrade to Pro for continuous use.
- Uploads: PDF up to 5 MB; photos are compressed in the browser. Job descriptions: PDF up to 20 MB.
- Every submission is kept. Staff can't view, change or delete anything after submitting.
- When you return a document, staff aren't notified automatically. Contact them using the mobile number they entered.

## Files
| File | What it is |
|---|---|
| `index.html` | Page layout and styles |
| `app.js` | The portal: staff submission form and admin views |
| `config.js` | Supabase URL and anon key |
| `logo.png` | AlMather Hospital / KFSHRC lockup |
| `supabase/schema.sql` | Tables, private storage, access rules and starting requirements |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |
