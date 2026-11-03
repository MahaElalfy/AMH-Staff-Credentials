# AMH Staff Credentials Portal

AlMather Hospital staff sign in with their hospital email and enter their employee ID, full name, department and position. They then upload their required credentials (ACLS, BLS, ATLS, PALS, NRP, SCFHS registration and classification, DataFlow, CV) and sign their job description. Only the administrator can see everyone's uploads, review them and export the compliance report.

- **Page:** static files hosted on GitHub Pages (`index.html`, `config.js`, `logo.png`).
- **Data and files:** Supabase (database, private file storage, email sign-in codes).
- **Access rules:** enforced by the database (`supabase/schema.sql`), not just the page:
  - Staff can create and see **only their own** profile, uploads and signatures. They cannot approve their own documents.
  - Only emails listed in `public.admins` can see everyone's records, verify or return documents, upload job descriptions and change requirements.
  - Only emails on the domains in `public.allowed_domains` can sign up or upload.

> Before going live, confirm with KFSHRC IT / data protection that storing staff personal data in Supabase (an external cloud service) is approved under PDPL and hospital policy.

## Setup (about 30 minutes)

### 1. Create the Supabase project
1. Sign up at https://supabase.com and create a new project.
2. **Region:** choose **Middle East (Bahrain)** if available.
3. Save the database password somewhere safe.

### 2. Create the tables, storage and access rules
1. In the project, open **SQL Editor → New query**.
2. Paste the whole of `supabase/schema.sql` and click **Run**.
3. Check the two settings near the top of that file before running:
   - `admins`: the administrator's email (currently `malelfy@kfshrc.edu.sa`).
   - `allowed_domains`: the email domains staff may use (currently `kfshrc.edu.sa`). Add any other AMH domain, for example:
     ```sql
     insert into public.allowed_domains (domain) values ('example-amh-domain.sa');
     ```

### 3. Turn on email sign-in codes
1. **Authentication → Sign In / Providers → Email:** keep Email enabled. Turn **Confirm email** on.
2. **Authentication → Email Templates:** edit **Magic Link** and **Confirm signup** so the email shows the code. Replace the body with something like:
   ```html
   <h2>AlMather Hospital Credentials Portal</h2>
   <p>Your sign-in code is:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
   <p>The code expires shortly. If you didn't request it, ignore this email.</p>
   ```
3. **Authentication → SMTP Settings:** set up a real email sender. Supabase's built-in sender only allows a few emails per hour, which is fine for testing but not for staff. Ask IT for SMTP details for a hospital address (for example `credentials@...`), or use a service such as Resend, SendGrid or Amazon SES.
4. **Authentication → Rate Limits:** raise "emails sent per hour" once SMTP is set up.

### 4. Connect the page
1. In Supabase open **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
2. Put them in `config.js`. Never use the `service_role` key here.
3. Keep `allowedDomains` in `config.js` the same as the `allowed_domains` table.

### 5. Publish on GitHub Pages
1. Create a GitHub repository (for example `amh-credentials-portal`) and upload these files.
2. **Settings → Pages:** Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)`.
3. After a minute the portal is at `https://<your-github-name>.github.io/amh-credentials-portal/`.
4. In Supabase **Authentication → URL Configuration**, set **Site URL** to that address.

### 6. Test before sending to staff
1. Open the portal and sign in with the admin email. You should see the Compliance, Review queue, Job descriptions and Requirements tabs.
2. In a private browser window, sign in as a test staff member. Enter employee ID, name, department and position, upload one certificate and sign a test JD.
3. As admin, open the Review queue, view the file and verify it.
4. Check that the test staff account **cannot** see the admin tabs.

## Limits and costs
- Supabase free plan: 1 GB file storage and 500 MB database. That's roughly 300–500 staff with compressed uploads. Pro plan is about US$25/month for 100 GB.
- Free-plan projects pause after a week with no activity; upgrade to Pro for continuous use.
- Uploads: PDF up to 5 MB; photos are compressed in the browser. Job descriptions: PDF up to 20 MB.
- Every upload is kept in the history. Staff cannot delete or change past submissions.
- No automatic email reminders yet. Expiring items show in the portal and the CSV export.

## Files
| File | What it is |
|---|---|
| `index.html` | The whole portal (staff and admin views) |
| `config.js` | Supabase URL, anon key and allowed email domains |
| `logo.png` | AlMather Hospital / KFSHRC lockup |
| `supabase/schema.sql` | Tables, private storage buckets, access rules and starting requirements |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |
