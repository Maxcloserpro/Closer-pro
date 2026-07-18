/* ==========================================================================
   Closer Pro — Application logic
   ========================================================================== */

'use strict';

/* ---------- Constants ---------- */

const STATUSES = ['Appel planifié', 'R2', 'Acompte', 'Closé', 'No show', 'Annulé', 'Perdu'];
const STATUS_COLOR = {
  'Appel planifié': 'blue', 'R2': 'violet', 'Acompte': 'orange', 'Closé': 'green',
  'No show': 'gray', 'Annulé': 'gray', 'Perdu': 'red'
};
const STATUS_VAR = { gray: 'text-3', blue: 'blue', orange: 'orange', green: 'green', red: 'red', violet: 'violet' };
// Seul "Closé" génère du CA / commissions. "Acompte" = accepté de principe, pas encore payé (aucune valeur financière).
const SIGNED_STATUSES = ['Closé'];
// Statuts comptés dans le taux de closing "RDV honorés" (No show / Annulé exclus)
const HONORED_STATUSES = ['Appel planifié', 'R2', 'Acompte', 'Closé', 'Perdu'];
// Statuts finaux archivables (pas Appel planifié / R2 / Acompte encore en cours)
const ARCHIVABLE_STATUSES = ['Closé', 'No show', 'Annulé', 'Perdu'];
const LOST_REASONS = ['Objection principale', 'Pas de budget', 'Mauvais timing', 'Autre'];
const CRIT_LABELS = {
  intro_cadrage: 'Intro / Cadrage', decouverte: 'Découverte', creusage_douleur: 'Creusage douleur',
  traitement_pattern: 'Traitement pattern', reframing: 'Reframing', pitch: 'Pitch & validation',
  gestion_objections: 'Gestion objections', ecoute_active: 'Écoute active'
};

/* ---------- Utilities ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const eur = (n) => (Number(n) || 0).toLocaleString('fr-FR') + ' €';
const todayISO = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
// Marque un prospect comme modifié maintenant (réarme l'horloge d'archivage)
const touch = (p) => { if (p) p.updatedAt = nowISO(); return p; };
const fmtDate = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }); };
const sameMonth = (iso) => { const d = new Date(iso), n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth(); };
const ARCHIVE_MS = 30 * 24 * 60 * 60 * 1000;
const scoreClass = (s) => s >= 7 ? 'green' : s >= 5 ? 'orange' : 'red';
const scoreColor = (s) => s >= 7 ? 'var(--green)' : s >= 5 ? 'var(--orange)' : 'var(--red)';

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

function openModal(html, opts) {
  $('#modal').innerHTML = html;
  $('#modal').classList.toggle('wide', !!(opts && opts.wide));
  $('#modal-overlay').classList.add('show');
}
function closeModal() { $('#modal-overlay').classList.remove('show'); }
$('#modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });

/* ---------- State ----------
   Supabase est l'unique source de vérité : les données appartiennent au compte,
   pas au navigateur. `state` est rempli par startApp() une fois le closer
   authentifié ; l'export JSON de la sidebar reste la sauvegarde manuelle. */
let state = null;

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Horodatage de la version distante connue — sert à repérer qu'un autre
// appareil a écrit entre-temps (voir pushState).
let REMOTE_UPDATED_AT = null;
let CURRENT_USER = null;

// Un nouveau compte démarre vide : aucune donnée de démonstration.
const emptyState = () => ({ objectif: 5000, ecosystemes: [], offres: [], prospects: [], notes: [], profil: {}, clients: [], factures: [] });

// Toute mutation continue d'appeler save() : envoi différé vers Supabase.
function save() { schedulePush(); }

/* ---------- Synchronisation Supabase ---------- */
const SYNC_LABEL = {
  ok: 'Synchronisé', pending: 'Sauvegarde…', error: 'Hors ligne — sauvegardé ici', conflict: 'Conflit détecté'
};
function setSync(kind) {
  const dot = $('#sync-dot'), lbl = $('#sync-label');
  if (!dot || !lbl) return;
  dot.className = 'sync-dot sync-' + kind;
  lbl.textContent = SYNC_LABEL[kind] || '';
}

let _pushTimer = null;
// Un push par rafale de modifications plutôt qu'un aller-retour réseau par frappe.
function schedulePush() {
  if (!CURRENT_USER) return;
  setSync('pending');
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => { pushState(); }, 1000);
}

async function fetchRemote() {
  const { data, error } = await sb.from('closer_state')
    .select('data, updated_at').eq('user_id', CURRENT_USER.id).maybeSingle();
  if (error) throw error;
  return data;
}

// Renvoie true seulement si les données sont bien arrivées chez Supabase.
async function pushState() {
  if (!CURRENT_USER || !state) return false;
  try {
    // Un autre appareil a-t-il écrit depuis notre dernière lecture ?
    const { data: cur } = await sb.from('closer_state')
      .select('updated_at').eq('user_id', CURRENT_USER.id).maybeSingle();
    if (cur && REMOTE_UPDATED_AT && cur.updated_at !== REMOTE_UPDATED_AT) {
      setSync('conflict');
      onConflict();
      return false;
    }
    const { data, error } = await sb.from('closer_state')
      .upsert({ user_id: CURRENT_USER.id, data: state }, { onConflict: 'user_id' })
      .select('updated_at').single();
    if (error) throw error;
    REMOTE_UPDATED_AT = data.updated_at;
    setSync('ok');
    return true;
  } catch (e) {
    console.warn('[Sync] Push impossible :', e.message || e);
    setSync('error'); // les données restent dans le miroir local
    return false;
  }
}

// Deux appareils ont modifié la même fiche : on ne tranche pas à la place du closer.
function onConflict() {
  openModal(`<h3>Conflit de synchronisation</h3>
    <div class="import-warn">Tes données ont été modifiées depuis un autre appareil.
    Garder cette version écrasera les modifications faites ailleurs ; récupérer l'autre
    version abandonnera tes changements en cours sur cet appareil.</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="cf-remote">Récupérer l'autre version</button>
      <button class="btn btn-danger" id="cf-local">Garder cette version</button>
    </div>`);
  $('#cf-remote').onclick = async () => {
    const remote = await fetchRemote();
    if (remote) { state = migrate(remote.data); REMOTE_UPDATED_AT = remote.updated_at; }
    closeModal(); setSync('ok'); go('dashboard'); toast('Version distante récupérée');
  };
  $('#cf-local').onclick = async () => {
    const { data: cur } = await sb.from('closer_state')
      .select('updated_at').eq('user_id', CURRENT_USER.id).maybeSingle();
    REMOTE_UPDATED_AT = cur ? cur.updated_at : null; // on accepte d'écraser
    closeModal();
    await pushState();
    toast('Cette version a été conservée');
  };
}

/* ---------- Authentification ---------- */
function showAuth(msg) {
  $('#app-root').hidden = true;
  $('#auth-screen').hidden = false;
  const err = $('#auth-error');
  if (msg) { err.textContent = msg; err.hidden = false; } else { err.hidden = true; }
}

function enterApp(user) {
  $('#auth-screen').hidden = true;
  $('#app-root').hidden = false;
  $('#user-email').textContent = user.email || '—';
  $('#user-avatar').textContent = (user.email || 'CL').slice(0, 2).toUpperCase();
  setSync('ok');
  let p = 'dashboard';
  try { p = sessionStorage.getItem('closeros_page') || 'dashboard'; } catch (e) { /* ignore */ }
  go(RENDERERS[p] ? p : 'dashboard');
}

async function startApp(user) {
  CURRENT_USER = user;
  let remote = null;
  try { remote = await fetchRemote(); }
  catch (e) {
    showAuth('Connexion à Supabase impossible : ' + (e.message || e));
    return;
  }

  if (remote) {
    state = migrate(remote.data);
    REMOTE_UPDATED_AT = remote.updated_at;
  } else {
    // Première connexion de ce compte : espace vierge.
    state = emptyState();
    await pushState();
  }
  enterApp(user);
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#auth-go');
  btn.disabled = true; btn.textContent = 'Connexion…';
  const { data, error } = await sb.auth.signInWithPassword({
    email: $('#auth-email').value.trim(),
    password: $('#auth-pass').value
  });
  btn.disabled = false; btn.textContent = 'Se connecter';
  if (error) {
    showAuth(error.message === 'Invalid login credentials'
      ? 'Email ou mot de passe incorrect.' : error.message);
    return;
  }
  $('#auth-pass').value = '';
  await startApp(data.user);
});

$('#logout-btn').addEventListener('click', async () => {
  clearTimeout(_pushTimer);
  const pushed = await pushState();

  // Rien n'est conservé en local : se déconnecter sans avoir synchronisé
  // perdrait définitivement les dernières modifications.
  if (!pushed) {
    openModal(`<h3>Modifications non synchronisées</h3>
      <div class="import-warn">Tes dernières modifications n'ont pas pu être envoyées à Supabase.
      Te déconnecter maintenant les perdrait définitivement.</div>
      <p class="hint" style="margin-bottom:16px">Reconnecte-toi à internet et réessaie, ou exporte
      une sauvegarde JSON depuis la sidebar avant de partir.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Rester connecté</button>
        <button class="btn btn-danger" id="lo-force">Se déconnecter et perdre ces modifications</button>
      </div>`);
    $('#lo-force').onclick = () => { closeModal(); doLogout(); };
    return;
  }
  doLogout();
});

// Supabase impose un mot de passe d'au moins 6 caractères par défaut.
const MIN_PASSWORD = 6;

$('#pwd-change').addEventListener('click', () => {
  closeNav(); // sur mobile, referme la sidebar en overlay
  openModal(`<h3>Changer mon mot de passe</h3>
    <div class="field">
      <label for="pw-new">Nouveau mot de passe</label>
      <input class="input" type="password" id="pw-new" autocomplete="new-password" placeholder="Au moins ${MIN_PASSWORD} caractères">
    </div>
    <div class="field">
      <label for="pw-confirm">Confirmer le mot de passe</label>
      <input class="input" type="password" id="pw-confirm" autocomplete="new-password">
    </div>
    <div class="auth-error" id="pw-error" hidden></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" id="pw-save">Mettre à jour</button>
    </div>`);

  const errBox = $('#pw-error');
  const showErr = (m) => { errBox.textContent = m; errBox.hidden = false; };

  $('#pw-save').onclick = async () => {
    const pw = $('#pw-new').value;
    const confirm = $('#pw-confirm').value;
    errBox.hidden = true;

    if (pw.length < MIN_PASSWORD) { showErr(`Le mot de passe doit faire au moins ${MIN_PASSWORD} caractères.`); return; }
    if (pw !== confirm) { showErr('Les deux mots de passe ne correspondent pas.'); return; }

    const btn = $('#pw-save');
    btn.disabled = true; btn.textContent = 'Mise à jour…';
    const { error } = await sb.auth.updateUser({ password: pw });
    btn.disabled = false; btn.textContent = 'Mettre à jour';

    if (error) {
      // Ex. "New password should be different from the old password."
      showErr(error.message || 'La mise à jour a échoué. Réessaie.');
      return;
    }
    closeModal();
    toast('Mot de passe modifié avec succès');
  };
});

async function doLogout() {
  await sb.auth.signOut();
  CURRENT_USER = null; state = null; REMOTE_UPDATED_AT = null;
  showAuth();
}

/* ---------- Export / Import des données ---------- */
const BACKUP_FORMAT = 'closer-pro-backup';

