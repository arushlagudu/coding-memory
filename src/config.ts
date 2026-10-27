// Where the hosted vault lives. `cm link` prints a URL under this origin for
// the user to open in a browser, so it has to be the deployed domain.
export const VAULT_URL = "https://stackmem-vault.vercel.app";

export const SUPABASE_URL = "https://vuplpnwwygojkwxwsnip.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ1cGxwbnd3eWdvamt3eHdzbmlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0NjU2MjIsImV4cCI6MjEwNjA0MTYyMn0.gIIWuALWlOAzKRD3AAQVHnCNq-o4mVOHOgHJKc0fmYs";

// Placeholder — no real GitHub OAuth App has been registered yet. `cm
// login`'s device flow (src/cli.ts cmdLogin) is fully implemented against
// this id so swapping in a real client_id later is a one-line change;
// until then every login attempt will fail at the device/code step with
// a GitHub-side "Not Found" or similar, since this id isn't registered.
export const GITHUB_CLIENT_ID = "placeholder-stackmem-client-id";
