/* ==========================================================================
   Closer Pro — configuration Supabase
   ==========================================================================
   Ces deux valeurs sont PUBLIQUES par conception : l'app est statique (aucune
   étape de build), donc tout ce que le navigateur lit est visible par
   l'utilisateur. C'est le fonctionnement normal de Supabase côté client.

   La sécurité ne repose PAS sur le secret de cette clé, mais sur le Row Level
   Security activé dans supabase/schema.sql : chaque closer ne peut lire et
   écrire que sa propre ligne de `closer_state`.

   ⚠️ Ne jamais mettre ici une clé `service_role` / `sb_secret_...` :
   elle contourne le RLS et donnerait un accès total à la base.
   ========================================================================== */

// Déduite de la référence de projet contenue dans la clé anon (ref: ykmbxsmgfpyfjndotvii).
const SUPABASE_URL = 'https://ykmbxsmgfpyfjndotvii.supabase.co';

const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrbWJ4c21nZnB5ZmpuZG90dmlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzEwNDIsImV4cCI6MjA5OTgwNzA0Mn0.jiO5kfDMb9N1M2XNiYed-cBef59CEWV46O0zP_aUDSw';