// Sauvegarde complète : l'état applicatif + un en-tête pour reconnaître le fichier à l'import.
function exportData() {
  const payload = { format: BACKUP_FORMAT, version: 1, exportedAt: nowISO(), data: state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `closer-pro-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`Sauvegarde exportée · ${state.prospects.length} prospect(s)`);
}

// Accepte le format d'export ({format, data}) ou un état brut exporté à la main.
function parseBackup(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error('Fichier illisible : ce n\'est pas du JSON valide.'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Fichier invalide.');
  const data = parsed.format === BACKUP_FORMAT && parsed.data ? parsed.data : parsed;
  if (!Array.isArray(data.prospects)) throw new Error('Ce fichier ne ressemble pas à une sauvegarde Closer Pro (aucun prospect trouvé).');
  return { data, exportedAt: parsed.exportedAt || null };
}

function importDataFile(file) {
  const reader = new FileReader();
  reader.onerror = () => toast('Impossible de lire le fichier');
  reader.onload = () => {
    let backup;
    try { backup = parseBackup(reader.result); }
    catch (e) { toast(e.message); return; }

    const incoming = migrate(backup.data);
    const nbP = incoming.prospects.length, nbE = (incoming.ecosystemes || []).length, nbO = (incoming.offres || []).length;
    const cur = state.prospects.length;
    const quand = backup.exportedAt ? ` du ${fmtDate(backup.exportedAt)}` : '';

    openModal(`<h3>Importer cette sauvegarde ?</h3>
      <p class="hint" style="margin-bottom:14px">Sauvegarde${quand} · <b>${nbP} prospect(s)</b>, ${nbE} écosystème(s), ${nbO} offre(s).</p>
      <div class="import-warn">⚠ Cette action <b>écrase définitivement</b> tes données actuelles (${cur} prospect${cur > 1 ? 's' : ''}). Cette opération est irréversible — pense à exporter une sauvegarde avant.</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button class="btn btn-danger" id="imp-ok">Écraser et importer</button>
      </div>`);

    $('#imp-ok').onclick = () => {
      state = incoming;
      save();
      closeModal();
      go('dashboard');
      toast(`${nbP} prospect(s) importé(s)`);
    };
  };
  reader.readAsText(file);
}

// Commission auto-calculée à partir du prix et du taux
function calcCommission(p) {
  if (p && p.prix != null && p.prix !== '' && p.tauxCommission != null && p.tauxCommission !== '') {
    return Math.round(Number(p.prix) * Number(p.tauxCommission) / 100);
  }
  return null;
}

// Normalise une échéance de paiement
function normalizePayment(pay) {
  pay = pay || {};
  const dateRecu = pay.dateRecu || null;
  return {
    montant: Number(pay.montant) || 0,
    datePrevu: pay.datePrevu || '',
    dateRecu: dateRecu,
    statut: dateRecu ? 'reçu' : (pay.statut === 'reçu' ? 'en attente' : (pay.statut || 'en attente'))
  };
}

// Normalise un prospect vers le schéma complet (gère l'ancien format)
function normalizeProspect(p) {
  p = p || {};
  // Mapping des anciens statuts retirés
  const statusMap = { 'À appeler': 'Appel planifié', 'En cours': 'R2' };
  let statut = p.statut || 'Appel planifié';
  statut = statusMap[statut] || statut;
  if (!STATUSES.includes(statut)) statut = 'Appel planifié';

  const prix = p.prix != null ? p.prix : (p.montant != null && p.montant !== 0 ? p.montant : null);
  const signed = SIGNED_STATUSES.includes(statut);
  const taux = p.tauxCommission != null ? p.tauxCommission : (p.taux != null ? p.taux : (signed ? 15 : null));

  // Plan de paiement
  let paiements = Array.isArray(p.paiements) ? p.paiements.map(normalizePayment) : [];
  // Migration depuis l'ancien champ unique `paiement` ('Payé'/'Acompte'/'En attente')
  if (!paiements.length && statut === 'Closé' && prix != null) {
    const recu = p.paiement === 'Payé';
    const date = p.dateClose || p.rdv || todayISO();
    paiements = [{ montant: prix, datePrevu: date, dateRecu: recu ? date : null, statut: recu ? 'reçu' : 'en attente' }];
  }

  // Migration de l'ancien champ libre `contact` vers email / téléphone.
  // Un pseudo (« @camille.roy ») n'est ni l'un ni l'autre : il reste dans `contact`.
  const rawContact = String(p.contact || '').trim();
  const looksEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawContact);
  const looksPhone = /^\+?[\d\s().-]{6,}$/.test(rawContact);
  const email = p.email || (looksEmail ? rawContact : '');
  const telephone = p.telephone || (looksPhone ? rawContact : '');

  const np = {
    id: p.id || uid(),
    nom: p.nom || '',
    contact: rawContact || email || telephone,
    email: email,
    telephone: telephone,
    ecosystemeId: p.ecosystemeId || '',
    ecosystemeNom: p.ecosystemeNom || '',
    offreId: p.offreId || '',
    offreNom: p.offreNom || p.offre || '',
    offre: p.offre || p.offreNom || '', // alias d'affichage rétro-compatible
    modePaiement: p.modePaiement || '',
    prix: prix,
    tauxCommission: taux,
    commission: null,
    statut: statut,
    dateRdv: p.dateRdv != null ? p.dateRdv : (p.rdv || ''),
    dateClose: p.dateClose || (statut === 'Closé' ? (p.rdv || todayISO()) : ''),
    paiements: paiements,
    raisonPerte: p.raisonPerte || '',
    notes: p.notes || '',
    createdAt: p.createdAt || p.rdv || todayISO(),
    updatedAt: p.updatedAt || p.statutChangedAt || p.dateClose || p.dateRdv || p.createdAt || todayISO(),
    archived: !!p.archived,
    archivedAt: p.archivedAt || null
  };
  np.commission = calcCommission(np);
  return np;
}

// Migration : ancien state -> nouveau modèle (ventes legacy fusionnées dans les prospects)
function migrate(s) {
  s = s || {};
  s.objectif = s.objectif != null ? s.objectif : 5000;
  s.notes = Array.isArray(s.notes) ? s.notes : [];

  if (Array.isArray(s.ventes)) {
    (s.prospects || []).forEach(() => {});
    s.ventes.forEach(v => {
      const list = s.prospects = s.prospects || [];
      const match = list.find(p => (p.nom || '').trim().toLowerCase() === String(v.client || '').trim().toLowerCase());
      if (match) {
        match.statut = 'Closé';
        if (match.prix == null) match.prix = v.prix;
        if (match.tauxCommission == null && match.taux == null) match.taux = v.taux;
        if (!match.offre) match.offre = v.offre || '';
        if (!match.dateClose) match.dateClose = v.date || todayISO();
        if (!match.paiement) match.paiement = v.statut || 'En attente';
      } else {
        list.push({
          nom: v.client, offre: v.offre, prix: v.prix, taux: v.taux,
          statut: 'Closé', dateClose: v.date, createdAt: v.date, paiement: v.statut
        });
      }
    });
    delete s.ventes;
  }

  s.prospects = (Array.isArray(s.prospects) ? s.prospects : []).map(normalizeProspect);
  s.ecosystemes = Array.isArray(s.ecosystemes) ? s.ecosystemes : [];
  s.offres = Array.isArray(s.offres) ? s.offres : [];
  delete s.ressources;
  // Module de facturation
  s.profil = s.profil && typeof s.profil === 'object' ? s.profil : {};
  s.clients = Array.isArray(s.clients) ? s.clients : [];
  s.factures = Array.isArray(s.factures) ? s.factures : [];
  // Statut par défaut sur les factures existantes (créées avant la fonctionnalité)
  s.factures.forEach(f => { if (!INVOICE_STATUSES.includes(f.statut)) f.statut = 'Brouillon'; });
  s.factureCounter = s.factureCounter && typeof s.factureCounter === 'object' ? s.factureCounter : {};
  return s;
}

/* ---------- Données dérivées (liste optionnelle, défaut = tous les prospects) ---------- */
const closedProspects = (list = state.prospects) => list
  .filter(p => p.statut === 'Closé')
  .sort((a, b) => new Date(b.dateClose || 0) - new Date(a.dateClose || 0));
// Deals signés = génèrent du cash contracté (Acompte + Closé)
const signedProspects = (list = state.prospects) => list
  .filter(p => SIGNED_STATUSES.includes(p.statut))
  .sort((a, b) => new Date(b.dateClose || 0) - new Date(a.dateClose || 0));
const monthKey = (iso) => { const dt = new Date(iso); return isNaN(dt) ? '' : dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'); };

// ---- Lookups écosystèmes / offres ----
const ecoById = (id) => state.ecosystemes.find(e => e.id === id);
const offreById = (id) => state.offres.find(o => o.id === id);
const offresOf = (ecoId) => state.offres.filter(o => o.ecosystemeId === ecoId);

// ---- Helpers paiements / cash ----
const payCommission = (p, pay) => Math.round((Number(pay.montant) || 0) * (Number(p.tauxCommission) || 0) / 100);
const contractedCash = (p) => Number(p.prix) || 0;
const collectedCash = (p) => (p.paiements || []).filter(x => x.dateRecu).reduce((s, x) => s + (Number(x.montant) || 0), 0);

// Toutes les échéances à plat, enrichies du prospect (sur deals signés de la liste)
function allPayments(list = state.prospects) {
  const out = [];
  signedProspects(list).forEach(p => (p.paiements || []).forEach((pay, idx) => {
    out.push({ prospect: p, idx, montant: Number(pay.montant) || 0, datePrevu: pay.datePrevu, dateRecu: pay.dateRecu, commission: payCommission(p, pay) });
  }));
  return out;
}

// Agrégats financiers (cash + commissions) sur une liste de prospects
function financials(list = state.prospects) {
  const signed = signedProspects(list);
  const cashContracte = signed.reduce((s, p) => s + contractedCash(p), 0);
  const cashCollecte = signed.reduce((s, p) => s + collectedCash(p), 0);
  const pays = allPayments(list);
  const commCollectee = pays.filter(x => x.dateRecu).reduce((s, x) => s + x.commission, 0);
  const commEnAttente = pays.filter(x => !x.dateRecu).reduce((s, x) => s + x.commission, 0);
  return {
    cashContracte, cashCollecte, cashACollecter: cashContracte - cashCollecte,
    commCollectee, commEnAttente
  };
}

// Commission encaissée sur un mois donné (clé "YYYY-MM")
function commissionForMonth(key, list = state.prospects) {
  return allPayments(list).filter(x => x.dateRecu && monthKey(x.dateRecu) === key).reduce((s, x) => s + x.commission, 0);
}
// Cash encaissé sur un mois donné
function cashForMonth(key, list = state.prospects) {
  return allPayments(list).filter(x => x.dateRecu && monthKey(x.dateRecu) === key).reduce((s, x) => s + x.montant, 0);
}

// Un paiement est "jour J" seulement si c'est le PREMIER versement du deal, reçu le jour exact du close
const isJourJ = (p, pay, idx) => idx === 0 && !!pay.dateRecu && !!p.dateClose && String(pay.dateRecu).slice(0, 10) === String(p.dateClose).slice(0, 10);
// CA collecté jour J d'un prospect : montant du 1er versement s'il a été reçu le jour du close
const dealJourJ = (p) => { const f = (p.paiements || [])[0]; return f && isJourJ(p, f, 0) ? Number(f.montant) || 0 : 0; };
// Reste à collecter = deal total - tous les paiements déjà reçus
const resteACollecter = (p) => Math.max(0, (Number(p.prix) || 0) - collectedCash(p));

// Distinction JOUR J (nouveau close) vs RÉCURRENT sur une fenêtre [start, end]
// - jour J   : 1er paiement reçu le jour du close, ce close étant dans la période
// - récurrent : tout autre paiement reçu dans la période (échéances suivantes, ou deals antérieurs)
function classifyPayments(list, start, end) {
  const signed = signedProspects(list);
  const nv = { nb: 0, collecte: 0, comm: 0, contracte: 0, nbCloses: 0 };
  const rec = { nb: 0, collecte: 0, comm: 0 };
  signed.forEach(p => {
    const dc = p.dateClose ? new Date(p.dateClose) : null;
    if (dc && dc >= start && dc <= end) { nv.nbCloses++; nv.contracte += Number(p.prix) || 0; }
    (p.paiements || []).forEach((pay, idx) => {
      if (!pay.dateRecu) return;
      const rd = new Date(pay.dateRecu);
      if (rd < start || rd > end) return;
      const c = payCommission(p, pay);
      const m = Number(pay.montant) || 0;
      if (isJourJ(p, pay, idx)) { nv.nb++; nv.collecte += m; nv.comm += c; }
      else { rec.nb++; rec.collecte += m; rec.comm += c; }
    });
  });
  return { nv, rec };
}

// Les deux taux de closing — par défaut sur TOUS les prospects (actifs + archivés) pour rester représentatifs
function closingRates(list = state.prospects) {
  const all = list.length;
  const closed = list.filter(p => p.statut === 'Closé').length;
  const honoredDenom = list.filter(p => HONORED_STATUSES.includes(p.statut)).length;
  return {
    closed,
    honored: honoredDenom ? Math.round((closed / honoredDenom) * 100) : 0,
    honoredDenom,
    total: all ? Math.round((closed / all) * 100) : 0,
    totalDenom: all
  };
}

/* ---------- Archivage ---------- */
const activeProspects = () => state.prospects.filter(p => !p.archived);
const archivedProspects = () => state.prospects.filter(p => p.archived);
const isArchivable = (p) => ARCHIVABLE_STATUSES.includes(p.statut);
// Jours écoulés depuis la dernière modification (basé sur updatedAt, calculé dynamiquement)
function daysSinceUpdate(p) {
  const ref = p.updatedAt || p.createdAt;
  if (!ref) return 0;
  return Math.floor((new Date() - new Date(ref)) / 86400000);
}
// Éligible à l'archivage : statut final + non archivé + plus de 30 jours sans modification
function archiveEligible(p) {
  return !p.archived && isArchivable(p) && (new Date() - new Date(p.updatedAt || p.createdAt)) > ARCHIVE_MS;
}
// Date de référence d'un prospect archivé (pour tri / filtre période / colonne Date)
const refDate = (p) => p.dateClose || p.archivedAt || p.updatedAt || p.dateRdv || p.createdAt;

function archiveProspect(id) {
  const p = state.prospects.find(x => x.id === id);
  if (!p || !isArchivable(p)) return false;
  p.archived = true;
  p.archivedAt = nowISO();
  touch(p);
  save();
  return true;
}
function archiveAllEligible() {
  const eligibles = activeProspects().filter(archiveEligible);
  eligibles.forEach(p => { p.archived = true; p.archivedAt = nowISO(); touch(p); });
  if (eligibles.length) save();
  return eligibles.length;
}
function unarchiveProspect(id) {
  const p = state.prospects.find(x => x.id === id);
  if (!p) return;
  p.archived = false;
  p.archivedAt = null;
  touch(p);
  save();
}
function deleteProspect(id) {
  state.prospects = state.prospects.filter(x => x.id !== id);
  save();
}

// Liste des 6 derniers mois (clé + libellé court) du plus ancien au plus récent
function last6Months() {
  const out = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      key: dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'),
      label: dt.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '')
    });
  }
  return out;
}

// Re-rendu de la page active : garantit la synchro temps réel entre Pipeline / Dashboard / Commissions
function syncActivePage() {
  let page = 'dashboard';
  try { page = sessionStorage.getItem('closeros_page') || 'dashboard'; } catch (e) { /* ignore */ }
  if (RENDERERS[page]) RENDERERS[page]();
}

/* ==========================================================================
   Router
   ========================================================================== */
const RENDERERS = {
  dashboard: renderDashboard,
  crm: renderCRM, ecosystemes: renderEcosystemes,
  stats: renderStats, commissions: renderCommissions,
  facturation: renderFacturation,
  documents: renderDocuments, outils: renderOutils
};

function go(page) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  RENDERERS[page]();
  try { sessionStorage.setItem('closeros_page', page); } catch (e) { /* ignore */ }
  $('.main').scrollTo({ top: 0 });
  window.scrollTo({ top: 0 });
}

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (btn) { go(btn.dataset.page); closeNav(); } // sur mobile, la sidebar recouvre la page
});

/* ---------- Sidebar mobile (overlay) ---------- */
function setNav(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#nav-backdrop').classList.toggle('show', open);
  $('#nav-toggle').setAttribute('aria-expanded', String(open));
  $('#nav-toggle').setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
  // Empêche le défilement de la page derrière l'overlay
  document.body.classList.toggle('nav-locked', open);
}
const closeNav = () => setNav(false);

$('#nav-toggle').addEventListener('click', () => setNav(!$('#sidebar').classList.contains('open')));
$('#nav-backdrop').addEventListener('click', closeNav);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
// Repasser en desktop doit repartir d'un état propre (sidebar toujours visible).
window.addEventListener('resize', () => { if (window.innerWidth > 860) closeNav(); });

/* ---------- Sidebar : section Données ---------- */
$('#data-export').onclick = () => exportData();
$('#data-import').onclick = () => $('#data-file').click();
$('#data-file').onchange = (e) => {
  const file = e.target.files[0];
  if (file) importDataFile(file);
  e.target.value = ''; // permet de réimporter le même fichier
};

/* ==========================================================================
   Shared icons
   ========================================================================== */
const ICONS = {
  euro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9.5a3.5 3.5 0 1 0 0 5"/><line x1="4" y1="10" x2="11" y2="10"/><line x1="4" y1="14" x2="10" y2="14"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  bulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2Z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>'
};

function kpi(icon, tint, label, value, meta) {
  return `<div class="kpi">
    <div class="kpi-row">
      <div class="kpi-icon ${tint}">${ICONS[icon]}</div>
      <div class="kpi-label">${label}</div>
    </div>
    <div class="kpi-value">${value}</div>
    ${meta ? `<div class="kpi-meta">${meta}</div>` : ''}
  </div>`;
}

/* ==========================================================================
   PAGE 1 — Dashboard
   ========================================================================== */
let DASH_CHART = null;
const C_REV = '#16a34a', C_COMM = '#E8932F', C_RATE = '#3B82C4';

// Carte KPI épurée : label / grand chiffre coloré / contexte
function kpiCard(label, value, color, context) {
  return `<div class="kpic">
    <div class="kpic-label">${label}</div>
    <div class="kpic-value" style="color:${color || 'var(--text)'}">${value}</div>
    <div class="kpic-ctx">${context || ''}</div>
  </div>`;
}

// CA collecté jour J : uniquement le 1er versement reçu le jour exact du close
function dayOneCash(list = state.prospects) {
  let jourJ = 0;
  signedProspects(list).forEach(p => { const first = (p.paiements || [])[0]; if (first && isJourJ(p, first, 0)) jourJ += Number(first.montant) || 0; });
  return jourJ;
}
const contractedForMonth = (key) => signedProspects().filter(p => p.dateClose && monthKey(p.dateClose) === key).reduce((s, p) => s + (Number(p.prix) || 0), 0);
const closesForMonth = (key) => signedProspects().filter(p => p.dateClose && monthKey(p.dateClose) === key).length;
const payStatut = (p) => { const c = collectedCash(p), tot = Number(p.prix) || 0; if (tot && c >= tot) return ['Payé', 'green']; if (c > 0) return ['Partiel', 'orange']; return ['En attente', 'gray']; };

function renderDashboard() {
  const now = new Date();
  const mk = monthKey(todayISO());
  const lmk = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));

  const caMois = contractedForMonth(mk), caLast = contractedForMonth(lmk);
  const commMois = commissionForMonth(mk), commLast = commissionForMonth(lmk);
  const closesMois = closesForMonth(mk), closesLast = closesForMonth(lmk);
  const rates = closingRates();
  const fin = financials();
  const jourJ = dayOneCash();
  const tauxJourJ = fin.cashContracte ? Math.round(jourJ / fin.cashContracte * 100) : 0;

  const delta = (cur, prev, money) => prev ? `vs ${money ? eur(prev) : prev} le mois dernier` : 'Aucune donnée le mois dernier';

  // Objectif
  const objPct = Math.min(100, Math.round((caMois / (state.objectif || 1)) * 100));

  // Prochains RDVs
  const rdvs = state.prospects.filter(p => p.dateRdv && new Date(p.dateRdv) >= now).sort((a, b) => new Date(a.dateRdv) - new Date(b.dateRdv)).slice(0, 5);
  const rdvList = rdvs.length ? rdvs.map(p => `<div class="rdv-item">
    <div class="rdv-when"><span class="rdv-date">${fmtDate(p.dateRdv)}</span><span class="rdv-time">${rdvTime(p.dateRdv) && rdvTime(p.dateRdv) !== '—' ? rdvTime(p.dateRdv) : ''}</span></div>
    <div class="rdv-main"><div class="rdv-name">${esc(p.nom)}</div><div class="rdv-offre">${esc(p.offre || '—')}</div></div>
    <span class="badge badge-${STATUS_COLOR[p.statut]}">${esc(p.statut)}</span>
  </div>`).join('') : '<div class="muted" style="padding:14px 0">Aucun RDV à venir</div>';

  // Dernières ventes
  const lastSales = signedProspects().slice(0, 5);
  const salesRows = lastSales.length ? lastSales.map(p => {
    const [pl, pc] = payStatut(p);
    return `<tr>
      <td class="t-strong">${esc(p.nom)}</td>
      <td class="muted">${esc(p.offre || '—')}</td>
      <td class="t-right t-num">${eur(p.prix)}</td>
      <td class="t-right t-num" style="color:${C_COMM}">${eur(p.commission)}</td>
      <td>${fmtDate(p.dateClose)}</td>
      <td><span class="badge badge-${pc}">${pl}</span></td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">Aucune vente</td></tr>';

  $('#page-dashboard').innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">Dashboard</h1><div class="page-subtitle" style="text-transform:capitalize">${now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</div></div>
    </div>

    <div class="grid grid-5 sec">
      ${kpiCard('CA contracté ce mois', eur(caMois), C_REV, delta(caMois, caLast, true))}
      ${kpiCard('Commissions ce mois', eur(Math.round(commMois)), C_COMM, delta(commMois, commLast, true))}
      ${kpiCard('Nouveaux closes', closesMois, 'var(--text)', delta(closesMois, closesLast, false))}
      ${kpiCard('Taux de closing', rates.honored + '%', C_RATE, `${rates.closed} closés / ${rates.honoredDenom} RDV honorés`)}
      ${kpiCard('Taux d\'encaissé jour J', tauxJourJ + '%', C_RATE, `${eur(jourJ)} encaissés au close`)}
    </div>

    <div class="grid grid-60 sec">
      <div class="card">
        <div class="kpic-label">CA contracté — 12 derniers mois</div>
        <div class="chart-box" style="height:320px;margin-top:14px"><canvas id="dash-chart"></canvas></div>
      </div>
      <div class="card">
        <div class="kpic-label">Objectif du mois</div>
        <div class="obj-row"><span class="obj-num">${eur(caMois)}</span><span class="obj-pct">${objPct}%</span></div>
        <div class="progress-sober"><div class="progress-sober-fill" style="width:0%" data-w="${objPct}"></div></div>
        <div class="kpic-ctx" style="margin-top:10px">Objectif ${eur(state.objectif)} · reste ${eur(Math.max(0, state.objectif - caMois))}</div>
        <div class="divider"></div>
        <button class="btn btn-ghost btn-sm" id="edit-goal">Modifier l'objectif</button>
      </div>
    </div>

    <div class="card sec">
      <div class="flex between items-center"><div class="kpic-label">Prochains RDVs</div><a href="#" id="dash-rdv-all" class="link-accent">Voir tous →</a></div>
      <div style="margin-top:8px">${rdvList}</div>
    </div>

    <div class="card">
      <div class="kpic-label" style="margin-bottom:14px">Dernières ventes</div>
      <div class="table-scroll"><table class="clean-table"><thead><tr><th>Nom</th><th>Offre</th><th class="t-right">Deal</th><th class="t-right">Commission</th><th>Date</th><th>Paiement</th></tr></thead><tbody>${salesRows}</tbody></table></div>
    </div>`;

  // animations barres
  setTimeout(() => {
    $$('#page-dashboard .row-fill').forEach(b => b.style.width = b.dataset.w + '%');
    $$('#page-dashboard .progress-sober-fill').forEach(b => b.style.width = b.dataset.w + '%');
  }, 60);

  // Graphique 12 mois (barres une couleur)
  if (DASH_CHART) { try { DASH_CHART.destroy(); } catch (e) { /* ignore */ } DASH_CHART = null; }
  const cv = $('#dash-chart');
  if (cv && window.Chart) {
    const months = last12Months();
    const data = months.map(m => contractedForMonth(m.key));
    const eurTick = (v) => (v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : v) + '€';
    DASH_CHART = new Chart(cv, {
      type: 'bar',
      data: { labels: months.map(m => m.label), datasets: [{ data, backgroundColor: '#16a34a', borderRadius: 5, maxBarThickness: 30 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' CA contracté : ' + eur(c.parsed.y) } } },
        scales: { x: { grid: { display: false }, ticks: { font: { size: 11 } } }, y: { beginAtZero: true, grid: { color: '#F0EDE8' }, ticks: { callback: eurTick, font: { size: 11 } } } }
      }
    });
  }

  $('#edit-goal').onclick = () => {
    openModal(`<h3>Objectif du mois</h3>
      <div class="field"><label>Objectif de CA (€)</label><input class="input" type="number" id="goal-input" value="${state.objectif}"></div>
      <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-primary" id="goal-save">Enregistrer</button></div>`);
    $('#goal-save').onclick = () => { state.objectif = Number($('#goal-input').value) || 0; save(); closeModal(); renderDashboard(); toast('Objectif mis à jour'); };
  };
  const rl = $('#dash-rdv-all'); if (rl) rl.onclick = (e) => { e.preventDefault(); setCrmTab('agenda'); go('crm'); };
}

