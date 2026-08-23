// Debiteuren · Endura — verbindingsgegevens.
// Dit zijn dezelfde Supabase-gegevens als de Bankboeker: hetzelfde project,
// dezelfde inlogaccounts en hetzelfde doorgeefluik naar DirectLink. Er hoeft
// dus geen nieuw project en geen nieuw DirectLink-token te komen.
// De ANON key is een publieke sleutel (mag in de broncode); de toegang wordt
// afgedwongen door het doorgeefluik: alleen ingelogde endura-aruba.com-accounts.
window.DEBITEUREN_CONFIG = {
  SUPABASE_URL: "https://baaxuergynqgxwlbwrbp.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhYXh1ZXJneW5xZ3h3bGJ3cmJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5Nzc0NTgsImV4cCI6MjA5OTU1MzQ1OH0.trGguPle7TYMSHpLeWRPJ9OI3LnAV-_vR4WQOPRO3a8",
  TOEGESTAAN_DOMEIN: "endura-aruba.com",  // alleen e-mailadressen op dit domein krijgen toegang
  // Strakker dan het domein: alléén deze accounts mogen erin (besluit 23 aug 2026).
  TOEGESTANE_ACCOUNTS: ["shereen@endura-aruba.com", "antoine@endura-aruba.com"]
};
