// Debiteuren · Endura — verbindingsgegevens.
//
// INLOGGEN gaat via het E-Board-systeem (Supabase-project van E-Board):
// dezelfde e-mailadressen en wachtwoorden als E-Board, dus geen tweede
// wachtwoord om te onthouden. Wie er écht in mag staat in TOEGESTANE_ACCOUNTS.
//
// De VERSTUURFUNCTIE voor aanmaningen draait in het andere Supabase-project
// ("Endura intern", zelfde als de Bankboeker) — daar staan de Microsoft-
// geheimen in de kluis. Vandaar twee adressen hieronder.
//
// De ANON keys zijn publieke sleutels (mogen in de broncode).
window.DEBITEUREN_CONFIG = {
  SUPABASE_URL: "https://xwswtarlyygiayjrzefh.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3c3d0YXJseXlnaWF5anJ6ZWZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDk2MjUsImV4cCI6MjA5OTA4NTYyNX0.9y2PtOJFoJk2kfPSZvPu1Jr8FZ0wbbeWh1ajwwCJMTA",
  FUNCTIES_URL: "https://baaxuergynqgxwlbwrbp.supabase.co",
  TOEGESTAAN_DOMEIN: "endura-aruba.com",
  // Alléén deze accounts mogen erin (besluit 23 aug 2026).
  TOEGESTANE_ACCOUNTS: ["shereen@endura-aruba.com", "antoine@endura-aruba.com"]
};