/* ==========================================================================
   PAGE 4 — Pipeline
   ========================================================================== */
let CRM_TAB = (() => { try { return sessionStorage.getItem('crm_tab') || 'pipeline'; } catch (e) { return 'pipeline'; } })();
const setCrmTab = (t) => { CRM_TAB = t; try { sessionStorage.setItem('crm_tab', t); } catch (e) { /* ignore */ } };
const AGENDA_PERIOD = { preset: '7j', from: '', to: '' };
const TOUS = { q: '', statut: 'Tous', eco: '', offre: '', period: { preset: 'tout', from: '', to: '' }, sort: { col: 'dateRdv', dir: -1 } };
const PIPELINE_STATUSES = ['Appel planifié', 'R2', 'Acompte'];

// Helpers RDV (date + heure)
function dayKeyOf(iso) { const d = new Date(iso); if (isNaN(d)) return String(iso).slice(0, 10); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function rdvTime(iso) { if (!iso) return ''; if (String(iso).length <= 10) return '—'; const d = new Date(iso); if (isNaN(d)) return ''; return String(d.getHours()).padStart(2, '0') + 'h' + String(d.getMinutes()).padStart(2, '0'); }

function renderCRM() {
  const tabs = [['agenda', 'Agenda'], ['pipeline', 'Pipeline'], ['tous', 'Tous les prospects']];
  $('#page-crm').innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">CRM</h1><div class="page-subtitle">Agenda, pipeline et base complète de prospects</div></div>
      <div class="flex gap items-center">
        <button class="btn btn-ghost" id="crm-manage">${ICONS.euro} Gérer les offres</button>
        <button class="btn btn-primary" id="crm-new">${ICONS.plus} Nouveau prospect</button>
      </div>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${CRM_TAB === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="crm-tab"></div>`;
  $$('#page-crm .tab').forEach(b => b.onclick = () => { setCrmTab(b.dataset.tab); renderCRM(); });
  $('#crm-manage').onclick = () => openGererOffres();
  $('#crm-new').onclick = () => prospectForm();
  renderCRMTab();
}
function renderCRMTab() {
  if (CRM_TAB === 'agenda') renderAgenda();
  else if (CRM_TAB === 'tous') renderTous();
  else renderPipelineTab();
}

/* ---- Onglet Agenda ---- */
function renderAgenda() {
  const { start, end } = rangeForPreset(AGENDA_PERIOD.preset, AGENDA_PERIOD.from, AGENDA_PERIOD.to, 'future');
  const items = state.prospects.filter(p => { if (!p.dateRdv) return false; const d = new Date(p.dateRdv); return !isNaN(d) && d >= start && d <= end; })
    .sort((a, b) => new Date(a.dateRdv) - new Date(b.dateRdv));
  const groups = {};
  items.forEach(p => { const k = dayKeyOf(p.dateRdv); (groups[k] = groups[k] || []).push(p); });
  const keys = Object.keys(groups).sort();
  const body = keys.length ? keys.map(k => {
    const label = new Date(k + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const rows = groups[k].map(p => `<div class="agenda-row">
      <span class="agenda-time">${rdvTime(p.dateRdv)}</span>
      <span class="agenda-name">${esc(p.nom)}</span>
      <span class="agenda-offre">${esc(p.offre || '—')}</span>
      <span class="badge badge-${STATUS_COLOR[p.statut]}">${esc(p.statut)}</span>
      <button class="btn btn-ghost btn-sm" data-view="${p.id}">Voir fiche</button>
    </div>`).join('');
    return `<div class="agenda-day"><div class="agenda-day-head">${label}</div>${rows}</div>`;
  }).join('') : `<div class="empty-state">${ICONS.chat}<p>Aucun RDV sur cette période.</p></div>`;

  $('#crm-tab').innerHTML = `
    <div class="card mb">${periodSelectorHTML(AGENDA_PERIOD, ['aujourdhui', 'demain', '7j', '30j', 'perso'])}</div>
    <div class="card">${body}</div>`;
  bindPeriod($('#crm-tab .period-selector'), AGENDA_PERIOD, renderAgenda);
  $$('#crm-tab [data-view]').forEach(b => b.onclick = () => prospectForm(state.prospects.find(x => x.id === b.dataset.view)));
}

/* ---- Onglet Pipeline (kanban 3 colonnes : Appel planifié / R2 / Acompte) ---- */
function renderPipelineTab() {
  $('#crm-tab').innerHTML = `
    <div class="count-line mb">Glisse une carte entre les colonnes pour changer de statut · clique pour ouvrir la fiche</div>
    <div class="kanban kanban-3" id="kanban"></div>`;
  renderKanban();
}
function renderKanban() {
  const board = $('#kanban');
  board.innerHTML = PIPELINE_STATUSES.map(s => {
    const items = state.prospects.filter(x => x.statut === s);
    const cards = items.map(x => `<div class="kcard" draggable="true" data-id="${x.id}">
      <div class="kcard-top"><span class="kcard-name">${esc(x.nom)}</span></div>
      <div class="kcard-meta">
        ${x.offre ? `<span>${esc(x.offre)}</span>` : ''}
        ${x.ecosystemeNom ? `<span class="muted">${esc(x.ecosystemeNom)}</span>` : ''}
        ${x.dateRdv ? `<span>RDV ${fmtDate(x.dateRdv)}${rdvTime(x.dateRdv) && rdvTime(x.dateRdv) !== '—' ? ' · ' + rdvTime(x.dateRdv) : ''}</span>` : ''}
        ${x.statut === 'Closé' ? `<span class="muted" style="font-size:11px">Collecté J ${eur(dealJourJ(x))}</span>` : ''}
      </div>
      <div class="kcard-foot"><span class="kcard-amount">${x.statut === 'Closé' && x.prix ? eur(x.prix) : '—'}</span><span class="muted" style="font-size:11px">${esc(x.contact || '')}</span></div>
    </div>`).join('') || '<div class="muted kempty" style="font-size:12px;padding:8px 6px">Dépose ici…</div>';
    return `<div class="kcol" data-status="${s}">
      <div class="kcol-head"><span class="kcol-title"><span class="dot" style="background:var(--${STATUS_VAR[STATUS_COLOR[s]]})"></span>${s}</span><span class="kcol-count">${items.length}</span></div>
      <div class="kcards">${cards}</div></div>`;
  }).join('');

  $$('#kanban .kcard').forEach(c => {
    c.onclick = () => prospectForm(state.prospects.find(x => x.id === c.dataset.id));
    c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
  });
  $$('#kanban .kcol').forEach(col => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop-over'));
    col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('drop-over'); changeStatus(e.dataTransfer.getData('text/plain'), col.dataset.status); });
  });
}

/* ---- Onglet Tous les prospects ---- */
function renderTous() {
  const f = TOUS;
  const sel = (v, c) => v === c ? 'selected' : '';
  const { start, end } = rangeForPreset(f.period.preset, f.period.from, f.period.to, 'past');
  const tousDate = (p) => p.dateRdv || p.dateClose || p.createdAt;
  let list = state.prospects.filter(p => {
    if (f.q && !p.nom.toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.statut !== 'Tous' && p.statut !== f.statut) return false;
    if (f.eco && p.ecosystemeId !== f.eco) return false;
    if (f.offre && p.offreId !== f.offre) return false;
    if (f.period.preset !== 'tout') { const d = new Date(tousDate(p)); if (isNaN(d) || d < start || d > end) return false; }
    return true;
  });
  const sk = f.sort.col, dir = f.sort.dir;
  const getv = (p) => {
    switch (sk) {
      case 'nom': return p.nom.toLowerCase();
      case 'eco': return (p.ecosystemeNom || '').toLowerCase();
      case 'offre': return (p.offre || '').toLowerCase();
      case 'statut': return p.statut;
      case 'prix': return Number(p.prix) || 0;
      case 'jourJ': return dealJourJ(p);
      case 'commission': return Number(p.commission) || 0;
      case 'dateRdv': return p.dateRdv ? new Date(p.dateRdv).getTime() : 0;
      case 'dateClose': return p.dateClose ? new Date(p.dateClose).getTime() : 0;
      default: return 0;
    }
  };
  list.sort((a, b) => { const av = getv(a), bv = getv(b); if (typeof av === 'string') return av < bv ? -dir : av > bv ? dir : 0; return (av - bv) * dir; });

  const cols = [['nom', 'Nom'], ['eco', 'Écosystème'], ['offre', 'Offre'], ['statut', 'Statut'], ['prix', 'Deal (€)'], ['jourJ', 'Collecté J'], ['commission', 'Commission'], ['dateRdv', 'Date RDV'], ['dateClose', 'Date close']];
  const arrow = (k) => f.sort.col === k ? (f.sort.dir < 0 ? ' ↓' : ' ↑') : '';
  const thead = cols.map(([k, l]) => `<th class="sortable ${f.sort.col === k ? 'sort-active' : ''}" data-sort="${k}">${l}${arrow(k)}</th>`).join('') + '<th class="t-right">Actions</th>';
  // Les data-label alimentent la bascule en cards sur mobile (CSS pur, voir .crm-table).
  const rows = list.length ? list.map(p => `<tr>
    <td class="t-strong" data-label="Nom">${esc(p.nom)}</td>
    <td class="muted" data-label="Écosystème">${esc(p.ecosystemeNom || '—')}</td>
    <td class="muted" data-label="Offre">${esc(p.offre || '—')}</td>
    <td data-label="Statut"><span class="badge badge-${STATUS_COLOR[p.statut]}">${esc(p.statut)}</span></td>
    <td class="t-right t-num" data-label="Deal">${p.statut === 'Closé' && p.prix ? eur(p.prix) : '—'}</td>
    <td class="t-right t-num" data-label="Collecté J" style="color:var(--rev)">${p.statut === 'Closé' && dealJourJ(p) ? eur(dealJourJ(p)) : '—'}</td>
    <td class="t-right t-num" data-label="Commission" style="color:var(--rev)">${p.statut === 'Closé' && p.commission ? eur(p.commission) : '—'}</td>
    <td data-label="Date RDV">${p.dateRdv ? fmtDate(p.dateRdv) : '—'}</td>
    <td data-label="Date close">${p.dateClose ? fmtDate(p.dateClose) : '—'}</td>
    <td class="t-right t-actions" style="white-space:nowrap">
      <button class="btn btn-ghost btn-sm" data-view="${p.id}">Voir</button>
      <button class="btn btn-ghost btn-sm" data-stat="${p.id}">Statut</button>
      <button class="btn btn-danger btn-sm" data-del="${p.id}">✕</button>
    </td></tr>`).join('') : `<tr class="crm-empty"><td colspan="10" class="muted" style="text-align:center;padding:30px">Aucun prospect ne correspond aux filtres.</td></tr>`;

  const offreOpts = state.offres.filter(o => !f.eco || o.ecosystemeId === f.eco);
  $('#crm-tab').innerHTML = `
    <div class="card">
      <div class="filters">
        <input class="input" id="t-q" placeholder="🔍 Rechercher par nom…" value="${esc(f.q)}" style="flex:2;min-width:160px">
        <select class="select" id="t-statut">${['Tous', ...STATUSES].map(o => `<option ${sel(o, f.statut)}>${o}</option>`).join('')}</select>
        <select class="select" id="t-eco"><option value="">Tous les écosystèmes</option>${state.ecosystemes.map(e => `<option value="${e.id}" ${sel(e.id, f.eco)}>${esc(e.nom)}</option>`).join('')}</select>
        <select class="select" id="t-offre"><option value="">Toutes les offres</option>${offreOpts.map(o => `<option value="${o.id}" ${sel(o.id, f.offre)}>${esc(o.nom)}</option>`).join('')}</select>
      </div>
      <div style="margin-top:12px">${periodSelectorHTML(f.period, ['aujourdhui', '7j', '30j', 'mois', '3mois', '6mois', 'annee', 'tout', 'perso'])}</div>
      <div class="count-line" style="margin-top:12px">${list.length} prospect${list.length > 1 ? 's' : ''} trouvé${list.length > 1 ? 's' : ''}</div>
      <div class="table-scroll" style="margin-top:8px"><table class="stat-table crm-table"><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;

  $('#t-q').addEventListener('input', () => { f.q = $('#t-q').value; renderTous(); });
  $('#t-statut').onchange = () => { f.statut = $('#t-statut').value; renderTous(); };
  $('#t-eco').onchange = () => { f.eco = $('#t-eco').value; f.offre = ''; renderTous(); };
  $('#t-offre').onchange = () => { f.offre = $('#t-offre').value; renderTous(); };
  bindPeriod($('#crm-tab .period-selector'), f.period, renderTous);
  $$('#crm-tab th.sortable').forEach(th => th.onclick = () => { const k = th.dataset.sort; if (f.sort.col === k) f.sort.dir *= -1; else { f.sort.col = k; f.sort.dir = ['nom', 'eco', 'offre', 'statut'].includes(k) ? 1 : -1; } renderTous(); });
  $$('#crm-tab [data-view]').forEach(b => b.onclick = () => prospectForm(state.prospects.find(x => x.id === b.dataset.view)));
  $$('#crm-tab [data-stat]').forEach(b => b.onclick = () => quickStatusModal(state.prospects.find(x => x.id === b.dataset.stat)));
  $$('#crm-tab [data-del]').forEach(b => b.onclick = () => {
    const p = state.prospects.find(x => x.id === b.dataset.del);
    openModal(`<h3>Supprimer définitivement ?</h3><p class="hint" style="margin-bottom:16px">« ${esc(p.nom)} » sera supprimé. Cette action est irréversible.</p><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-danger" id="del-c">Supprimer</button></div>`);
    $('#del-c').onclick = () => { deleteProspect(b.dataset.del); closeModal(); renderTous(); toast('Prospect supprimé'); };
  });
}

function quickStatusModal(p) {
  openModal(`<h3>Changer le statut</h3><p class="hint" style="margin-bottom:14px">${esc(p.nom)}</p>
    <div class="status-pick">${STATUSES.map(s => `<button class="btn btn-ghost ${s === p.statut ? 'active' : ''}" data-s="${s}">${s}</button>`).join('')}</div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Fermer</button></div>`);
  $$('.status-pick [data-s]').forEach(b => b.onclick = () => { const s = b.dataset.s; closeModal(); if (s !== p.statut) changeStatus(p.id, s); });
}

// Sauvegarde + re-render de l'onglet CRM actif
function saveAndSync(msg) {
  save();
  renderCRMTab();
  if (msg) toast(msg);
}

// Changement de statut (drag ou édition) avec prompts intelligents
function changeStatus(id, newStatus) {
  const p = state.prospects.find(x => x.id === id);
  if (!p || p.statut === newStatus) return;

  // Seul le passage en "Closé" déclenche la saisie du deal + plan de paiement
  if (newStatus === 'Closé') {
    openDealModal(p, 'Closé');
    return;
  }
  p.statut = newStatus;
  touch(p);
  if (newStatus === 'Perdu') {
    saveAndSync('Marqué comme perdu');
    openLostModal(p);
    return;
  }
  p.raisonPerte = '';
  saveAndSync('Statut mis à jour : ' + newStatus);
}

/* ---- Éditeur de plan de paiement (réutilisé dans plusieurs modals) ---- */
function planRowHTML(r) {
  r = r || {};
  return `<div class="plan-row">
    <input class="input plan-m" type="number" placeholder="Montant €" value="${r.montant != null && r.montant !== '' ? r.montant : ''}">
    <input class="input plan-d" type="date" value="${r.datePrevu || ''}" title="Date prévue">
    <div class="plan-recu-cell">
      <label class="plan-chk"><input type="checkbox" class="plan-r" ${r.dateRecu ? 'checked' : ''}> reçu</label>
      <input class="input plan-rd" type="date" value="${r.dateRecu || ''}" style="${r.dateRecu ? '' : 'visibility:hidden'}" title="Date de réception">
    </div>
    <button type="button" class="btn btn-ghost btn-sm plan-x" title="Retirer">✕</button>
  </div>`;
}
function readPlan(container) {
  return $$('.plan-row', container).map(row => {
    const montant = Number($('.plan-m', row).value) || 0;
    const datePrevu = $('.plan-d', row).value;
    const recu = $('.plan-r', row).checked;
    let dateRecu = $('.plan-rd', row).value;
    if (recu && !dateRecu) dateRecu = todayISO();
    return { montant, datePrevu, dateRecu: recu ? dateRecu : null, statut: recu ? 'reçu' : 'en attente' };
  }).filter(r => r.montant > 0 || r.datePrevu);
}
function wirePlan(container, getTaux, totalEl) {
  const update = () => {
    const rows = readPlan(container);
    const total = rows.reduce((s, r) => s + r.montant, 0);
    const recu = rows.filter(r => r.dateRecu).reduce((s, r) => s + r.montant, 0);
    const comm = Math.round(total * getTaux() / 100);
    if (totalEl) totalEl.innerHTML = `Total plan : <strong>${eur(total)}</strong> · déjà reçu <strong>${eur(recu)}</strong> · commission totale <strong style="color:var(--green)">${eur(comm)}</strong>`;
  };
  container.addEventListener('click', (e) => {
    if (e.target.closest('.plan-x')) { e.target.closest('.plan-row').remove(); update(); }
  });
  container.addEventListener('input', (e) => {
    if (e.target.classList.contains('plan-r')) {
      const row = e.target.closest('.plan-row');
      const rd = $('.plan-rd', row);
      if (e.target.checked) { rd.style.visibility = 'visible'; if (!rd.value) rd.value = todayISO(); }
      else { rd.style.visibility = 'hidden'; }
    }
    update();
  });
  container._update = update;
  update();
}

// Modal de close : c'est ICI seulement qu'on saisit prix, taux et plan de paiement
function openDealModal(p) {
  const offre = offreById(p.offreId);
  const defaultPrix = p.prix != null && p.prix !== '' ? p.prix : (offre ? offre.prix : '');
  const defaultTaux = p.tauxCommission != null ? p.tauxCommission : (offre ? offre.tauxCommission : 15);
  // Plan par défaut : paiement unique reçu le jour du close
  let plan = (p.paiements && p.paiements.length) ? p.paiements.slice() : [{ montant: defaultPrix || '', datePrevu: todayISO(), dateRecu: todayISO(), statut: 'reçu' }];

  openModal(`<h3>Closer le deal — ${esc(p.nom)} 🎉</h3>
    <div class="form-grid">
      <div class="field"><label>Prix total du deal (€)</label><input class="input" type="number" id="dl-prix" value="${defaultPrix}"></div>
      <div class="field"><label>Taux de commission (%)</label><input class="input" type="number" id="dl-taux" value="${defaultTaux}"></div>
      <div class="field full"><label>Date de close</label><input class="input" type="date" id="dl-date" value="${p.dateClose || todayISO()}"></div>
    </div>
    <div class="plan-head">
      <span class="card-title" style="font-size:13px">Plan de paiement</span>
      <div class="flex gap items-center">
        <button type="button" class="btn btn-ghost btn-sm" id="dl-once">Paiement en une fois</button>
        <button type="button" class="btn btn-ghost btn-sm" id="dl-addrow">${ICONS.plus} Échéance</button>
      </div>
    </div>
    <div id="dl-plan" class="plan-list">${plan.map(planRowHTML).join('')}</div>
    <div class="hint mt" id="dl-total"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-primary" id="dl-save">Valider la close</button></div>`, { wide: true });

  const cont = $('#dl-plan');
  const getTaux = () => Number($('#dl-taux').value) || 0;
  wirePlan(cont, getTaux, $('#dl-total'));
  $('#dl-addrow').onclick = () => { cont.insertAdjacentHTML('beforeend', planRowHTML({ datePrevu: '' })); cont._update(); };
  // Paiement en une fois : une échéance = prix total, reçue à la date de close
  $('#dl-once').onclick = () => { cont.innerHTML = planRowHTML({ montant: Number($('#dl-prix').value) || '', datePrevu: $('#dl-date').value || todayISO(), dateRecu: $('#dl-date').value || todayISO(), statut: 'reçu' }); cont._update(); };
  $('#dl-taux').addEventListener('input', () => cont._update());

  $('#dl-save').onclick = () => {
    p.prix = Number($('#dl-prix').value) || 0;
    p.tauxCommission = Number($('#dl-taux').value) || 0;
    p.dateClose = $('#dl-date').value || todayISO();
    p.paiements = readPlan(cont);
    p.statut = 'Closé';
    p.raisonPerte = '';
    p.commission = calcCommission(p);
    touch(p);
    closeModal();
    saveAndSync('Deal closé : ' + eur(p.prix) + ' · ' + eur(collectedCash(p)) + ' encaissé');
  };
}

// Modal optionnelle : raison de la perte
function openLostModal(p) {
  const opts = LOST_REASONS.map(o => `<option ${o === p.raisonPerte ? 'selected' : ''}>${o}</option>`).join('');
  openModal(`<h3>Prospect perdu — raison ?</h3>
    <p class="hint" style="margin-bottom:14px">Optionnel — note la raison pour ton suivi.</p>
    <div class="field"><label>Raison principale</label><select class="select" id="lost-reason"><option value="">— Non renseignée —</option>${opts}</select></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Passer</button><button class="btn btn-primary" id="lost-save">Enregistrer</button></div>`);
  $('#lost-save').onclick = () => {
    p.raisonPerte = $('#lost-reason').value;
    touch(p);
    closeModal();
    saveAndSync('Raison enregistrée');
  };
}

function prospectForm(existing) {
  const x = existing || {};
  const opt = (arr, sel) => arr.map(o => `<option ${o === sel ? 'selected' : ''}>${o}</option>`).join('');
  const lostOpts = LOST_REASONS.map(o => `<option ${o === x.raisonPerte ? 'selected' : ''}>${o}</option>`).join('');
  const isSigned = SIGNED_STATUSES.includes(x.statut);

  // Récapitulatif financier pour un prospect closé
  const summary = (existing && x.statut === 'Closé') ? `
    <div class="deal-summary">
      <div class="ds-item"><div class="ds-lbl">Deal total</div><div class="ds-val">${eur(x.prix || 0)}</div></div>
      <div class="ds-item"><div class="ds-lbl">CA collecté jour J</div><div class="ds-val" style="color:var(--rev)">${eur(dealJourJ(x))}</div></div>
      <div class="ds-item"><div class="ds-lbl">Reste à collecter</div><div class="ds-val" style="color:${resteACollecter(x) > 0 ? 'var(--orange)' : 'var(--text-3)'}">${eur(resteACollecter(x))}</div></div>
    </div>
    <div class="ds-plan-title">Plan de paiement</div>
    <div class="table-scroll"><table class="clean-table" style="margin-bottom:18px"><thead><tr><th class="t-right">Montant</th><th>Prévue</th><th>Reçue</th><th>Statut</th></tr></thead><tbody>
      ${(x.paiements || []).length ? x.paiements.map(pay => `<tr><td class="t-right t-num">${eur(pay.montant)}</td><td>${pay.datePrevu ? fmtDate(pay.datePrevu) : '—'}</td><td>${pay.dateRecu ? fmtDate(pay.dateRecu) : '—'}</td><td><span class="badge badge-${pay.dateRecu ? 'green' : 'gray'}">${pay.dateRecu ? 'reçu' : 'en attente'}</span></td></tr>`).join('') : '<tr><td colspan="4" class="muted" style="text-align:center;padding:12px">Aucune échéance</td></tr>'}
    </tbody></table></div>` : '';

  openModal(`<h3>${existing ? 'Modifier le prospect' : 'Nouveau prospect'}</h3>
    ${summary}
    <div class="form-grid">
      <div class="field full"><label>Nom</label><input class="input" id="f-nom" value="${esc(x.nom || '')}"></div>
      <div class="field"><label>Email</label><input class="input" type="email" id="f-email" value="${esc(x.email || '')}" placeholder="prenom@mail.com"></div>
      <div class="field"><label>Téléphone</label><input class="input" type="tel" id="f-tel" value="${esc(x.telephone || '')}" placeholder="06 12 34 56 78"></div>
      <div class="field"><label>Écosystème</label><select class="select" id="f-eco"></select></div>
      <div class="field"><label class="flex between items-center"><span>Offre</span><a href="#" id="f-manage-offres" class="link-accent">Gérer →</a></label><select class="select" id="f-offre"></select></div>
      <div class="field"><label>Mode de paiement</label><select class="select" id="f-mode"></select></div>
      <!-- Prix et taux proviennent de l'offre : champs cachés, alimentés automatiquement -->
      <input type="hidden" id="f-prix" value="${x.prix != null ? x.prix : ''}">
      <input type="hidden" id="f-taux" value="${x.tauxCommission != null ? x.tauxCommission : ''}">
      <div class="field"><label>Statut</label><select class="select" id="f-statut">${opt(STATUSES, x.statut || 'Appel planifié')}</select></div>
      <div class="field"><label>Date et heure du RDV</label><input class="input" type="datetime-local" id="f-rdv" value="${x.dateRdv ? (x.dateRdv.length <= 10 ? x.dateRdv + 'T09:00' : x.dateRdv.slice(0, 16)) : ''}"></div>
      <div class="field" id="f-closewrap" style="display:none"><label>Date de close</label><input class="input" type="date" id="f-dateclose" value="${x.dateClose || todayISO()}"></div>
      <div class="field full" id="f-lostwrap" style="display:none"><label>Raison de la perte</label><select class="select" id="f-lost"><option value="">— Non renseignée —</option>${lostOpts}</select></div>
      <div class="field full"><label>Notes</label><textarea class="textarea" id="f-notes" rows="2">${esc(x.notes || '')}</textarea></div>
    </div>
    <div id="f-planwrap" style="display:none">
      <div class="plan-head"><span class="card-title" style="font-size:13px">Plan de paiement</span><button type="button" class="btn btn-ghost btn-sm" id="f-addrow">${ICONS.plus} Échéance</button></div>
      <div id="f-plan" class="plan-list"></div>
      <div class="hint mt" id="f-total"></div>
    </div>
    <div class="modal-actions">
      ${existing ? '<button class="btn btn-danger" id="f-del">Supprimer</button>' : ''}
      <button class="btn btn-ghost" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" id="f-save">Enregistrer</button>
    </div>`, { wide: true });

  // --- Menus liés Écosystème / Offre ---
  const ecoSel = $('#f-eco'), offSel = $('#f-offre');
  ecoSel.innerHTML = `<option value="">— Aucun —</option>` +
    state.ecosystemes.map(e => `<option value="${e.id}" ${e.id === x.ecosystemeId ? 'selected' : ''}>${esc(e.nom)}</option>`).join('');
  function fillOffres(keepId) {
    const ecoId = ecoSel.value;
    const list = state.offres.filter(o => o.ecosystemeId === ecoId && (o.actif || o.id === keepId));
    offSel.innerHTML = `<option value="">— Aucune —</option>` +
      list.map(o => `<option value="${o.id}" ${o.id === keepId ? 'selected' : ''}>${esc(o.nom)} · ${eur(o.prix)}</option>`).join('');
  }
  // Remplit le menu "Mode de paiement" avec les modes définis sur l'offre choisie
  const modeSel = $('#f-mode');
  const fillModes = (keep) => {
    const o = offreById(offSel.value);
    const modes = o && Array.isArray(o.modesPaiement) ? o.modesPaiement : [];
    modeSel.innerHTML = `<option value="">— Aucun —</option>` +
      modes.map(m => `<option value="${esc(m)}" ${m === keep ? 'selected' : ''}>${esc(m)}</option>`).join('');
    if (keep && !modes.includes(keep)) modeSel.value = ''; // l'offre a changé, mode obsolète
  };
  // Reporte le prix / taux + les modes de paiement de l'offre choisie sur le formulaire
  const applyOffre = (keepMode) => {
    const o = offreById(offSel.value);
    if (o) { $('#f-prix').value = o.prix; $('#f-taux').value = o.tauxCommission; }
    fillModes(keepMode);
    refreshConditionals();
  };
  fillOffres(x.offreId);
  fillModes(x.modePaiement);
  ecoSel.onchange = () => {
    fillOffres();
    // Une seule offre active dans cet écosystème : aucun choix à faire, on la pré-remplit.
    const actives = state.offres.filter(o => o.ecosystemeId === ecoSel.value && o.actif);
    if (actives.length === 1) { offSel.value = actives[0].id; applyOffre(); }
    else fillModes();
  };
  // Changer d'offre met à jour prix/taux et la liste des modes de paiement
  offSel.onchange = () => applyOffre();
  $('#f-manage-offres').onclick = (e) => { e.preventDefault(); closeModal(); go('ecosystemes'); };

  const planCont = $('#f-plan');
  const getTaux = () => Number($('#f-taux').value) || 0;
  // Initialise le plan avec l'existant
  planCont.innerHTML = (x.paiements && x.paiements.length ? x.paiements : []).map(planRowHTML).join('');
  wirePlan(planCont, getTaux, $('#f-total'));
  $('#f-addrow').onclick = () => { planCont.insertAdjacentHTML('beforeend', planRowHTML({ datePrevu: '' })); planCont._update(); };

  const refreshConditionals = () => {
    const st = $('#f-statut').value;
    const signed = st === 'Closé'; // seul "Closé" porte des infos financières
    $('#f-closewrap').style.display = signed ? '' : 'none';
    $('#f-lostwrap').style.display = st === 'Perdu' ? '' : 'none';
    $('#f-planwrap').style.display = signed ? '' : 'none';
    // Si on passe en signé sans aucune échéance, propose une ligne par défaut (prix issu de l'offre)
    if (signed && !$$('.plan-row', planCont).length) {
      const prix = Number($('#f-prix').value) || '';
      planCont.insertAdjacentHTML('beforeend', planRowHTML({ montant: prix, datePrevu: $('#f-dateclose').value || todayISO(), dateRecu: null }));
    }
    planCont._update();
  };
  $('#f-statut').addEventListener('change', refreshConditionals);
  refreshConditionals();

  $('#f-save').onclick = () => {
    const nom = $('#f-nom').value.trim();
    if (!nom) { toast('Le nom est requis'); return; }
    const st = $('#f-statut').value;
    const isClose = st === 'Closé';
    const eco = ecoById($('#f-eco').value);
    const off = offreById($('#f-offre').value);
    // Infos financières uniquement si "Closé" — sinon on les vide (Acompte = pas de prix/plan/commission)
    const email = $('#f-email').value.trim();
    const telephone = $('#f-tel').value.trim();
    const data = {
      nom, email, telephone,
      // `contact` reste l'affichage synthétique (cartes kanban) ; on préserve un
      // identifiant historique (ex. « @insta ») si ni email ni téléphone ne sont saisis.
      contact: email || telephone || (x.contact || ''),
      ecosystemeId: eco ? eco.id : '', ecosystemeNom: eco ? eco.nom : '',
      offreId: off ? off.id : '', offreNom: off ? off.nom : '',
      offre: off ? off.nom : (x.offre || ''),
      modePaiement: $('#f-mode').value,
      // Prix et taux proviennent de l'offre sélectionnée (plus saisis à la main)
      prix: isClose ? (off ? off.prix : (x.prix != null ? x.prix : null)) : null,
      tauxCommission: isClose ? (off ? off.tauxCommission : (x.tauxCommission != null ? x.tauxCommission : null)) : null,
      statut: st, dateRdv: $('#f-rdv').value,
      notes: $('#f-notes').value.trim(),
      dateClose: isClose ? ($('#f-dateclose').value || todayISO()) : '',
      paiements: isClose ? readPlan(planCont) : [],
      raisonPerte: st === 'Perdu' ? $('#f-lost').value : ''
    };
    const target = existing || normalizeProspect({ createdAt: todayISO() });
    Object.assign(target, data);
    target.commission = calcCommission(target);
    touch(target); // toute modification réarme l'horloge d'archivage
    if (!existing) state.prospects.push(target);
    save(); closeModal(); renderCRMTab(); toast(existing ? 'Prospect mis à jour' : 'Prospect ajouté');
  };
  if (existing) $('#f-del').onclick = () => {
    state.prospects = state.prospects.filter(pr => pr.id !== existing.id);
    save(); closeModal(); renderCRMTab(); toast('Prospect supprimé');
  };
}

/* ==========================================================================
   PAGE — Écosystèmes & Offres
   ========================================================================== */
let CURRENT_ECO = null;
let ECO_CTX = 'page'; // 'page' (page dédiée) ou 'modal' (depuis le CRM)

// Contenu réutilisable (liste écosystèmes + offres) — identique pour la page et la modale
function ecoUIHtml() {
  const ecos = state.ecosystemes;
  if (!CURRENT_ECO || !ecoById(CURRENT_ECO)) CURRENT_ECO = ecos.length ? ecos[0].id : null;

  const ecoItems = ecos.length ? ecos.map(e => {
    const n = offresOf(e.id).length;
    return `<button class="eco-item ${e.id === CURRENT_ECO ? 'active' : ''}" data-eco="${e.id}">
      <div class="eco-item-name">${esc(e.nom)}</div>
      <div class="eco-item-sub">${n} offre${n > 1 ? 's' : ''}</div>
    </button>`;
  }).join('') : '<div class="muted" style="padding:18px 8px;font-size:13px">Aucun écosystème. Crée le premier.</div>';

  const eco = CURRENT_ECO ? ecoById(CURRENT_ECO) : null;
  const offs = eco ? offresOf(eco.id) : [];
  const offCards = offs.length ? offs.map(o => `<div class="offre-card ${o.actif ? '' : 'inactive'}">
    <div class="offre-head">
      <div><div class="offre-name">${esc(o.nom)}</div>${o.description ? `<div class="offre-desc">${esc(o.description)}</div>` : ''}</div>
      <span class="badge badge-${o.actif ? 'green' : 'gray'}">${o.actif ? 'Actif' : 'Inactif'}</span>
    </div>
    <div class="offre-meta">
      <span class="t-strong">${eur(o.prix)}</span>
      <span class="muted">${o.tauxCommission}% commission</span>
      <span style="color:var(--green);font-weight:600">${eur(Math.round(o.prix * o.tauxCommission / 100))} / vente</span>
    </div>
    <div class="offre-actions">
      <button class="btn btn-ghost btn-sm" data-edit-off="${o.id}">Modifier</button>
      <button class="btn btn-ghost btn-sm" data-arch-off="${o.id}">${o.actif ? 'Archiver' : 'Réactiver'}</button>
      <button class="btn btn-danger btn-sm" data-del-off="${o.id}">Supprimer</button>
    </div>
  </div>`).join('') : '<div class="empty-state">Aucune offre. Ajoute la première offre de cet écosystème.</div>';

  return `<div class="eco-wrap">
      <div class="card">
        <div class="card-head"><div class="card-title">Écosystèmes</div><button class="btn btn-primary btn-sm" id="eco-add">${ICONS.plus} Écosystème</button></div>
        <div class="eco-list">${ecoItems}</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">${eco ? esc(eco.nom) : 'Offres'}</div>${eco ? `<button class="btn btn-primary btn-sm" id="off-add">${ICONS.plus} Offre</button>` : ''}</div>
        <div class="offre-list">${offCards}</div>
      </div>
    </div>`;
}

// Attache les handlers dans un conteneur donné (page ou modale)
function wireEcoUI(root) {
  const eco = CURRENT_ECO ? ecoById(CURRENT_ECO) : null;
  $$('[data-eco]', root).forEach(b => b.onclick = () => { CURRENT_ECO = b.dataset.eco; ecoRerender(); });
  const ea = $('#eco-add', root); if (ea) ea.onclick = () => ecoForm();
  const oa = $('#off-add', root); if (oa && eco) oa.onclick = () => offreForm(eco.id);
  $$('[data-edit-off]', root).forEach(b => b.onclick = () => offreForm(eco.id, offreById(b.dataset.editOff)));
  $$('[data-arch-off]', root).forEach(b => b.onclick = () => {
    const o = offreById(b.dataset.archOff); o.actif = !o.actif; save(); ecoRerender(); toast(o.actif ? 'Offre réactivée' : 'Offre archivée');
  });
  $$('[data-del-off]', root).forEach(b => b.onclick = () => {
    const o = offreById(b.dataset.delOff);
    openModal(`<h3>Supprimer l'offre ?</h3><p class="hint" style="margin-bottom:16px">« ${esc(o.nom)} » sera supprimée. Les prospects déjà rattachés conservent leur historique.</p>
      <div class="modal-actions"><button class="btn btn-ghost" id="od-cancel">Annuler</button><button class="btn btn-danger" id="od-confirm">Supprimer</button></div>`);
    $('#od-cancel').onclick = ecoCancel;
    $('#od-confirm').onclick = () => { state.offres = state.offres.filter(z => z.id !== o.id); save(); ecoRerender(); toast('Offre supprimée'); };
  });
}

// Re-render / retour dans le contexte courant (page ou modale)
function ecoRerender() { if (ECO_CTX === 'modal') openGererOffres(); else { closeModal(); renderEcosystemes(); } }
function ecoCancel() { if (ECO_CTX === 'modal') openGererOffres(); else closeModal(); }

function renderEcosystemes() {
  ECO_CTX = 'page';
  $('#page-ecosystemes').innerHTML = `
    <div class="page-head"><div><h1 class="page-title">Écosystèmes &amp; Offres</h1><div class="page-subtitle">Organise tes offres par écosystème — connectées au pipeline et aux statistiques</div></div></div>
    ${ecoUIHtml()}`;
  wireEcoUI($('#page-ecosystemes'));
}

// Même contenu que la page, dans une modale (accessible depuis le CRM)
function openGererOffres() {
  ECO_CTX = 'modal';
  openModal(`<div class="flex between items-center" style="margin-bottom:16px"><h3 style="margin:0">Gérer les écosystèmes &amp; offres</h3><button class="btn btn-ghost btn-sm" onclick="closeModal()">Fermer</button></div>${ecoUIHtml()}`, { wide: true });
  wireEcoUI($('#modal'));
}

function ecoForm(existing) {
  const x = existing || {};
  openModal(`<h3>${existing ? "Modifier l'écosystème" : 'Nouvel écosystème'}</h3>
    <div class="field"><label>Nom</label><input class="input" id="eco-nom" value="${esc(x.nom || '')}" placeholder="Ex : John Doe Coaching"></div>
    <div class="field"><label>Description (optionnel)</label><textarea class="textarea" id="eco-desc" rows="3">${esc(x.description || '')}</textarea></div>
    <div class="modal-actions">${existing ? '<button class="btn btn-danger" id="eco-del">Supprimer</button>' : ''}<button class="btn btn-ghost" id="eco-cancel">Annuler</button><button class="btn btn-primary" id="eco-save">Enregistrer</button></div>`);
  $('#eco-cancel').onclick = ecoCancel;
  $('#eco-save').onclick = () => {
    const nom = $('#eco-nom').value.trim();
    if (!nom) { toast('Le nom est requis'); return; }
    if (existing) { existing.nom = nom; existing.description = $('#eco-desc').value.trim(); }
    else { const e = { id: uid(), nom, description: $('#eco-desc').value.trim(), createdAt: nowISO() }; state.ecosystemes.push(e); CURRENT_ECO = e.id; }
    save(); ecoRerender(); toast(existing ? 'Écosystème mis à jour' : 'Écosystème créé');
  };
  if (existing) $('#eco-del').onclick = () => {
    const nbOff = offresOf(existing.id).length;
    openModal(`<h3>Supprimer l'écosystème ?</h3><p class="hint" style="margin-bottom:16px">« ${esc(existing.nom)} » et ses ${nbOff} offre(s) seront supprimés.</p>
      <div class="modal-actions"><button class="btn btn-ghost" id="ed-cancel">Annuler</button><button class="btn btn-danger" id="ed-confirm">Supprimer</button></div>`);
    $('#ed-cancel').onclick = ecoCancel;
    $('#ed-confirm').onclick = () => {
      state.offres = state.offres.filter(o => o.ecosystemeId !== existing.id);
      state.ecosystemes = state.ecosystemes.filter(e => e.id !== existing.id);
      CURRENT_ECO = null; save(); ecoRerender(); toast('Écosystème supprimé');
    };
  };
}

const PAYMENT_MODE_PRESETS = ['1 fois', '2 fois', '3 fois', '4 fois', '6 fois', '12 fois'];

function offreForm(ecoId, existing) {
  const x = existing || {};
  const modes = Array.isArray(x.modesPaiement) ? x.modesPaiement : ['1 fois'];
  const customModes = modes.filter(m => !PAYMENT_MODE_PRESETS.includes(m));
  const modeChecks = PAYMENT_MODE_PRESETS.map(m => `<label class="chk-inline"><input type="checkbox" class="of-mode" value="${m}" ${modes.includes(m) ? 'checked' : ''}> ${m}</label>`).join('');
  openModal(`<h3>${existing ? "Modifier l'offre" : 'Nouvelle offre'}</h3>
    <div class="form-grid">
      <div class="field full"><label>Nom</label><input class="input" id="of-nom" value="${esc(x.nom || '')}" placeholder="Ex : Mastermind 6 mois"></div>
      <div class="field"><label>Prix (€)</label><input class="input" type="number" id="of-prix" value="${x.prix != null ? x.prix : ''}"></div>
      <div class="field"><label>Taux de commission (%)</label><input class="input" type="number" id="of-taux" value="${x.tauxCommission != null ? x.tauxCommission : 15}"></div>
      <div class="field full"><label>Modes de paiement disponibles</label><div class="chk-grid">${modeChecks}</div></div>
      <div class="field full"><label>Modes personnalisés (séparés par des virgules)</label><input class="input" id="of-custom" value="${esc(customModes.join(', '))}" placeholder="Ex : 5 fois, 10 fois"></div>
      <div class="field full"><label>Description (optionnel)</label><textarea class="textarea" id="of-desc" rows="2">${esc(x.description || '')}</textarea></div>
      <div class="field full"><label class="chk-row"><input type="checkbox" id="of-actif" ${x.actif !== false ? 'checked' : ''}> Offre active (disponible dans le pipeline)</label></div>
    </div>
    <div class="modal-actions"><button class="btn btn-ghost" id="of-cancel">Annuler</button><button class="btn btn-primary" id="of-save">Enregistrer</button></div>`);
  $('#of-cancel').onclick = ecoCancel;
  $('#of-save').onclick = () => {
    const nom = $('#of-nom').value.trim();
    if (!nom) { toast('Le nom est requis'); return; }
    const presetModes = $$('#modal .of-mode').filter(c => c.checked).map(c => c.value);
    const custom = $('#of-custom').value.split(',').map(s => s.trim()).filter(Boolean);
    // Ordonne selon les presets puis les personnalisés, sans doublon.
    const modesPaiement = [...PAYMENT_MODE_PRESETS.filter(m => presetModes.includes(m)), ...custom.filter(m => !PAYMENT_MODE_PRESETS.includes(m))];
    const data = { nom, prix: Number($('#of-prix').value) || 0, tauxCommission: Number($('#of-taux').value) || 0, modesPaiement, description: $('#of-desc').value.trim(), actif: $('#of-actif').checked };
    if (existing) Object.assign(existing, data);
    else state.offres.push({ id: uid(), ecosystemeId: ecoId, ...data, createdAt: nowISO() });
    save(); ecoRerender(); toast(existing ? 'Offre mise à jour' : 'Offre créée');
  };
}

/* ==========================================================================
   PAGE — Statistiques
   ========================================================================== */
const STATS_FILTERS = { preset: 'tout', from: '', to: '', eco: '', offre: '', statut: 'Tous' };
const STAT_STATUT_MAP = { 'Closés': 'Closé', 'Acompte': 'Acompte', 'Perdus': 'Perdu', 'No show': 'No show', 'Annulés': 'Annulé' };

const statDate = (p) => p.dateClose || p.dateRdv || p.createdAt;
function statInPeriod(p) {
  if (STATS_FILTERS.preset === 'tout') return true;
  const ref = statDate(p);
  if (!ref) return false;
  const { start, end } = periodBounds();
  const dt = new Date(ref);
  return !isNaN(dt) && dt >= start && dt <= end;
}
function statsBase() {
  const f = STATS_FILTERS;
  return state.prospects.filter(p => {
    if (f.eco && p.ecosystemeId !== f.eco) return false;
    if (f.offre && p.offreId !== f.offre) return false;
    if (f.statut !== 'Tous' && p.statut !== STAT_STATUT_MAP[f.statut]) return false;
    return statInPeriod(p);
  });
}
function statAggregate(ps) {
  const honored = ps.filter(p => HONORED_STATUSES.includes(p.statut));
  const closed = ps.filter(p => p.statut === 'Closé');
  const signed = ps.filter(p => SIGNED_STATUSES.includes(p.statut));
  const caContracte = signed.reduce((s, p) => s + (Number(p.prix) || 0), 0);
  const caCollecte = signed.reduce((s, p) => s + collectedCash(p), 0);
  const jourJ = signed.reduce((s, p) => s + dealJourJ(p), 0);
  const commGen = signed.reduce((s, p) => s + (Number(p.commission) || 0), 0);
  const commEnc = allPayments(signed).filter(x => x.dateRecu).reduce((s, x) => s + x.commission, 0);
  return {
    nb: ps.length, nbHonored: honored.length, nbClosed: closed.length,
    tauxH: honored.length ? Math.round(closed.length / honored.length * 100) : 0,
    tauxT: ps.length ? Math.round(closed.length / ps.length * 100) : 0,
    caContracte, caCollecte, jourJ, commGen, commEnc,
    tauxEncaisse: caContracte ? Math.round(jourJ / caContracte * 100) : 0,
    dealMoyen: signed.length ? Math.round(caContracte / signed.length) : 0,
    noShow: ps.filter(p => p.statut === 'No show').length,
    annule: ps.filter(p => p.statut === 'Annulé').length,
    perdu: ps.filter(p => p.statut === 'Perdu').length
  };
}
const STATS_SORT = { col: 'caContracte', dir: -1 };
let STATS_CHARTS = [];
function destroyStatsCharts() { STATS_CHARTS.forEach(c => { try { c.destroy(); } catch (e) { /* ignore */ } }); STATS_CHARTS = []; }

// Bornes de la période sélectionnée via le sélecteur universel (rétrospectif)
function periodBounds() {
  return rangeForPreset(STATS_FILTERS.preset, STATS_FILTERS.from, STATS_FILTERS.to, 'past');
}
// Pool filtré par écosystème / offre / statut (sans la contrainte de période)
function statsFilterPool() {
  const f = STATS_FILTERS;
  return state.prospects.filter(p => {
    if (f.eco && p.ecosystemeId !== f.eco) return false;
    if (f.offre && p.offreId !== f.offre) return false;
    if (f.statut !== 'Tous' && p.statut !== STAT_STATUT_MAP[f.statut]) return false;
    return true;
  });
}
function last12Months() {
  const out = [], now = new Date();
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ key: dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'), label: dt.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }).replace('.', '') });
  }
  return out;
}

const ECO_PALETTE = ['#E85D2F', '#3B82C4', '#2EA36B', '#7C5CC4', '#E8932F', '#DB5050', '#C9A227'];

/* ==========================================================================
   Sélecteur de période universel (réutilisé : Agenda, Tous les prospects, Stats)
   Toujours calculé via new Date(), aucune date codée en dur.
   ========================================================================== */
const PERIOD_LABELS = {
  aujourdhui: "Aujourd'hui", demain: 'Demain', '7j': '7 jours', '30j': '30 jours',
  mois: 'Ce mois', '3mois': '3 mois', '6mois': '6 mois', annee: 'Cette année', tout: 'Tout', perso: 'Personnalisé'
};
const _dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const _dayEnd = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const _addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// Retourne {start, end} pour un preset. dir='future' = à venir (agenda), sinon rétrospectif.
function rangeForPreset(preset, from, to, dir) {
  const now = new Date();
  switch (preset) {
    case 'aujourdhui': return { start: _dayStart(now), end: _dayEnd(now) };
    case 'demain': { const t = _addDays(now, 1); return { start: _dayStart(t), end: _dayEnd(t) }; }
    case '7j': return dir === 'future' ? { start: _dayStart(now), end: _dayEnd(_addDays(now, 7)) } : { start: _dayStart(_addDays(now, -7)), end: _dayEnd(now) };
    case '30j': return dir === 'future' ? { start: _dayStart(now), end: _dayEnd(_addDays(now, 30)) } : { start: _dayStart(_addDays(now, -30)), end: _dayEnd(now) };
    case 'mois': return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: _dayEnd(now) };
    case '3mois': return { start: _dayStart(_addDays(now, -92)), end: _dayEnd(now) };
    case '6mois': return { start: _dayStart(_addDays(now, -184)), end: _dayEnd(now) };
    case 'annee': return { start: new Date(now.getFullYear(), 0, 1), end: _dayEnd(now) };
    case 'perso': return { start: from ? new Date(from) : new Date(0), end: to ? _dayEnd(new Date(to)) : _dayEnd(now) };
    default: return { start: new Date(0), end: new Date(8640000000000000) }; // tout
  }
}
// st = { preset, from, to }
function periodSelectorHTML(st, presets) {
  const btns = presets.map(p => `<button class="period-btn ${st.preset === p ? 'active' : ''}" data-pp="${p}">${PERIOD_LABELS[p]}</button>`).join('');
  const custom = st.preset === 'perso'
    ? `<span class="period-custom"><input type="date" class="input period-from" value="${st.from || ''}"><span class="muted">→</span><input type="date" class="input period-to" value="${st.to || ''}"></span>` : '';
  return `<div class="period-selector">${btns}${custom}</div>`;
}
function bindPeriod(rootEl, st, onChange) {
  if (!rootEl) return;
  $$('.period-btn', rootEl).forEach(b => b.onclick = () => { st.preset = b.dataset.pp; onChange(); });
  const f = $('.period-from', rootEl), t = $('.period-to', rootEl);
  if (f) f.onchange = () => { st.from = f.value; onChange(); };
  if (t) t.onchange = () => { st.to = t.value; onChange(); };
}

