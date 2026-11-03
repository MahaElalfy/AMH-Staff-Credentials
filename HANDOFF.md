# Handoff: publish the AMH Staff Credentials Portal

Instructions for Claude (or a person) on a computer that can reach GitHub. Unzip this folder, open it in Claude Code, and say: **"Follow HANDOFF.md"**.

## Where things stand
- The portal is complete: static site (`index.html`, `app.js`, `config.js`, `logo.png`) plus a Supabase backend (`supabase/schema.sql`). `README.md` explains the design.
- The git history is included (`.git`). The remote is already set to `https://github.com/MahaElalfy/AMH-Staff-Credentials.git` (branch `main`).
- Supabase project: `https://bufxfiahaqkchfeozbbi.supabase.co` (already in `config.js`).
- Supabase publishable key is set in `config.js`.
- Code is on `main` and GitHub Pages is enabled (branch `main`, `/ (root)`). Site: https://mahaelalfy.github.io/AMH-Staff-Credentials/

## Steps
1. **Anon key.** Ask the user for the Supabase **anon** or **publishable** key: Dashboard → Project Settings → API Keys, or https://supabase.com/dashboard/project/bufxfiahaqkchfeozbbi/settings/api-keys. Put it in `config.js` as `supabaseAnonKey`. Never accept or commit the `service_role` / secret key. Commit the change.
2. **Push.** Run `git push -u origin main`. If the GitHub repo already has a commit (for example a README created on github.com), run `git pull --rebase origin main` first, or ask the user before force-pushing.
3. **GitHub Pages.** In the repo: Settings → Pages → Source *Deploy from a branch*, Branch `main`, folder `/ (root)`, Save. With the GitHub CLI: `gh api -X POST repos/MahaElalfy/AMH-Staff-Credentials/pages -f "source[branch]=main" -f "source[path]=/"`. The site will be at `https://mahaelalfy.github.io/AMH-Staff-Credentials/`.
4. **Supabase setup.** Confirm the user has done the following, and help if not:
   - Run all of `supabase/schema.sql` in SQL Editor (https://supabase.com/dashboard/project/bufxfiahaqkchfeozbbi/sql/new).
   - Create the admin user: Authentication → Users → Add user → Create new user, with `malelfy@kfshrc.edu.sa`, a password the user chooses, and **Auto Confirm User** ticked.
   - Optionally, turn off "Allow new users to sign up" (Authentication → Sign In / Providers → Email).
5. **Test.**
   - Open the Pages URL. Submit a test entry (employee ID, name, department, position, one small PDF), then click "I'm finished".
   - Click **Admin sign in** and sign in. Check that the entry is in the Review queue and the file opens.
   - Sign out and confirm the public page shows no submitted data.
