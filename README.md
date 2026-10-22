# ChanPro Vercel migration

## Deploy
1. Put `public/chanpro.html` in the public directory (or rename to `index.html` if this is the site's entry page).
2. Keep `api/gather.js`, `package.json`, and `vercel.json` at project root.
3. In Vercel Project → Settings → Environment Variables, set:
   - `SUPABASE_URL` = your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = the Supabase **service_role** secret key (never put this in HTML)
4. Deploy and open `/chanpro.html`.

## Important security notes
- The endpoint re-checks the username and SHA-256 password hash for each protected action.
- Direct reads in the HTML still use the Supabase publishable/anon key.
- This migration routes login/registration, DM reads/writes, profile/settings updates, account deletion, moderation actions and selected points actions through Vercel.
- It is not yet a full conversion of every database write in the legacy HTML. Other features still call Supabase directly; before using this in production, convert those remaining `.insert()`, `.update()`, `.upsert()`, and `.delete()` calls to server actions and enforce restrictive RLS. Do not disable RLS or expose the service role key.
- Device fingerprinting is not a strong security identity; it can be reset/spoofed. Keep server-side account BAN checks and rate limits.
- Existing `password_hash` values are assumed to be SHA-256 hex as in the uploaded HTML. A future migration should move to a modern password-hashing/auth system.
- Image URL creation/upload remains in the HTML, per request. The existing ImgBB key remains client-side, so it is public to site visitors; rotate it if it was intended to be secret.