function renderStats() {
  const f = STATS_FILTERS;
  const sel = (v, c) => v === c ? 'selected' : '';
  const base = statsBase();
  const pool = statsFilterPool();
  const { start, end } = periodBounds();
  const { nv, rec } = classifyPayments(pool, start, end);
  const finAll = financials(pool);
  const rates = closingRates(base);
  const totalColl = nv.collecte + rec.collecte;
  const dealMoyenNv = nv.nbCloses ? Math.round(nv.contracte / nv.nbCloses) : 0;

  // ---- Tableau (une ligne par offre) ----
  const offersToShow = state.offres.filter(o => (!f.eco || o.ecosystemeId === f.eco) && (!f.offre || o.id === f.offre));
  let rows = offersToShow.map(o => ({ offre: o, eco: (ecoById(o.ecosystemeId) || {}).nom || '—', agg: statAggregate(base.filter(p => p.offreId === o.id)) }));
  const sansOffre = base.filter(p => !p.offreId);
  if (sansOffre.length && !f.offre) rows.push({ offre: null, eco: '—', agg: statAggregate(sansOffre) });
  const sk = STATS_SORT.col, dir = STATS_SORT.dir;
  rows.sort((a, b) => {
    if (sk === 'name') { const an = a.offre ? a.offre.nom.toLowerCase() : '~', bn = b.offre ? b.offre.nom.toLowerCase() : '~'; return an < bn ? -dir : an > bn ? dir : 0; }
    return ((a.agg[sk] || 0) - (b.agg[sk] || 0)) * dir;
  });
  const totals = statAggregate(base);

  const cols = [
    { k: 'name', l: 'Offre', cls: '' },
    { k: 'nb', l: 'Prospects', cls: 't-right' },
    { k: 'nbHonored', l: 'RDV honorés', cls: 't-right' },
    { k: 'nbClosed', l: 'Closés', cls: 't-right' },
    { k: 'tauxH', l: 'Taux closing', cls: 't-right' },
    { k: 'caContracte', l: 'CA contracté', cls: 't-right' },
    { k: 'jourJ', l: 'CA collecté J', cls: 't-right' },
    { k: 'tauxEncaisse', l: "Taux d'encaissé", cls: 't-right' }
  ];
  const arrow = (k) => STATS_SORT.col === k ? (STATS_SORT.dir < 0 ? ' ↓' : ' ↑') : '';
  const thead = cols.map(c => `<th class="${c.cls} sortable ${STATS_SORT.col === c.k ? 'sort-active' : ''}" data-sort="${c.k}">${c.l}${arrow(c.k)}</th>`).join('');
  const encColor = (t) => t > 70 ? 'var(--rev)' : t > 40 ? 'var(--orange)' : 'var(--red)';
  const rowHTML = (name, eco, a, isTotal) => `<tr class="${isTotal ? 'stat-total' : ''}">
    <td><div class="t-strong">${name}</div>${eco ? `<div class="muted" style="font-size:11px">${eco}</div>` : ''}</td>
    <td class="t-right">${a.nb}</td><td class="t-right">${a.nbHonored}</td><td class="t-right">${a.nbClosed}</td>
    <td class="t-right">${a.tauxH}%</td>
    <td class="t-right"><span class="stat-ca">${eur(a.caContracte)}</span></td>
    <td class="t-right t-num" style="color:var(--rev)">${eur(a.jourJ)}</td>
    <td class="t-right t-num" style="color:${a.caContracte ? encColor(a.tauxEncaisse) : 'var(--text-3)'};font-weight:700">${a.caContracte ? a.tauxEncaisse + '%' : '—'}</td>
  </tr>`;
  const tableRows = rows.length
    ? rows.map(r => rowHTML(esc(r.offre ? r.offre.nom : 'Sans offre'), esc(r.offre ? r.eco : ''), r.agg, false)).join('') + rowHTML('TOTAL', '', totals, true)
    : '<tr><td colspan="9" class="muted" style="text-align:center;padding:30px">Aucune donnée pour ces filtres.</td></tr>';

  const offreOpts = state.offres.filter(o => !f.eco || o.ecosystemeId === f.eco);
  const kchart = window.Chart ? '' : '<div class="muted" style="padding:30px;text-align:center">Graphiques indisponibles (Chart.js non chargé).</div>';

  // Taux de closing — 6 derniers mois, cercles de progression
  const now6 = new Date();
  const months6 = [];
  for (let i = 5; i >= 0; i--) { const dt = new Date(now6.getFullYear(), now6.getMonth() - i, 1); months6.push({ key: dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'), label: dt.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', ''), current: i === 0 }); }
  const circles = months6.map(m => {
    const ps = pool.filter(p => monthKey(statDate(p)) === m.key);
    const honored = ps.filter(p => HONORED_STATUSES.includes(p.statut)).length;
    const closed = ps.filter(p => p.statut === 'Closé').length;
    const pct = honored ? Math.round(closed / honored * 100) : 0;
    return progressCircle(pct, closed, honored, m.label, m.current);
  }).join('');

  $('#page-stats').innerHTML = `
    <div class="page-head"><div><h1 class="page-title">Statistiques</h1><div class="page-subtitle">Contracté vs collecté — l'essentiel, en clair</div></div></div>

    <div class="card mb">
      <div class="filters">
        <select class="select" id="st-eco"><option value="">Tous les écosystèmes</option>${state.ecosystemes.map(e => `<option value="${e.id}" ${sel(e.id, f.eco)}>${esc(e.nom)}</option>`).join('')}</select>
        <select class="select" id="st-offre"><option value="">Toutes les offres</option>${offreOpts.map(o => `<option value="${o.id}" ${sel(o.id, f.offre)}>${esc(o.nom)}</option>`).join('')}</select>
      </div>
      <div style="margin-top:12px">${periodSelectorHTML(f, ['aujourdhui', '7j', '30j', 'mois', '3mois', '6mois', 'annee', 'tout', 'perso'])}</div>
    </div>

    <div class="stat-blocks mb">
      <div class="stat-block sb-contracte">
        <div class="sb-head"><span class="sb-title">CA Contracté</span><span class="sb-sub">ce qui a été signé sur la période</span></div>
        <div class="sb-grid">
          <div class="sb-item lead"><div class="sb-val">${eur(nv.contracte)}</div><div class="sb-lbl">CA contracté</div></div>
          <div class="sb-item"><div class="sb-val">${nv.nbCloses}</div><div class="sb-lbl">Closes</div></div>
          <div class="sb-item"><div class="sb-val">${eur(dealMoyenNv)}</div><div class="sb-lbl">Deal moyen</div></div>
          <div class="sb-item"><div class="sb-val">${rates.honored}%</div><div class="sb-lbl">Taux closing (honorés)</div></div>
          <div class="sb-item"><div class="sb-val">${rates.total}%</div><div class="sb-lbl">Taux closing (total)</div></div>
        </div>
      </div>
      <div class="stat-block sb-collecte">
        <div class="sb-head"><span class="sb-title">CA Collecté</span><span class="sb-sub">ce qui a été encaissé sur la période</span></div>
        <div class="sb-grid">
          <div class="sb-item lead"><div class="sb-val">${eur(totalColl)}</div><div class="sb-lbl">CA collecté total</div></div>
          <div class="sb-item"><div class="sb-val">${eur(nv.collecte)}</div><div class="sb-lbl">Dont nouveaux closes</div></div>
          <div class="sb-item"><div class="sb-val">${eur(rec.collecte)}</div><div class="sb-lbl">Dont récurrents</div></div>
          <div class="sb-item"><div class="sb-val">${eur(finAll.cashACollecter)}</div><div class="sb-lbl">Encore à collecter</div></div>
        </div>
      </div>
    </div>

    <div class="card mb">
      <div class="card-head"><div class="card-title">Détail par offre</div><div class="card-sub">Clique une colonne pour trier</div></div>
      <div class="table-scroll"><table class="stat-table"><thead><tr>${thead}</tr></thead><tbody>${tableRows}</tbody></table></div>
    </div>

    <div class="grid grid-2 mb">
      <div class="card"><div class="card-head"><div class="card-title">CA contracté par mois</div><div class="card-sub">12 derniers mois</div></div><div class="chart-box">${kchart || '<canvas id="st-c-contr"></canvas>'}</div></div>
      <div class="card"><div class="card-head"><div class="card-title">CA collecté par mois</div><div class="card-sub">Nouveaux closes + récurrents</div></div><div class="chart-box">${kchart || '<canvas id="st-c-coll"></canvas>'}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><div class="card-title">Taux de closing par mois</div><div class="card-sub">6 derniers mois · closés / RDV honorés</div></div>
      <div class="taux-circles">${circles}</div>
    </div>`;

  bindPeriod($('#page-stats .period-selector'), STATS_FILTERS, renderStats);
  $('#st-eco').onchange = () => { STATS_FILTERS.eco = $('#st-eco').value; STATS_FILTERS.offre = ''; renderStats(); };
  $('#st-offre').onchange = () => { STATS_FILTERS.offre = $('#st-offre').value; renderStats(); };
  $$('#page-stats th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    if (STATS_SORT.col === k) STATS_SORT.dir *= -1;
    else { STATS_SORT.col = k; STATS_SORT.dir = k === 'name' ? 1 : -1; }
    renderStats();
  });

  buildStatsCharts(pool);
}

