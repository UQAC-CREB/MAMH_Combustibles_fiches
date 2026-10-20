// Capture des erreurs : journal des derniers événements, bandeau d'avertissement et
// rapport à copier (rien n'est envoyé à un serveur).
import { t, getLang } from './i18n.js';

const LOG = [];
const MAX = 40;
let stateFn = () => ({});
let shown = false;

export function logEvent(kind, msg, extra) {
  LOG.push({ t: new Date().toISOString().slice(11, 19), kind, msg: String(msg).slice(0, 400), ...(extra ? { extra: String(extra).slice(0, 800) } : {}) });
  if (LOG.length > MAX) LOG.shift();
}

/** Texte du rapport d'erreur (copié dans le presse-papiers). */
function buildReport() {
  let st = {};
  try { st = stateFn(); } catch (e) { st = { erreur_etat: String(e) }; }
  return [
    '=== Rapport d’erreur — application MAMH feux de forêt (v2) ===',
    `Date : ${new Date().toISOString()}`,
    `Adresse : ${location.href}`,
    `Langue : ${getLang()}`,
    `Navigateur : ${navigator.userAgent}`,
    `Écran : ${screen.width}×${screen.height} @${devicePixelRatio}`,
    `Mémoire (Go, approx.) : ${navigator.deviceMemory ?? 'n/d'}`,
    '',
    '--- État de l’application ---',
    JSON.stringify(st, null, 1),
    '',
    '--- Derniers événements ---',
    ...LOG.map(e => `[${e.t}] ${e.kind} : ${e.msg}${e.extra ? `\n    ${e.extra.replace(/\n/g, '\n    ')}` : ''}`),
  ].join('\n');
}

async function copyReport(btn) {
  const txt = buildReport();
  try { await navigator.clipboard.writeText(txt); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  btn.textContent = t('err.copied');
}

/** Affiche le bandeau ('error' : erreur ; 'webgl' : perte de l'affichage de la carte). */
export function showBanner(type) {
  const el = document.getElementById('err-banner');
  if (!el || (shown && type !== 'webgl')) return;
  shown = true;
  el.innerHTML = `<span class="err-msg">${t(type === 'webgl' ? 'err.webgl' : 'err.generic')}</span>
    <span class="err-actions">
      ${type === 'webgl' ? `<button class="btn btn-xs" id="err-reload">${t('err.reload')}</button>` : ''}
      <button class="btn btn-xs secondary" id="err-copy">${t('err.copy')}</button>
      <button class="err-close" id="err-close" title="✕">✕</button>
    </span>`;
  el.hidden = false;
  el.querySelector('#err-copy').onclick = (e) => copyReport(e.currentTarget);
  el.querySelector('#err-close').onclick = () => { el.hidden = true; shown = false; };
  const rl = el.querySelector('#err-reload');
  if (rl) rl.onclick = () => location.reload();
}

/** Branche la capture globale ; `getState` décrit l'état courant de l'application. */
export function initErrors(getState) {
  stateFn = getState;
  window.addEventListener('error', (e) => {
    logEvent('erreur', e.message, e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`);
    showBanner('error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    logEvent('promesse', e.reason?.message || e.reason, e.reason?.stack);
    showBanner('error');
  });
}

/** Événements de la carte : erreurs de chargement (journal) et perte du contexte WebGL (bandeau). */
export function watchMap(map) {
  map.on('error', (e) => {
    const er = e.error || {};
    logEvent('carte', er.message || 'erreur', [er.status ? `HTTP ${er.status}` : '', er.url || e.sourceId || ''].filter(Boolean).join(' '));
  });
  const canvas = map.getCanvas();
  canvas.addEventListener('webglcontextlost', () => {
    logEvent('webgl', 'contexte WebGL perdu (mémoire graphique insuffisante ?)');
    showBanner('webgl');
  });
  canvas.addEventListener('webglcontextrestored', () => logEvent('webgl', 'contexte WebGL restauré'));
}