// 3 graphiques : CA contracté (barres), CA collecté empilé, taux de closing (courbe + moyenne)
function buildStatsCharts(pool) {
  destroyStatsCharts();
  if (!window.Chart) return;
  const months = last12Months();
  const labels = months.map(m => m.label);
  const eurTick = (v) => (v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : v) + '€';
  const grid = '#ECEAE5';

  const series = months.map(m => {
    const [y, mo] = m.key.split('-').map(Number);
    const st = new Date(y, mo - 1, 1), en = new Date(y, mo, 0, 23, 59, 59);
    const signedM = signedProspects(pool).filter(p => p.dateClose && new Date(p.dateClose) >= st && new Date(p.dateClose) <= en);
    const contr = signedM.reduce((s, p) => s + (Number(p.prix) || 0), 0);
    const nbC = signedM.length;
    const { nv, rec } = classifyPayments(pool, st, en);
    const ps = pool.filter(p => monthKey(statDate(p)) === m.key);
    const hon = ps.filter(p => HONORED_STATUSES.includes(p.statut)).length;
    const cl = ps.filter(p => p.statut === 'Closé').length;
    return { contr, nbC, dealMoyen: nbC ? Math.round(contr / nbC) : 0, collNv: nv.collecte, collRec: rec.collecte, taux: hon ? Math.round(cl / hon * 100) : 0 };
  });

  // Plugin : valeur au-dessus des barres (graphique 1 uniquement)
  const valTop = {
    id: 'valTop',
    afterDatasetsDraw(ch) {
      const { ctx } = ch; const meta = ch.getDatasetMeta(0);
      ctx.save(); ctx.font = '600 10px Inter'; ctx.fillStyle = '#5C5950'; ctx.textAlign = 'center';
      meta.data.forEach((bar, i) => { const v = ch.data.datasets[0].data[i]; if (v) ctx.fillText(eurTick(v), bar.x, bar.y - 5); });
      ctx.restore();
    }
  };

  // 1 — CA contracté (barres)
  const c1 = $('#st-c-contr');
  if (c1) STATS_CHARTS.push(new Chart(c1, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'CA contracté', data: series.map(s => s.contr), backgroundColor: '#E85D2F', borderRadius: 6, maxBarThickness: 34 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, layout: { padding: { top: 16 } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => { const s = series[c.dataIndex]; return [` CA contracté : ${eur(s.contr)}`, ` ${s.nbC} close${s.nbC > 1 ? 's' : ''} · deal moyen ${eur(s.dealMoyen)}`]; } } } },
      scales: { x: { grid: { display: false }, ticks: { font: { size: 11 } } }, y: { beginAtZero: true, grid: { color: grid }, ticks: { callback: eurTick, font: { size: 11 } } } }
    },
    plugins: [valTop]
  }));

  // 2 — CA collecté (barres empilées)
  const c2 = $('#st-c-coll');
  if (c2) STATS_CHARTS.push(new Chart(c2, {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Nouveaux closes', data: series.map(s => s.collNv), backgroundColor: '#E85D2F', borderRadius: 4, maxBarThickness: 34, stack: 'c' },
      { label: 'Récurrents', data: series.map(s => s.collRec), backgroundColor: '#3B82C4', borderRadius: 4, maxBarThickness: 34, stack: 'c' }
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} : ${eur(c.parsed.y)}`, footer: (items) => 'Total : ' + eur(items.reduce((a, b) => a + b.parsed.y, 0)) } } },
      scales: { x: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } }, y: { stacked: true, beginAtZero: true, grid: { color: grid }, ticks: { callback: eurTick, font: { size: 11 } } } }
    }
  }));

  // (le taux de closing est désormais affiché en cercles de progression, hors Chart.js)
}

// Cercle de progression SVG (donut fin) pour le taux de closing mensuel
function progressCircle(pct, closed, honored, label, current) {
  const size = current ? 92 : 80, r = current ? 38 : 33, sw = 6;
  const c = 2 * Math.PI * r, arc = Math.max(0, Math.min(100, pct)) / 100 * c;
  const color = pct >= 30 ? '#16a34a' : pct >= 15 ? '#E8932F' : '#DB5050';
  return `<div class="taux-circle ${current ? 'current' : ''}">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#F0EDE8" stroke-width="${sw}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${arc} ${c - arc}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="${size / 2}" y="${size / 2 + 1}" text-anchor="middle" dominant-baseline="middle" font-size="${current ? 20 : 17}" font-weight="800" fill="var(--text)">${pct}%</text>
    </svg>
    <div class="taux-month ${current ? 'current' : ''}">${label}</div>
    <div class="taux-ratio">${closed}/${honored}</div>
  </div>`;
}

/* ==========================================================================
   PAGE 6 — Commissions
   ========================================================================== */
const COMM_HIST = { preset: 'tout' };

function renderCommissions() {
  const fin = financials();
  const now = new Date();
  const mk = monthKey(todayISO());
  const moisStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const moisLabel = now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const { nv, rec } = classifyPayments(state.prospects, moisStart, now);
  const encaisseesMois = nv.comm + rec.comm;
  const jourJComm = nv.comm; // "jour J" = 1er versement reçu le jour du close

  const inMonth = (iso) => { const d = new Date(iso); return d >= moisStart && d <= now; };

  // Sous-section A : deals closés ce mois — colonnes "payé aujourd'hui" / "comm." = jour J uniquement
  const newDeals = signedProspects().filter(p => p.dateClose && monthKey(p.dateClose) === mk);
  const aRows = newDeals.length ? newDeals.map(p => {
    const first = (p.paiements || [])[0];
    const jj = first && isJourJ(p, first, 0);
    const payeJour = jj ? (Number(first.montant) || 0) : 0;
    const commEnc = jj ? payCommission(p, first) : 0;
    return `<tr><td class="t-strong">${esc(p.nom)}</td><td class="muted">${esc(p.offre || '—')}</td><td class="t-right t-num">${eur(p.prix)}</td><td class="t-right t-num">${eur(payeJour)}</td><td class="t-right t-num" style="color:${C_COMM}">${eur(commEnc)}</td><td>${fmtDate(p.dateClose)}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:18px">Aucun nouveau close ce mois</td></tr>';

  // Sous-section B : tous les paiements reçus ce mois QUI NE SONT PAS jour J (échéances différées + deals antérieurs)
  const recPays = [];
  signedProspects().forEach(p => (p.paiements || []).forEach((pay, idx) => { if (pay.dateRecu && inMonth(pay.dateRecu) && !isJourJ(p, pay, idx)) recPays.push({ p, pay }); }));
  recPays.sort((a, b) => new Date(b.pay.dateRecu) - new Date(a.pay.dateRecu));
  const bRows = recPays.length ? recPays.map(x => `<tr><td class="t-strong">${esc(x.p.nom)}</td><td class="muted">${esc(x.p.offre || '—')}</td><td class="t-right t-num">${eur(x.pay.montant)}</td><td class="t-right t-num" style="color:${C_COMM}">${eur(payCommission(x.p, x.pay))}</td><td>${fmtDate(x.pay.dateRecu)}</td><td class="muted">${eur(x.p.prix)} · ${fmtDate(x.p.dateClose)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:18px">Aucun paiement récurrent ce mois</td></tr>';

  // Prochains encaissements
  const upcoming = allPayments().filter(x => !x.dateRecu).sort((a, b) => new Date(a.datePrevu || '2999') - new Date(b.datePrevu || '2999'));
  const upRows = upcoming.length ? upcoming.map(x => `<div class="enc-item">
    <div class="enc-left"><div class="enc-date">${x.datePrevu ? fmtDate(x.datePrevu) : 'à planifier'}</div><div class="enc-name">${esc(x.prospect.nom)}</div></div>
    <div class="enc-right"><div class="t-num enc-amt">${eur(x.montant)}</div><div class="enc-comm" style="color:${C_COMM}">${eur(x.commission)}</div></div>
    <button class="btn btn-ghost btn-sm enc-mark" data-id="${x.prospect.id}" data-idx="${x.idx}">Marquer reçu</button>
  </div>`).join('') : '<div class="muted" style="padding:16px 0">Aucun encaissement à venir 🎉</div>';

  // Historique complet (paiements reçus)
  const received = [];
  signedProspects().forEach(p => (p.paiements || []).forEach((pay, idx) => { if (pay.dateRecu) received.push({ p, pay, comm: payCommission(p, pay), jourJ: isJourJ(p, pay, idx) }); }));
  received.sort((a, b) => new Date(b.pay.dateRecu) - new Date(a.pay.dateRecu));
  const { start: hs, end: he } = rangeForPreset(COMM_HIST.preset, '', '', 'past');
  const hist = received.filter(r => COMM_HIST.preset === 'tout' || (new Date(r.pay.dateRecu) >= hs && new Date(r.pay.dateRecu) <= he));
  const histRows = hist.length ? hist.map(r => `<tr>
    <td>${fmtDate(r.pay.dateRecu)}</td><td class="t-strong">${esc(r.p.nom)}</td><td class="muted">${esc(r.p.offre || '—')}</td>
    <td><span class="badge badge-${r.jourJ ? 'green' : 'blue'}">${r.jourJ ? 'Jour J' : 'Récurrent'}</span></td>
    <td class="t-right t-num">${eur(r.pay.montant)}</td><td class="t-right t-num" style="color:${C_COMM}">${eur(r.comm)}</td>
  </tr>`).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">Aucune commission encaissée sur cette période</td></tr>';
  const histTotal = hist.reduce((s, r) => s + r.comm, 0);

  const hp = [['mois', 'Ce mois'], ['3mois', '3 mois'], ['6mois', '6 mois'], ['tout', 'Tout']];

  $('#page-commissions').innerHTML = `
    <div class="page-head"><div><h1 class="page-title">Commissions</h1><div class="page-subtitle" style="text-transform:capitalize">${moisLabel}</div></div></div>

    <div class="grid grid-4 sec">
      ${kpiCard('Encaissées ce mois', eur(Math.round(encaisseesMois)), C_REV, 'Total reçu sur le mois')}
      ${kpiCard('Dont jour J', eur(Math.round(jourJComm)), 'var(--text)', 'Encaissé au moment du close')}
      ${kpiCard('Dont récurrents', eur(Math.round(rec.comm)), 'var(--text)', 'Paiements différés reçus ce mois')}
      ${kpiCard('À venir', eur(Math.round(fin.commEnAttente)), C_COMM, 'Sur paiements planifiés')}
    </div>

    <div class="grid grid-55 sec">
      <div class="card">
        <div class="kpic-label">Commissions ce mois</div>
        <div class="sub-label">Nouveaux closes</div>
        <div class="table-scroll"><table class="clean-table"><thead><tr><th>Nom</th><th>Offre</th><th class="t-right">Deal total</th><th class="t-right">Payé aujourd'hui</th><th class="t-right">Comm. encaissée</th><th>Date</th></tr></thead><tbody>${aRows}</tbody></table></div>
        <div class="sub-label" style="margin-top:22px">Paiements récurrents reçus</div>
        <div class="table-scroll"><table class="clean-table"><thead><tr><th>Nom</th><th>Offre</th><th class="t-right">Montant reçu</th><th class="t-right">Commission</th><th>Date reçu</th><th>Deal original</th></tr></thead><tbody>${bRows}</tbody></table></div>
        <div class="cons-line"><span>Commission totale encaissée ce mois</span><span class="t-num" style="color:${C_REV};font-weight:700">${eur(Math.round(encaisseesMois))}</span></div>
      </div>
      <div class="card">
        <div class="kpic-label">Prochains encaissements</div>
        <div style="margin-top:8px">${upRows}</div>
      </div>
    </div>

    <div class="card">
      <div class="flex between items-center" style="margin-bottom:14px">
        <div class="kpic-label">Historique des commissions</div>
        <div class="flex gap items-center">
          <div class="period-selector">${hp.map(([k, l]) => `<button class="period-btn ${COMM_HIST.preset === k ? 'active' : ''}" data-hp="${k}">${l}</button>`).join('')}</div>
          <button class="btn btn-ghost btn-sm" id="cm-export">${ICONS.trend} Export CSV</button>
        </div>
      </div>
      <div class="table-scroll"><table class="clean-table"><thead><tr><th>Date</th><th>Nom</th><th>Offre</th><th>Type</th><th class="t-right">Montant encaissé</th><th class="t-right">Commission</th></tr></thead>
        <tbody>${histRows}</tbody>
        <tfoot><tr class="row-total"><td colspan="5" class="t-strong">Total (${hist.length})</td><td class="t-right t-num" style="color:${C_REV}">${eur(Math.round(histTotal))}</td></tr></tfoot>
      </table></div>
    </div>`;

  $('#cm-export').onclick = exportCommissionsCSV;
  $$('#page-commissions .enc-mark').forEach(b => b.onclick = () => markPaymentReceived(b.dataset.id, Number(b.dataset.idx)));
  $$('#page-commissions [data-hp]').forEach(b => b.onclick = () => { COMM_HIST.preset = b.dataset.hp; renderCommissions(); });
}

function markPaymentReceived(prospectId, idx) {
  const p = state.prospects.find(x => x.id === prospectId);
  if (!p || !p.paiements || !p.paiements[idx]) return;
  const pay = p.paiements[idx];
  openModal(`<h3>Marquer le paiement reçu</h3>
    <p class="hint" style="margin-bottom:14px">${esc(p.nom)} · ${eur(pay.montant)} · commission ${eur(payCommission(p, pay))}</p>
    <div class="field"><label>Date de réception réelle</label><input class="input" type="date" id="mr-date" value="${pay.datePrevu && new Date(pay.datePrevu) <= new Date() ? pay.datePrevu : todayISO()}"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-primary" id="mr-save">Confirmer</button></div>`);
  $('#mr-save').onclick = () => {
    pay.dateRecu = $('#mr-date').value || todayISO();
    pay.statut = 'reçu';
    touch(p);
    save(); closeModal(); renderCommissions();
    toast('Paiement encaissé · imputé sur ' + new Date(pay.dateRecu).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
  };
}

// Export CSV : une ligne par échéance de paiement (séparateur ; pour Excel FR, avec BOM)
function exportCommissionsCSV() {
  const pays = allPayments();
  if (!pays.length) { toast('Aucun paiement à exporter'); return; }
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['Client', 'Offre', 'Statut deal', 'Montant', 'Taux %', 'Commission', 'Date prévue', 'Date reçue', 'Statut paiement'];
  const lines = [header.join(';')];
  pays.forEach(x => lines.push([
    x.prospect.nom, x.prospect.offre, x.prospect.statut, x.montant, x.prospect.tauxCommission,
    x.commission, x.datePrevu, x.dateRecu || '', x.dateRecu ? 'reçu' : 'en attente'
  ].map(cell).join(';')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `commissions_closer_pro_${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`${pays.length} ligne(s) exportée(s)`);
}

/* ==========================================================================
   PAGE — Facturation (auto-entrepreneur en franchise de TVA)
   ========================================================================== */
const MONTHS_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const TVA_MENTION = 'TVA non applicable - article 293 B du CGI';

// Statut d'une facture (slug ASCII pour les classes CSS)
const INVOICE_STATUSES = ['Brouillon', 'Envoyée', 'Payée'];
const INVOICE_STATUS_SLUG = { 'Brouillon': 'draft', 'Envoyée': 'sent', 'Payée': 'paid' };

const clientById = (id) => state.clients.find(c => c.id === id);
const profilComplet = () => { const p = state.profil || {}; return !!(p.prenom && p.nom && p.telephone && p.email && p.adresse && p.cp && p.ville && p.siret); };

// Commission encaissée (part reçue) sur un prospect pendant un mois donné.
function commissionEncaisseeMois(p, start, end) {
  return (p.paiements || []).reduce((s, pay) => {
    if (!pay.dateRecu) return s;
    const rd = new Date(pay.dateRecu);
    return (isNaN(rd) || rd < start || rd > end) ? s : s + payCommission(p, pay);
  }, 0);
}

// Toutes les commissions CLOSÉES sur la période (dateClose dans le mois), tous écosystèmes.
// Chaque ligne = un close : date, prospect, email, commission totale du deal,
// mode de paiement, et commission encaissée ce mois-ci.
function invoiceLines(annee, mois) {
  const start = new Date(annee, mois - 1, 1);
  const end = new Date(annee, mois, 0, 23, 59, 59, 999);
  const lines = [];
  signedProspects().forEach(p => {
    if (!p.dateClose) return;
    const dc = new Date(p.dateClose);
    if (isNaN(dc) || dc < start || dc > end) return;
    lines.push({
      date: p.dateClose,
      prospect: p.nom,
      email: p.email || '',
      commission: calcCommission(p) || 0,
      mode: p.modePaiement || '',
      encaisse: commissionEncaisseeMois(p, start, end)
    });
  });
  lines.sort((a, b) => new Date(a.date) - new Date(b.date));
  return lines;
}

// Numérotation séquentielle par année, via un compteur monotone (jamais réutilisé,
// même si une facture est supprimée — continuité légale des numéros).
function nextInvoiceNumber(annee) {
  state.factureCounter = state.factureCounter || {};
  const next = (state.factureCounter[annee] || 0) + 1;
  return { seq: next, numero: `${annee}-${String(next).padStart(3, '0')}` };
}

// jsPDF chargé à la demande (au premier "Générer le PDF") pour ne pas alourdir le démarrage.
let _jspdf = null;
function loadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (_jspdf) return _jspdf;
  _jspdf = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
    s.onload = () => resolve(window.jspdf.jsPDF);
    s.onerror = () => { _jspdf = null; reject(new Error('Chargement de jsPDF impossible')); };
    document.head.appendChild(s);
  });
  return _jspdf;
}

function renderFacturation() {
  const p = state.profil || {};
  const profilCard = profilComplet()
    ? `<div class="fact-profil-grid">
        <div><span class="ds-lbl">Émetteur</span><div class="fact-strong">${esc(p.prenom)} ${esc(p.nom)}</div></div>
        <div><span class="ds-lbl">Contact</span><div>${esc(p.telephone)}<br>${esc(p.email)}</div></div>
        <div><span class="ds-lbl">Adresse</span><div>${esc(p.adresse)}<br>${esc(p.cp)} ${esc(p.ville)}</div></div>
        <div><span class="ds-lbl">SIRET</span><div>${esc(p.siret)}${p.iban ? '<br><span class="ds-lbl">IBAN</span> ' + esc(p.iban) : ''}</div></div>
      </div>`
    : `<div class="fact-empty">Renseigne ton profil pour pouvoir générer des factures.</div>`;

  const clientRows = state.clients.length ? state.clients.map(c => `<tr>
      <td class="t-strong" data-label="Client">${esc(c.societe)}</td>
      <td class="muted" data-label="Téléphone">${esc(c.telephone || '—')}</td>
      <td class="muted" data-label="Email">${esc(c.email || '—')}</td>
      <td class="muted" data-label="Ville">${esc(c.ville || '—')}</td>
      <td class="muted" data-label="SIRET">${esc(c.siret || '—')}</td>
      <td class="t-right t-actions" style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" data-edit-client="${c.id}">Modifier</button>
        <button class="btn btn-danger btn-sm" data-del-client="${c.id}">✕</button>
      </td></tr>`).join('') : `<tr class="crm-empty"><td colspan="6" class="muted" style="text-align:center;padding:24px">Aucun client. Ajoute ton premier infopreneur / HOS.</td></tr>`;

  const factures = [...state.factures].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const statutBadge = (f) => {
    const st = INVOICE_STATUSES.includes(f.statut) ? f.statut : 'Brouillon';
    return `<select class="statut-badge statut-${INVOICE_STATUS_SLUG[st]}" data-statut="${f.id}" title="Changer le statut">
      ${INVOICE_STATUSES.map(s => `<option ${s === st ? 'selected' : ''}>${s}</option>`).join('')}
    </select>`;
  };
  const histRows = factures.length ? factures.map(f => `<tr>
    <td class="t-strong" data-label="Numéro">${esc(f.numero)}</td>
    <td data-label="Date">${fmtDate(f.createdAt)}</td>
    <td data-label="Client">${esc(f.clientSnap ? f.clientSnap.societe : '—')}</td>
    <td data-label="Période">${MONTHS_FR[f.mois - 1]} ${f.annee}</td>
    <td data-label="Mode"><span class="badge badge-${f.mode === 'detaille' ? 'blue' : 'gray'}">${f.mode === 'detaille' ? 'Détaillé' : 'Simplifié'}</span></td>
    <td data-label="Statut">${statutBadge(f)}</td>
    <td class="t-right t-num" data-label="Montant" style="color:var(--rev)">${eur(f.total)}</td>
    <td class="t-right t-actions" style="white-space:nowrap">
      <button class="btn btn-ghost btn-sm" data-dl-facture="${f.id}">PDF</button>
      <button class="btn btn-danger btn-sm" data-del-facture="${f.id}">✕</button>
    </td></tr>`).join('') : `<tr class="crm-empty"><td colspan="8" class="muted" style="text-align:center;padding:24px">Aucune facture générée pour l'instant.</td></tr>`;

  $('#page-facturation').innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">Facturation</h1><div class="page-subtitle">Profil, clients et factures de commissions</div></div>
      <button class="btn btn-primary" id="fact-new" ${profilComplet() && state.clients.length ? '' : 'disabled'}>${ICONS.plus} Générer une facture</button>
    </div>

    <div class="card mb">
      <div class="flex between items-center" style="margin-bottom:14px"><div class="kpic-label">Mon profil</div><button class="btn btn-ghost btn-sm" id="fact-profil-edit">${profilComplet() ? 'Modifier' : 'Renseigner'}</button></div>
      ${profilCard}
    </div>

    <div class="card mb">
      <div class="flex between items-center" style="margin-bottom:14px"><div class="kpic-label">Mes clients</div><button class="btn btn-ghost btn-sm" id="fact-client-add">${ICONS.plus} Ajouter un client</button></div>
      <div class="table-scroll"><table class="stat-table crm-table">
        <thead><tr><th>Client</th><th>Téléphone</th><th>Email</th><th>Ville</th><th>SIRET</th><th class="t-right">Actions</th></tr></thead>
        <tbody>${clientRows}</tbody></table></div>
    </div>

    <div class="card">
      <div class="kpic-label" style="margin-bottom:14px">Historique des factures</div>
      <div class="table-scroll"><table class="stat-table crm-table">
        <thead><tr><th>Numéro</th><th>Date</th><th>Client</th><th>Période</th><th>Mode</th><th>Statut</th><th class="t-right">Montant</th><th class="t-right">Actions</th></tr></thead>
        <tbody>${histRows}</tbody></table></div>
    </div>`;

  $('#fact-profil-edit').onclick = () => profilForm();
  $('#fact-client-add').onclick = () => clientForm();
  const nb = $('#fact-new'); if (nb) nb.onclick = () => invoiceModal();
  $$('#page-facturation [data-edit-client]').forEach(b => b.onclick = () => clientForm(clientById(b.dataset.editClient)));
  $$('#page-facturation [data-del-client]').forEach(b => b.onclick = () => {
    const c = clientById(b.dataset.delClient);
    openModal(`<h3>Supprimer ce client ?</h3><p class="hint" style="margin-bottom:16px">« ${esc(c.societe)} » sera supprimé. Les factures déjà générées sont conservées.</p><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-danger" id="dc">Supprimer</button></div>`);
    $('#dc').onclick = () => { state.clients = state.clients.filter(x => x.id !== c.id); save(); closeModal(); renderFacturation(); toast('Client supprimé'); };
  });
  $$('#page-facturation [data-statut]').forEach(sel => sel.onchange = () => {
    const f = state.factures.find(x => x.id === sel.dataset.statut);
    if (!f) return;
    f.statut = sel.value;
    // Reflète la couleur immédiatement, puis persiste (save() pousse vers Supabase)
    sel.className = 'statut-badge statut-' + INVOICE_STATUS_SLUG[f.statut];
    save();
    toast(`Facture ${f.numero} · ${f.statut}`);
  });
  $$('#page-facturation [data-dl-facture]').forEach(b => b.onclick = () => { const f = state.factures.find(x => x.id === b.dataset.dlFacture); if (f) generateInvoicePDF(f); });
  $$('#page-facturation [data-del-facture]').forEach(b => b.onclick = () => {
    const f = state.factures.find(x => x.id === b.dataset.delFacture);
    openModal(`<h3>Supprimer la facture ${esc(f.numero)} ?</h3><div class="import-warn">Supprimer une facture émise est déconseillé (continuité légale des numéros). Le numéro ${esc(f.numero)} ne sera pas réattribué.</div><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-danger" id="df">Supprimer quand même</button></div>`);
    $('#df').onclick = () => { state.factures = state.factures.filter(x => x.id !== f.id); save(); closeModal(); renderFacturation(); toast('Facture supprimée'); };
  });
}

function profilForm() {
  const p = state.profil || {};
  openModal(`<h3>Mon profil</h3>
    <div class="form-grid">
      <div class="field"><label>Prénom</label><input class="input" id="pf-prenom" value="${esc(p.prenom || '')}"></div>
      <div class="field"><label>Nom</label><input class="input" id="pf-nom" value="${esc(p.nom || '')}"></div>
      <div class="field"><label>Téléphone</label><input class="input" type="tel" id="pf-tel" value="${esc(p.telephone || '')}"></div>
      <div class="field"><label>Email</label><input class="input" type="email" id="pf-email" value="${esc(p.email || '')}"></div>
      <div class="field full"><label>Adresse</label><input class="input" id="pf-adresse" value="${esc(p.adresse || '')}"></div>
      <div class="field"><label>Code postal</label><input class="input" id="pf-cp" value="${esc(p.cp || '')}"></div>
      <div class="field"><label>Ville</label><input class="input" id="pf-ville" value="${esc(p.ville || '')}"></div>
      <div class="field"><label>SIRET</label><input class="input" id="pf-siret" value="${esc(p.siret || '')}"></div>
      <div class="field"><label>IBAN (optionnel)</label><input class="input" id="pf-iban" value="${esc(p.iban || '')}"></div>
    </div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-primary" id="pf-save">Enregistrer</button></div>`, { wide: true });
  $('#pf-save').onclick = () => {
    const data = {
      prenom: $('#pf-prenom').value.trim(), nom: $('#pf-nom').value.trim(),
      telephone: $('#pf-tel').value.trim(), email: $('#pf-email').value.trim(),
      adresse: $('#pf-adresse').value.trim(), cp: $('#pf-cp').value.trim(),
      ville: $('#pf-ville').value.trim(), siret: $('#pf-siret').value.trim(),
      iban: $('#pf-iban').value.trim()
    };
    if (!data.prenom || !data.nom || !data.telephone || !data.email || !data.adresse || !data.cp || !data.ville || !data.siret) { toast('Tous les champs sont requis (sauf IBAN)'); return; }
    state.profil = data; save(); closeModal(); renderFacturation(); toast('Profil enregistré');
  };
}

function clientForm(existing) {
  const c = existing || {};
  openModal(`<h3>${existing ? 'Modifier le client' : 'Nouveau client'}</h3>
    <div class="form-grid">
      <div class="field full"><label>Nom société ou nom / prénom</label><input class="input" id="cl-societe" value="${esc(c.societe || '')}"></div>
      <div class="field"><label>Téléphone</label><input class="input" type="tel" id="cl-tel" value="${esc(c.telephone || '')}"></div>
      <div class="field"><label>Email de facturation</label><input class="input" type="email" id="cl-email" value="${esc(c.email || '')}"></div>
      <div class="field full"><label>Adresse</label><input class="input" id="cl-adresse" value="${esc(c.adresse || '')}"></div>
      <div class="field"><label>Code postal</label><input class="input" id="cl-cp" value="${esc(c.cp || '')}"></div>
      <div class="field"><label>Ville</label><input class="input" id="cl-ville" value="${esc(c.ville || '')}"></div>
      <div class="field full"><label>SIRET</label><input class="input" id="cl-siret" value="${esc(c.siret || '')}"></div>
    </div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-primary" id="cl-save">Enregistrer</button></div>`, { wide: true });
  $('#cl-save').onclick = () => {
    const societe = $('#cl-societe').value.trim();
    if (!societe) { toast('Le nom du client est requis'); return; }
    const data = {
      societe, telephone: $('#cl-tel').value.trim(), email: $('#cl-email').value.trim(),
      adresse: $('#cl-adresse').value.trim(), cp: $('#cl-cp').value.trim(),
      ville: $('#cl-ville').value.trim(), siret: $('#cl-siret').value.trim()
    };
    if (existing) Object.assign(existing, data);
    else state.clients.push({ id: uid(), ...data, createdAt: nowISO() });
    save(); closeModal(); renderFacturation(); toast(existing ? 'Client mis à jour' : 'Client ajouté');
  };
}

function invoiceModal() {
  const now = new Date();
  const years = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y--) years.push(y);
  const clientOpts = state.clients.map(c => `<option value="${c.id}">${esc(c.societe)}</option>`).join('');
  const monthOpts = MONTHS_FR.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('');
  const yearOpts = years.map(y => `<option value="${y}">${y}</option>`).join('');

  openModal(`<h3>Générer une facture</h3>
    <div class="form-grid">
      <div class="field full"><label>Client</label><select class="select" id="iv-client">${clientOpts}</select></div>
      <div class="field"><label>Mois</label><select class="select" id="iv-mois">${monthOpts}</select></div>
      <div class="field"><label>Année</label><select class="select" id="iv-annee">${yearOpts}</select></div>
      <div class="field full"><label>Mode</label><select class="select" id="iv-mode"><option value="detaille">Détaillé (une ligne par close)</option><option value="simplifie">Simplifié (total uniquement)</option></select></div>
    </div>
    <div id="iv-preview" class="fact-preview"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-primary" id="iv-go">Générer le PDF</button></div>`, { wide: true });

  // Résumé "mode de paiement global" : un seul mode -> ce mode ; plusieurs -> liste.
  const globalMode = (lines) => {
    const set = [...new Set(lines.map(l => l.mode).filter(Boolean))];
    return set.length === 0 ? '—' : set.length === 1 ? set[0] : 'Plusieurs modes';
  };

  const refresh = () => {
    const mois = Number($('#iv-mois').value), annee = Number($('#iv-annee').value);
    const box = $('#iv-preview');
    const lines = invoiceLines(annee, mois);
    const total = lines.reduce((s, l) => s + l.commission, 0);
    const encaisse = lines.reduce((s, l) => s + l.encaisse, 0);
    if (!lines.length) {
      box.innerHTML = `<div class="fact-empty">Aucune commission closée en ${MONTHS_FR[mois - 1]} ${annee}.</div>`;
      $('#iv-go').disabled = true; return;
    }
    box.innerHTML = `<div class="fact-prev-head">${lines.length} close(s) · mode : ${esc(globalMode(lines))}</div>
      <div class="fact-prev-total">Total commissions : <b>${eur(total)}</b> · encaissé ce mois : <b>${eur(encaisse)}</b></div>`;
    $('#iv-go').disabled = false;
  };
  $('#iv-mois').onchange = refresh; $('#iv-annee').onchange = refresh;
  refresh();

  $('#iv-go').onclick = async () => {
    const c = clientById($('#iv-client').value);
    const mois = Number($('#iv-mois').value), annee = Number($('#iv-annee').value);
    const lines = invoiceLines(annee, mois);
    if (!lines.length) { toast('Aucune commission sur cette période'); return; }
    const total = lines.reduce((s, l) => s + l.commission, 0);
    const encaisse = lines.reduce((s, l) => s + l.encaisse, 0);
    const num = nextInvoiceNumber(annee);

    const facture = {
      id: uid(), numero: num.numero, seq: num.seq, annee, mois,
      clientId: c.id, statut: 'Brouillon',
      mode: $('#iv-mode').value, lignes: lines, total, encaisse, modeGlobal: globalMode(lines),
      createdAt: nowISO(),
      emetteurSnap: { ...state.profil },
      clientSnap: { societe: c.societe, telephone: c.telephone, email: c.email, adresse: c.adresse, cp: c.cp, ville: c.ville, siret: c.siret }
    };

    const btn = $('#iv-go'); btn.disabled = true; btn.textContent = 'Génération…';
    try {
      await generateInvoicePDF(facture);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Générer le PDF';
      toast(String(e.message || e).includes('jsPDF') ? 'Librairie PDF indisponible (vérifie ta connexion)' : 'Erreur lors de la génération');
      return;
    }
    // On ne consomme le numéro et n'enregistre qu'une fois le PDF produit.
    state.factureCounter = state.factureCounter || {};
    state.factureCounter[annee] = num.seq;
    state.factures.push(facture);
    save(); closeModal(); renderFacturation();
    toast(`Facture ${num.numero} générée`);
  };
}

async function generateInvoicePDF(facture) {
  const jsPDF = await loadJsPDF();
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const em = facture.emetteurSnap || {}, cl = facture.clientSnap || {};
  const M = 18; // marge
  let y = M;
  const euro = (n) => (Number(n) || 0).toLocaleString('fr-FR') + ' EUR';

  // En-tête
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(20);
  doc.text('FACTURE', M, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90);
  doc.text(`N° ${facture.numero}`, 210 - M, y - 4, { align: 'right' });
  doc.text(`Date : ${new Date(facture.createdAt).toLocaleDateString('fr-FR')}`, 210 - M, y + 1, { align: 'right' });
  y += 14;
  doc.setDrawColor(220); doc.line(M, y, 210 - M, y); y += 10;

  // Émetteur / Client — coordonnées complètes (nom, adresse, tel, email, SIRET)
  doc.setFontSize(9); doc.setTextColor(130);
  doc.text('ÉMETTEUR', M, y); doc.text('CLIENT', 115, y); y += 5;
  doc.setFontSize(9.5); doc.setTextColor(30);
  const emLines = [`${em.prenom || ''} ${em.nom || ''}`, em.adresse || '', `${em.cp || ''} ${em.ville || ''}`, em.telephone ? `Tél : ${em.telephone}` : '', em.email || '', `SIRET : ${em.siret || ''}`].filter(l => l !== '');
  const clLines = [cl.societe || '', cl.adresse || '', `${cl.cp || ''} ${cl.ville || ''}`, cl.telephone ? `Tél : ${cl.telephone}` : '', cl.email || '', cl.siret ? `SIRET : ${cl.siret}` : ''].filter(l => l !== '');
  const baseY = y;
  emLines.forEach((l, i) => doc.text(l, M, baseY + i * 4.6));
  clLines.forEach((l, i) => doc.text(l, 115, baseY + i * 4.6));
  y = baseY + Math.max(emLines.length, clLines.length) * 4.6 + 8;

  // Objet
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(20);
  doc.text(`Prestation de closing — commissions ${MONTHS_FR[facture.mois - 1]} ${facture.annee}`, M, y);
  y += 10;

  const right = 210 - M;
  const cell = (txt, x, opt) => doc.text(String(txt), x, y, opt);
  if (facture.mode === 'detaille') {
    // Colonnes : Date | Prospect (+ email) | Mode | Commission | Encaissé mois
    const cMode = 108, cComm = 150, cEnc = right;
    doc.setFillColor(245, 243, 240); doc.rect(M, y - 5, right - M, 8, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(80);
    cell('DATE', M + 2); cell('PROSPECT', M + 24); cell('MODE', cMode); cell('COMMISSION', cComm, { align: 'right' }); cell('ENCAISSÉ', cEnc - 2, { align: 'right' });
    y += 7;
    doc.setFont('helvetica', 'normal'); doc.setTextColor(40); doc.setFontSize(8.5);
    facture.lignes.forEach(l => {
      if (y > 258) { doc.addPage(); y = M; }
      cell(new Date(l.date).toLocaleDateString('fr-FR'), M + 2);
      cell(String(l.prospect).slice(0, 26), M + 24);
      cell(String(l.mode || '—').slice(0, 12), cMode);
      cell(euro(l.commission), cComm, { align: 'right' });
      cell(euro(l.encaisse), cEnc - 2, { align: 'right' });
      if (l.email) { y += 3.6; doc.setTextColor(150); doc.setFontSize(7); cell(String(l.email).slice(0, 40), M + 24); doc.setTextColor(40); doc.setFontSize(8.5); }
      y += 6;
    });
  } else {
    doc.setFillColor(245, 243, 240); doc.rect(M, y - 5, right - M, 8, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(80);
    cell('DÉSIGNATION', M + 2); cell('MONTANT', right - 2, { align: 'right' });
    y += 8; doc.setFont('helvetica', 'normal'); doc.setTextColor(40); doc.setFontSize(9.5);
    cell(`Commissions de closing — ${facture.lignes.length} vente(s)`, M + 2);
    cell(euro(facture.total), right - 2, { align: 'right' });
    y += 7;
    cell(`Mode de paiement : ${facture.modeGlobal || '—'}`, M + 2); y += 6;
    cell(`Montant encaissé ce mois-ci : ${euro(facture.encaisse)}`, M + 2); y += 6;
  }

  y += 4; doc.setDrawColor(220); doc.line(M, y, right, y); y += 8;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(20);
  doc.text('TOTAL COMMISSIONS', right - 60, y); doc.text(euro(facture.total), right - 2, y, { align: 'right' });
  y += 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(90);
  doc.text(`Dont encaissé ce mois-ci : ${euro(facture.encaisse)}`, right - 2, y, { align: 'right' });
  y += 12;

  // Mentions légales
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
  doc.text(TVA_MENTION, M, y); y += 6;
  if (em.iban) { doc.text(`IBAN : ${em.iban}`, M, y); y += 6; }
  doc.setTextColor(140); doc.setFontSize(8);
  doc.text('Auto-entrepreneur en franchise de TVA. Paiement à réception.', M, 285);

  doc.save(`Facture_${facture.numero}.pdf`);
}

/* ==========================================================================
   PAGE 5 — Documents (base de connaissances)
   ========================================================================== */
const GPT_URL = "https://chatgpt.com/g/g-6a52450311188191bcfda51d00830d15-coach-closer-pro";

const DOCS_DIR = 'docs/';
const DOC_SECTIONS = [
  {
    id: 'methode', titre: 'Méthode de Closing', docs: [
      { file: 'Script_Closing_Pro.html', num: 'DOC 01', icon: '📋', titre: 'Script de Closing', desc: 'La méthode complète en 6 étapes, mot pour mot. Du cadrage au close final.', tags: ['6 étapes', 'Scripts', 'B2C'], color: '#E8572A', bg: '#FEF0EA' },
      { file: 'Traitement_Objections.html', num: 'DOC 02', icon: '🛡️', titre: 'Traitement des Objections', desc: 'Peur, logistique, comparaison — toutes les objections et comment les neutraliser.', tags: ['Peur', 'Logistique', 'Comparaison'], color: '#B91C1C', bg: '#FFF5F5' },
      { file: 'Reframing.html', num: 'DOC 03', icon: '🧠', titre: 'Reframing des Prospects', desc: 'La méthode CCRV appliquée à toutes les croyances limitantes.', tags: ['CCRV', '15+ croyances'], color: '#6D28D9', bg: '#F5F3FF' }
    ]
  },
  {
    id: 'mindset', titre: 'Mindset & Développement', docs: [
      { file: 'Mindset.html', num: 'DOC 04', icon: '🔥', titre: 'Mindset & Croyances Limitantes', desc: 'Les 3 piliers du mindset, la routine avant appel et les 6 croyances du closer à neutraliser.', tags: ['3 piliers', 'Routine', 'Croyances'], color: '#15803D', bg: '#F0FDF4' }
    ]
  },
  {
    id: 'process', titre: 'Process & Opérationnel', docs: [
      { file: 'Script_Setting.html', num: 'DOC 05', icon: '📞', titre: 'Script Setting', desc: 'Qualifier et planifier les RDVs en 6 étapes. Créer de la douleur avant le call.', tags: ['6 étapes', 'Qualification'], color: '#1D4ED8', bg: '#EFF6FF' },
      { file: 'Process_Challenge.html', num: 'DOC 06', icon: '⚡', titre: 'Process Challenge', desc: 'Organisation avant, pendant et après un lancement. Les 6 templates de messages.', tags: ['Show-up', '6 templates', 'Suivi'], color: '#B45309', bg: '#FFFBEB' },
      { file: 'Comment_Trouver_une_Offre.html', num: 'DOC 07', icon: '🎯', titre: 'Comment Trouver une Offre', desc: 'VSL, compilation, CV closer, prospection et entretien. Du zéro au contrat.', tags: ['VSL', 'CV Closer', 'Prospection'], color: '#15803D', bg: '#F0FDF4' }
    ]
  }
];
const ALL_DOCS = DOC_SECTIONS.flatMap(s => s.docs);

// Toujours la liste en arrivant sur la page ; un document ne s'ouvre que via openDoc().
function renderDocuments() {
  const sections = DOC_SECTIONS.map(s => `
    <div class="kb-section" id="kb-${s.id}">
      <div class="kb-section-header">
        <div class="kb-section-title">${esc(s.titre)}</div>
        <div class="kb-section-count">${s.docs.length} document${s.docs.length > 1 ? 's' : ''}</div>
      </div>
      <div class="kb-docs-grid">
        ${s.docs.map(d => `
          <button class="kb-doc-card" data-doc="${esc(d.file)}" style="--card-color:${d.color};--card-bg:${d.bg}">
            <div class="kb-doc-top">
              <div class="kb-doc-icon">${d.icon}</div>
              <div class="kb-doc-num">${esc(d.num)}</div>
            </div>
            <div class="kb-doc-title">${esc(d.titre)}</div>
            <div class="kb-doc-desc">${esc(d.desc)}</div>
            <div class="kb-doc-tags">${d.tags.map(t => `<span class="kb-doc-tag">${esc(t)}</span>`).join('')}</div>
          </button>`).join('')}
      </div>
    </div>`).join('');

  $('#page-documents').innerHTML = `
    <div class="kb-hero">
      <div class="kb-hero-eyebrow">Closer Pro · Base de connaissances</div>
      <h1 class="kb-hero-title">Tout ce qu'il faut<br>pour closer.</h1>
      <p class="kb-hero-sub">Méthode, scripts, objections, reframing, mindset — tous tes documents de référence au même endroit. Consultables en un clic, à tout moment.</p>
      <div class="kb-hero-stats">
        <div class="kb-hero-stat"><div class="kb-hero-stat-num">${ALL_DOCS.length}</div><div class="kb-hero-stat-label">documents de référence</div></div>
        <div class="kb-hero-stat"><div class="kb-hero-stat-num">6</div><div class="kb-hero-stat-label">étapes de la méthode</div></div>
        <div class="kb-hero-stat"><div class="kb-hero-stat-num">15+</div><div class="kb-hero-stat-label">croyances limitantes traitées</div></div>
      </div>
    </div>
    <div class="kb-wrap">${sections}</div>`;

  $$('#page-documents .kb-doc-card').forEach(b => b.onclick = () => openDoc(b.dataset.doc));
}

function openDoc(file) {
  const d = ALL_DOCS.find(x => x.file === file);
  if (!d) { renderDocuments(); return; }
  $('#page-documents').innerHTML = `
    <div class="doc-viewer">
      <div class="doc-viewer-bar">
        <button class="btn btn-ghost" id="doc-back">← Retour aux documents</button>
        <div class="doc-viewer-title"><span class="doc-viewer-icon" style="background:${d.bg}">${d.icon}</span>${esc(d.titre)}</div>
      </div>
      <iframe class="doc-frame" src="${esc(DOCS_DIR + file)}" title="${esc(d.titre)}"></iframe>
    </div>`;
  $('#doc-back').onclick = () => renderDocuments();
}

/* ==========================================================================
   PAGE 6 — Outils
   ========================================================================== */
const GPT_MODES = [
  {
    num: 'Mode 1', titre: 'Simulateur RP', icon: '🎭', color: '#E8572A', bg: '#FEF0EA', points: [
      'Écris « Je veux faire un RP » et donne le profil du prospect',
      'Format : situation / niveau de résistance / pattern bloquant / objection principale',
      'Joue ton rôle normalement comme si tu étais en vrai appel',
      'Quand tu veux arrêter : écris « Stop, feedback » pour recevoir ton analyse complète'
    ]
  },
  {
    num: 'Mode 2', titre: 'Analyse d\'appel', icon: '📊', color: '#1D4ED8', bg: '#EFF6FF', points: [
      'Écris « Analyse cet appel » et colle ta transcription complète',
      'Tu reçois un feedback détaillé basé sur la méthode en 6 étapes',
      'Score par critère, moments critiques, axes d\'amélioration et conseil clé'
    ]
  },
  {
    num: 'Mode 3', titre: 'Questions sur la méthode', icon: '💡', color: '#6D28D9', bg: '#F5F3FF', points: [
      'Pose n\'importe quelle question sur la méthode de closing',
      'Exemples : « Comment reframer un prospect qui dit qu\'il a pas le temps ? », « Comment traiter l\'objection "c\'est trop cher" ? », « Comment creuser la douleur si le prospect reste en surface ? »',
      'Le GPT répond en s\'appuyant sur la méthode complète et te donne les formulations exactes à utiliser'
    ]
  }
];

function renderOutils() {
  const modes = GPT_MODES.map(m => `
    <div class="gpt-mode" style="--mode-color:${m.color};--mode-bg:${m.bg}">
      <div class="gpt-mode-head">
        <span class="gpt-mode-icon">${m.icon}</span>
        <span class="gpt-mode-num">${esc(m.num)}</span>
        <span class="gpt-mode-titre">${esc(m.titre)}</span>
      </div>
      <ul class="gpt-mode-list">${m.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
    </div>`).join('');

  $('#page-outils').innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">Outils</h1><div class="page-subtitle">Tes outils externes, à portée de clic</div></div>
    </div>

    <div class="gpt-card">
      <div class="gpt-card-head">
        <div class="gpt-card-icon">🤖</div>
        <div class="gpt-card-body">
          <div class="gpt-card-title">Coach Closer Pro</div>
          <div class="gpt-card-desc">Ton IA entraînée sur la méthode complète de closing.</div>
        </div>
        <a class="btn btn-primary gpt-card-btn" href="${esc(GPT_URL)}" target="_blank" rel="noopener">Accéder au GPT →</a>
      </div>

      <div class="gpt-section-label">Comment l'utiliser</div>
      <div class="gpt-modes">${modes}</div>
    </div>`;
}

/* ==========================================================================
   Init — rien ne s'affiche tant que le closer n'est pas authentifié.
   ========================================================================== */
window.closeModal = closeModal;

// Dernier rempart : une fermeture d'onglet ne doit pas emporter un push en attente.
window.addEventListener('beforeunload', () => {
  if (_pushTimer) { clearTimeout(_pushTimer); pushState(); }
});

(async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session && session.user) await startApp(session.user);
  else showAuth();
})();
