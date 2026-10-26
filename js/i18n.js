// Bilinguisme français / anglais
//  - t(clé, vars)            : textes générés par le code (dictionnaire STR)
//  - applyStatic()           : HTML statique ([data-i18n], [data-i18n-ph], [data-i18n-title], [data-i18n-hint]) ;
//                              le français est lu dans le HTML, l'anglais vient de EN_STATIC
//  - cAbb / cLbl / cGrp / pLbl : noms des classes de combustibles et de potentiel
//  - LEGEND                  : contenu des légendes (fenêtres et page du rapport PDF)

const LS_KEY = 'mamh-lang';
function stored() { try { return localStorage.getItem(LS_KEY); } catch (e) { return null; } }
let lang = new URLSearchParams(location.search).get('lang') || stored() || 'fr';
if (!['fr', 'en'].includes(lang)) lang = 'fr';

export const getLang = () => lang;
export const loc = () => (lang === 'en' ? 'en-CA' : 'fr-CA');
const listeners = [];
export const onLang = (fn) => listeners.push(fn);

export function setLang(l) {
  if (l === lang) return;
  lang = l;
  try { localStorage.setItem(LS_KEY, l); } catch (e) { /* stockage indisponible */ }
  applyStatic();
  listeners.forEach(fn => fn(l));
}

export function t(key, vars = {}) {
  const e = STR[key];
  const s = e ? e[lang === 'en' ? 1 : 0] : key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}

export function applyStatic() {
  document.documentElement.lang = lang;
  document.title = t('app.title');
  const swap = (sel, attr, dsKey, set) => document.querySelectorAll(sel).forEach(el => {
    const k = el.getAttribute(attr);
    if (el.dataset[dsKey] === undefined) el.dataset[dsKey] = set(el);
    const en = EN_STATIC[k];
    set(el, lang === 'en' && en != null ? en : el.dataset[dsKey]);
  });
  swap('[data-i18n]', 'data-i18n', 'fr', (el, v) => (v === undefined ? el.innerHTML : (el.innerHTML = v)));
  swap('[data-i18n-ph]', 'data-i18n-ph', 'frPh', (el, v) => (v === undefined ? el.placeholder : (el.placeholder = v)));
  swap('[data-i18n-title]', 'data-i18n-title', 'frTitle', (el, v) => (v === undefined ? el.title : (el.title = v)));
  swap('[data-i18n-hint]', 'data-i18n-hint', 'frHint', (el, v) => (v === undefined ? el.dataset.hint : (el.dataset.hint = v)));
  document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
}

// ── Classes de combustibles et de potentiel ────────────────────────────────
const COMB_EN = {
  1: 'Spruce–lichen woodland', 2: 'Boreal spruce', 3: 'Mature jack pine', 5: 'Red and white pine',
  6: 'Conifer plantation', 7: 'Grass with conifers (ponderosa pine)', 8: 'Deciduous stands',
  9: 'Boreal mixedwood <50% conifer', 10: 'Boreal mixedwood >50% conifer',
  11: 'Mixedwood with dead balsam fir <50%', 12: 'Mixedwood with dead balsam fir >50%', 13: 'Mixedwood with dead balsam fir 100%',
  14: 'Matted grass', 15: 'Standing dead grass', 16: 'Slash', 100: 'Burned area',
  101: 'Wet barren, agricultural land, urban', 102: 'Dry barren', 103: 'Water', 104: 'Urban',
};
const ABB_EN = { Eau: 'Water', Urbain: 'Urban' };
const GRP_EN = { 'Résineux': 'Conifers', 'Mixtes': 'Mixedwood', 'Feuillus': 'Deciduous', 'Rémanents': 'Slash',
  'Herbes': 'Grass', 'Brûlis': 'Burned', 'Dénudé': 'Barren', 'Eau': 'Water', 'Urbain': 'Urban' };
const POT_EN = { 0: 'No fuel', 1: 'Low', 2: 'Moderate', 3: 'Considerable', 4: 'High', 5: 'Extreme' };

export const cAbb = (c) => (lang === 'en' ? ABB_EN[c.abb] || c.abb : c.abb);
export const cLbl = (c) => (lang === 'en' ? COMB_EN[c.v] || c.lbl : c.lbl);
export const cGrp = (g) => (lang === 'en' ? GRP_EN[g] || g : g);
export const pLbl = (c) => (lang === 'en' ? POT_EN[c.v] || c.lbl : c.lbl);
export const pShort = (c) => (c.v === 0 ? (lang === 'en' ? 'No fuel' : 'Absence comb.') : pLbl(c));

// ── Textes générés ─────────────────────────────────────────────────────────
const STR = {
  'app.title': ['Prédisposition des communautés aux feux de forêt - version 2.0 (bêta)', 'Predisposition of communities to forest fires - version 2.0 (beta)'],
  'mrc': ['MRC', 'RCM'],
  'loading.error': ['Erreur de chargement — voir la console.', 'Loading error — see the console.'],
  'err.generic': ['Une erreur est survenue. Si l’application ne répond plus, rechargez la page ; pour nous aider, copiez le rapport d’erreur et transmettez-le à l’équipe.',
    'An error occurred. If the application stops responding, reload the page; to help us, copy the error report and send it to the team.'],
  'err.webgl': ['La carte a perdu l’accès à la carte graphique (mémoire insuffisante probable). Rechargez la page ; pour nous aider, copiez le rapport d’erreur.',
    'The map lost access to the graphics card (probably not enough memory). Reload the page; to help us, copy the error report.'],
  'err.reload': ['↻ Recharger la page', '↻ Reload the page'],
  'err.copy': ['Copier le rapport d’erreur', 'Copy the error report'],
  'err.copied': ['✓ Rapport copié', '✓ Report copied'],
  // Carte
  'tt.fireStart': ['Départ de feu — {d}', 'Fire start — {d}'],
  'tt.cause': ['Cause : {c}', 'Cause: {c}'],
  'cause.h': ['humaine', 'human'], 'cause.f': ['foudre', 'lightning'],
  'tt.fire': ['Feu de forêt — {y}', 'Forest fire — {y}'],
  'tt.unitIdx': ['Indice moyen de la MRC : {m} ± {s}', 'RCM mean index: {m} ± {s}'],
  'tt.index': ['Indice de prédisposition : <b>{v}</b>', 'Predisposition index: <b>{v}</b>'],
  'tt.comb': ['Combustible : <b>{a}</b>{l}', 'Fuel: <b>{a}</b>{l}'],
  'tt.pot': ['Potentiel d’intensité et de propagation : <b>{l}</b>', 'Fire intensity and spread potential: <b>{l}</b>'],
  'fires.zoom': ['Rapprochez la carte (zoom régional) pour afficher les contours de feux.', 'Zoom in (regional scale) to display fire perimeters.'],
  'fires.loading': ['Chargement des contours de feux…', 'Loading fire perimeters…'],
  'fires.hover': ['Survolez un feu pour connaître son année.', 'Hover over a fire to see its year.'],
  'fires.na': ['Contours de feux indisponibles.', 'Fire perimeters unavailable.'],
  'period.recent': ['Feux récents (1976-{y})', 'Recent fires (1976-{y})'],
  'period.old': ['Feux anciens (1887-1975)', 'Historical fires (1887-1975)'],
  // Territoire
  'zone.drawn': ['Zone tracée', 'Drawn area'],
  'zone.extent': ['Emprise de la carte', 'Map extent'],
  'zone.invalid': ['Géométrie non valide (polygone attendu).', 'Invalid geometry (polygon expected).'],
  'zone.computing': ['calcul en cours…', 'computing…'],
  'zone.computingStats': ['Calcul des statistiques de la zone…', 'Computing area statistics…'],
  'zone.summary': ['{km2} km² · {n} communauté(s)', '{km2} km² · {n} community(ies)'],
  'zone.cleared': ['Zone effacée.', 'Area cleared.'],
  'lh.ph.choose': ['Tapez ou choisissez ({n})…', 'Type or choose ({n})…'],
  'lh.ph.none': ['Aucune communauté dans ce territoire', 'No community in this territory'],
  'lh.ph.first': ['— Choisissez d’abord un territoire —', '— Choose a territory first —'],
  'mrc.sub': ['indice moyen {i}', 'mean index {i}'],
  'combo.none': ['Aucun résultat', 'No results'],
  // Indice
  'idx.none': ['Aucune donnée d’indice pour ce territoire.', 'No index data for this territory.'],
  'idx.choose': ['Choisissez un territoire pour afficher son indice moyen.', 'Choose a territory to display its mean index.'],
  'idx.meanSd': ['moyenne · écart-type <b>{s}</b>', 'mean · standard deviation <b>{s}</b>'],
  'idx.note': ['{t} — {n} pixel(s) de 5 km.', '{t} — {n} 5-km pixel(s).'],
  'idx.zone': ['Zone définie', 'Defined area'],
  'idx.short': ['Indice : <b>{m}</b> ± {s}', 'Index: <b>{m}</b> ± {s}'],
  'idx.shortTitle': ['Moyenne ± écart-type des pixels de 5 km de la zone tampon', 'Mean ± standard deviation of the 5-km pixels in the buffer zone'],
  // INFO-MRC
  'mrc.noData': ['Aucune donnée de feux pour ce territoire.', 'No fire data for this territory.'],
  'mrc.choose': ['Choisissez une MRC ou définissez une zone pour afficher l’historique des feux.', 'Choose an RCM or define an area to display the fire history.'],
  'mrc.long': ['Série longue', 'Long series'], 'mrc.short': ['Série courte', 'Short series'],
  'mrc.longTitle': ['Contours de feux anciens (1887-1975) disponibles pour ce territoire', 'Historical fire perimeters (1887-1975) available for this territory'],
  'mrc.shortTitle': ['Aucun contour de feu ancien (1887-1975) pour ce territoire : points d’origine dès 1972, contours de feux dès 1976', 'No historical fire perimeter (1887-1975) for this territory: fire origins from 1972, fire perimeters from 1976'],
  'mrc.fuel': ['Combustibles : <b>{v}</b> ha', 'Fuels: <b>{v}</b> ha'],
  'mrc.fires': ['Nombre de feux (1972-{y}) : <b>{n}</b> (humains {h} · foudre {f})', 'Number of fires (1972-{y}): <b>{n}</b> (human {h} · lightning {f})'],
  'mrc.burned': ['Brûlé : <b>{v}</b> ha', 'Burned: <b>{v}</b> ha'],
  'chart.occ': ['Occurrences et causes des feux', 'Fire occurrences and causes'],
  'chart.sup': ['Superficies brûlées annuellement', 'Area burned annually'],
  'chart.log': [' (échelle log)', ' (log scale)'],
  'chart.logPdf': [' (échelle logarithmique)', ' (logarithmic scale)'],
  'leg.human': ['Humain', 'Human'], 'leg.lightning': ['Foudre', 'Lightning'],
  'leg.meanSd': ['Moyenne ± écart-type', 'Mean ± standard deviation'],
  'summary.click': ['{t} — cliquez pour afficher les graphiques', '{t} — click to display the charts'],
  // Graphiques (SVG)
  'ax.nFires': ['Nombre de feux', 'Number of fires'],
  'ax.rate': ['Taux / 100 000 ha comb.', 'Rate / 100,000 ha fuel'],
  'ax.burned': ['Superficie brûlée (ha)', 'Area burned (ha)'],
  'ax.pctFuel': ['% sup. combustible', '% of fuel area'],
  'tip.occ': ['{n} feux — Humain : {h} · Foudre : {f}', '{n} fires — Human: {h} · Lightning: {f}'],
  'tip.rate': ['Taux : {r} / 100 000 ha', 'Rate: {r} / 100,000 ha'],
  'tip.burned': ['{v} ha brûlés', '{v} ha burned'],
  'tip.pctFuel': ['{p} de la superficie combustible', '{p} of the fuel area'],
  'tip.old': ['Feux anciens (1887-1975)', 'Historical fires (1887-1975)'],
  // INFO-COMMUNAUTÉ
  'lh.choose': ['Cliquez sur une communauté (point orange sur la carte) ou choisissez-la dans le menu.', 'Click a community (orange dot on the map) or choose it from the menu.'],
  'lh.loading': ['Chargement des combustibles…', 'Loading fuels…'],
  'lh.na': ['Données de combustibles indisponibles.', 'Fuel data unavailable.'],
  'lh.noFuel': ['Aucune donnée de combustibles dans cette zone tampon (hors du territoire couvert).', 'No fuel data in this buffer zone (outside the covered territory).'],
  'lh.toValidate': ['à valider', 'to be validated'],
  'lh.toValidateTitle': ['Toponyme préliminaire à valider (IDDPNQL)', 'Preliminary place name to be validated (FNQLSDI)'],
  'lh.buffer': ['Zone tampon', 'Buffer zone'],
  'lh.area': ['Superficie analysée : <b>{v}</b> ha', 'Area analyzed: <b>{v}</b> ha'],
  'lh.showComb': ['voir les combustibles sur la carte', 'show fuels on the map'],
  'lh.chartA': ['A) Superficie des combustibles', 'A) Fuel area'],
  'lh.chartB': ['B) Potentiel d’intensité et de propagation', 'B) Fire intensity and spread potential'],
  'lh.bufferKm': ['Zone tampon : <b>{k} km</b>', 'Buffer zone: <b>{k} km</b>'],
  'big.mrc': ['Fiche régionale — historique des feux', 'Regional sheet — fire history'],
  'big.lh': ['Fiche communauté — combustibles', 'Community sheet — fuels'],
  // Rapport (fenêtre)
  'rep.terr': ['Territoire : <b>{t}</b>', 'Territory: <b>{t}</b>'],
  'rep.territory': ['Territoire', 'Territory'],
  'rep.noLh': ['Aucune communauté dans ce territoire.', 'No community in this territory.'],
  'rep.err': ['Erreur : {e}', 'Error: {e}'],
  'rep.pick': ['Cochez au moins une communauté ou la page territoire.', 'Check at least one community or the territory page.'],
  'rep.lib': ['Bibliothèque PDF en cours de chargement, réessayez.', 'PDF library still loading, please retry.'],
  'rep.step': ['Étape {i} / {n} — {t}', 'Step {i} / {n} — {t}'],
  'rep.stepTerr': ['Page territoire…', 'Territory page…'],
  'rep.stepLh': ['Communauté {i} / {n} : {name}…', 'Community {i} / {n}: {name}…'],
  'rep.stepLeg': ['Page des légendes…', 'Legend page…'],
  'rep.stepSave': ['Enregistrement du PDF…', 'Saving the PDF…'],
  'rep.done': ['Rapport généré ({n} page(s)).', 'Report generated ({n} page(s)).'],
  'rep.file': ['Rapport_feux', 'Fire_report'],
  // Rapport (PDF)
  'pdf.generated': ['Généré le {d} - application v2.0 (bêta)', 'Generated on {d} - application v2.0 (beta)'],
  'pdf.obs': ['Observatoire régional de recherche sur la forêt boréale', 'Regional Observatory for Boreal Forest Research'],
  'pdf.terrTitle': ['Portrait de l\'historique des feux de forêt {a} à {b}', 'Forest fire history portrait {a} to {b}'],
  'pdf.idxMean': ['Indice de prédisposition moyen : {v}', 'Mean predisposition index: {v}'],
  'pdf.idxSd': ['Écart-type : {v}', 'Standard deviation: {v}'],
  'pdf.idxNote': ['(indice standardisé de 0 à 1 ; {n} pixels de 5 km)', '(standardized index from 0 to 1; {n} 5-km pixels)'],
  'pdf.fires': ['Nombre de feux 1972-{y} : {n} (humains {h}, foudre {f})', 'Number of fires 1972-{y}: {n} (human {h}, lightning {f})'],
  'pdf.burned': ['Superficie brûlée {a}-{b} : {v} ha', 'Area burned {a}-{b}: {v} ha'],
  'pdf.fuel': ['Superficie combustible : {v} ha', 'Fuel area: {v} ha'],
  'pdf.terrSources': ['Sources (donneesquebec.ca) : Cartographie des points d\'origine des feux de forêt (1972-2024) - Feux de forêt (depuis 1976) - Feux anciens (1887-1975, si disponibles) - Combustibles 2025 (MRNF). Trait pointillé : moyenne des années avec feux ; bande grise : +/- 1 écart-type.',
    'Sources (donneesquebec.ca): Forest fire origin points (1972-2024) - Forest fires (since 1976) - Historical fires (1887-1975, where available) - Fuels 2025 (MRNF). Dashed line: mean of years with fires; grey band: +/- 1 standard deviation.'],
  'pdf.combTitle': ['Cartographie des combustibles', 'Fuel mapping'],
  'pdf.community': ['Communauté :', 'Community:'],
  'pdf.municipality': ['Municipalité de {m}', 'Municipality of {m}'],
  'pdf.nation': ['Nation : {n} (toponyme à valider)', 'Nation: {n} (place name to be validated)'],
  'pdf.unitIdx': ['Indice de prédisposition moyen de la MRC : {m} (± {s})', 'RCM mean predisposition index: {m} (± {s})'],
  'pdf.bufIdx': ['Indice dans la zone tampon : {m} (± {s})', 'Index within the buffer zone: {m} (± {s})'],
  'pdf.buffer': ['Zone tampon : {k} km ({v} ha analysés)', 'Buffer zone: {k} km ({v} ha analyzed)'],
  'pdf.lhSources': ['Sources (donneesquebec.ca) : Potentiel d\'intensité et de propagation des feux de forêt - Combustibles 2025 (MRNF) - Découpages administratifs 1/20 000 - Lieux habités. Fond de carte : CARTO, OpenStreetMap.',
    'Sources (donneesquebec.ca): Forest fire intensity and spread potential - Fuels 2025 (MRNF) - Administrative boundaries 1:20,000 - Populated places. Basemap: CARTO, OpenStreetMap.'],
  'pdf.legTitle': ['Légendes et explications', 'Legends and explanations'],
  'pdf.legMrc': ['Fiche régionale (MRC ou zone)', 'Regional sheet (RCM or area)'],
  'pdf.legLh': ['Fiche communauté', 'Community sheet'],
};

// ── Légendes (fenêtres et page du PDF) — **gras** ───────────────────────────
export function LEGEND() {
  const fr = lang !== 'en';
  return {
    mrc: [
      { h: fr ? 'Graphique « Occurrences et causes des feux »' : 'Chart “Fire occurrences and causes”', p: [
        fr ? 'Ce graphique illustre l’évolution annuelle de la fréquence des départs de feux (points d’origine, 1972-2024), en distinguant les causes anthropiques (humain) des causes naturelles (foudre).'
          : 'This chart shows the annual number of fire starts (origin points, 1972-2024), distinguishing human causes from natural causes (lightning).',
        fr ? 'L’axe de droite exprime le **taux d’occurrence** : nombre de feux pour 100 000 ha de combustibles du territoire.'
          : 'The right axis gives the **occurrence rate**: number of fires per 100,000 ha of fuels in the territory.',
      ], sw: [['#56B4E9', fr ? 'Humain' : 'Human'], ['#E69F00', fr ? 'Foudre' : 'Lightning']] },
      { h: fr ? 'Graphique « Superficies brûlées annuellement »' : 'Chart “Area burned annually”', p: [
        fr ? 'Ce graphique présente les superficies brûlées annuellement (contours des feux de forêt). L’échelle logarithmique (case « log ») permet de comparer les petites et les très grandes années de feux ; décochez-la pour une échelle linéaire.'
          : 'This chart shows the area burned each year (forest fire perimeters). The logarithmic scale (“log” box) makes it possible to compare small and very large fire years; uncheck it for a linear scale.',
        fr ? 'L’axe de droite exprime la superficie brûlée en **pourcentage de la superficie combustible** du territoire.'
          : 'The right axis gives the area burned as a **percentage of the fuel area** of the territory.',
      ] },
      { h: fr ? 'Moyenne et écart-type' : 'Mean and standard deviation', p: [
        fr ? 'Le trait pointillé indique la moyenne des années avec feux ; la bande grise couvre ± 1 écart-type autour de cette moyenne.'
          : 'The dashed line shows the mean of the years with fires; the grey band covers ± 1 standard deviation around that mean.',
      ] },
      { h: fr ? 'Séries longues (1887-1975)' : 'Long series (1887-1975)', p: [
        fr ? 'Les graphiques s’ajustent aux données disponibles. Lorsque des **contours de feux anciens (1887-1975)** existent pour le territoire, la « série longue » est affichée ; sinon, la série débute en 1972 (points d’origine) et 1976 (contours de feux).'
          : 'Charts adjust to the available data. Where **historical fire perimeters (1887-1975)** exist for the territory, the “long series” is shown; otherwise, the series starts in 1972 (origin points) and 1976 (fire perimeters).',
      ] },
      { h: fr ? 'Indice de prédisposition' : 'Predisposition index', p: [
        fr ? 'Indice standardisé de 0 à 1 (pixels de 5 km). Pour une MRC ou une zone, la moyenne et l’écart-type des pixels du territoire sont indiqués. La prédisposition reflète la probabilité à long terme qu’un milieu habité soit menacé ou atteint par un feu de forêt ; elle ne doit pas être confondue avec le danger d’incendie quotidien.'
          : 'Standardized index from 0 to 1 (5-km pixels). For an RCM or an area, the mean and standard deviation of the territory’s pixels are given. Predisposition reflects the long-term probability that a populated place is threatened or reached by a forest fire; it must not be confused with the daily fire danger.',
      ], vars: true },
    ],
    // Variables de l'indice composite (somme des indicateurs standardisés et pondérés ; P = poids)
    idxVarsTitle: fr ? 'Variables de l’indice (P = pondération)' : 'Index variables (P = weight)',
    idxVarsNote: fr ? 'Indice composite : somme des 6 indicateurs standardisés et pondérés.' : 'Composite index: sum of the 6 standardized and weighted indicators.',
    idxVars: [
      [fr ? 'Taux de brûlage' : 'Burn rate', fr ? '% de superficie brûlée par année depuis 1976 (ou 1890 si disponible)' : '% of area burned per year since 1976 (or 1890 where available)', 3],
      [fr ? 'Taux d’occurrence des feux causés par la foudre' : 'Lightning-caused fire occurrence rate', fr ? 'départs / 10 000 ha depuis 1976' : 'fire starts / 10,000 ha since 1976', 1],
      [fr ? 'Taux d’occurrence des feux d’origine humaine' : 'Human-caused fire occurrence rate', fr ? 'départs / 10 000 ha depuis 1976' : 'fire starts / 10,000 ha since 1976', 1],
      [fr ? 'Couverture résineuse' : 'Conifer cover', fr ? '% des terres émergées en 2025' : '% of land area in 2025', 2],
      [fr ? 'Météo propice aux feux' : 'Fire-conducive weather', fr ? '95e percentile de l’indice forêt-météo (IFM), 2021-2050' : '95th percentile of the Fire Weather Index (FWI), 2021-2050', 2],
      [fr ? 'Densité de routes' : 'Road density', fr ? 'm / ha (plafonnée à 15 m / ha)' : 'm / ha (capped at 15 m / ha)', 1],
    ],
    idxConcept: fr ? 'La prédisposition des communautés vise à refléter la probabilité à long terme qu’un milieu habité soit menacé ou atteint par un feu de forêt, en fonction de son emplacement, de l’historique des feux, du climat régional et de la végétation (combustibles). Elle ne doit pas être confondue avec le danger d’incendie, qui varie au fil de la saison selon la météo (sopfeu.qc.ca/carte).'
      : 'Community predisposition aims to reflect the long-term probability that a populated place is threatened or reached by a forest fire, based on its location, fire history, regional climate and vegetation (fuels). It must not be confused with fire danger, which varies during the season with the weather (sopfeu.qc.ca/carte).',
    idxScale: fr ? 'L’indice est standardisé de 0 à 1 (pixels de 5 km) : plus il s’approche de 1, plus le territoire est prédisposé aux grands feux. Pour une MRC ou une zone, la moyenne et l’écart-type des pixels sont indiqués (bande grise sur la barre).'
      : 'The index is standardized from 0 to 1 (5-km pixels): the closer it gets to 1, the more the territory is predisposed to large fires. For an RCM or an area, the mean and standard deviation of the pixels are given (grey band on the bar).',
    lhComb: { h: fr ? 'Combustibles MRNF 2025' : 'MRNF 2025 fuels', p: [
      fr ? 'Ce graphique représente les différents types de combustibles végétaux présents dans la zone tampon (1 à 50 km, 25 km par défaut) autour du lieu habité. Chaque type de combustible présente une structure et une composition différentes, qui influencent grandement le potentiel d’intensité et de propagation des feux de forêt. Ces données sont issues de la Méthode canadienne de prévision du comportement des incendies de forêt (MCPCI).'
        : 'This chart shows the different types of vegetation fuels found in the buffer zone (1 to 50 km, 25 km by default) around the populated place. Each fuel type has a different structure and composition, which strongly influence fire intensity and spread potential. These data follow the Canadian Forest Fire Behavior Prediction (FBP) System.',
    ] },
    lhPot: { h: fr ? 'Potentiel d’intensité et de propagation MRNF 2025' : 'MRNF 2025 fire intensity and spread potential', p: [
      fr ? 'Ce graphique fournit de l’information sur le potentiel d’intensité et de propagation du feu (faible à extrême) et sa superficie relative dans la zone tampon. Le pourcentage indiqué mesure la gravité potentielle et non la probabilité réelle d’ignition ou de propagation du feu.'
        : 'This chart describes the fire intensity and spread potential (low to extreme) and its relative area within the buffer zone. The percentage measures potential severity, not the actual probability of ignition or fire spread.',
      fr ? 'Par exemple : si la classe « Élevé » a une valeur de 22 %, cela signifie que 22 % de la zone tampon peut mener à un taux de propagation et d’intensité du feu élevé SEULEMENT s’il y a ignition.'
        : 'For example: if the “High” class shows 22%, it means that 22% of the buffer zone could lead to high fire spread and intensity ONLY if there is an ignition.',
    ] },
    lhMore: [
      { h: fr ? 'Lecture des deux graphiques' : 'Reading the two charts', p: [
        fr ? 'Les deux graphiques ont volontairement la même hauteur : les classes de potentiel s’alignent grossièrement sur les groupes de combustibles correspondants (par exemple, les résineux et les mixtes vis-à-vis des potentiels élevés). Cette correspondance est approximative et sert à faciliter la lecture.'
          : 'Both charts deliberately have the same height: potential classes roughly line up with the corresponding fuel groups (for example, conifers and mixedwood facing the higher potentials). This correspondence is approximate and meant to ease reading.',
      ] },
      { h: fr ? 'Superficie analysée' : 'Area analyzed', p: [
        fr ? 'Les pourcentages sont calculés sur la superficie de la zone tampon située au Québec (pixels de 25 m). Les portions hors Québec (autres provinces, États-Unis) sont exclues ; les plans d’eau situés hors de la couche MRNF (fleuve, golfe, baies) sont comptés comme « Eau » et « Absence combustible ».'
          : 'Percentages are computed on the part of the buffer zone located in Québec (25-m pixels). Areas outside Québec (other provinces, United States) are excluded; water bodies outside the MRNF layer (river, gulf, bays) are counted as “Water” and “No fuel”.',
      ] },
    ],
    links: {
      fbp: fr ? '→ Combustibles MCPCI (ressources-naturelles.canada.ca)' : '→ FBP fuel types (natural-resources.canada.ca)',
      pot: fr ? '→ Potentiel d’intensité (donneesquebec.ca)' : '→ Intensity potential (donneesquebec.ca)',
      classes: fr ? 'Classes' : 'Classes',
    },
  };
}

// ── HTML statique (anglais ; le français est lu dans index.html) ───────────
const EN_STATIC = {
  'hdr.title': 'Predisposition of communities to forest fires — version 2.0 (beta)',
  'loading': 'Loading data…',
  'tab.intro': 'Introduction', 'tab.explore': 'Explore', 'tab.res': 'Useful resources',
  'pop.title': 'Welcome: predisposition of communities to forest fires',
  'pop.body': `<p><strong>This application lets you explore, directly on screen:</strong></p>
      <p><strong>INFO-RCM</strong>: the forest fire history (occurrences by cause and area burned) for a regional county municipality (RCM) or for an area you define yourself.</p>
      <p><strong>INFO-COMMUNITY</strong>: the fuel composition and the fire intensity and spread potential around a community, within an adjustable buffer zone (1 to 50 km).</p>
      <br>
      <p><strong><u>INSTRUCTIONS</u></strong></p>
      <p>1. Choose the <strong>territory</strong>: an <strong>RCM</strong> (type its name or click on the map) or an <strong>area</strong> (draw a rectangle or use the map extent). The <strong>↺ Reset</strong> button clears the interface.</p>
      <p>2. The <strong>INFO-RCM</strong> charts become available and the territory’s communities appear on the map. Past fire perimeters are visible once you zoom in (<strong>Layers</strong> panel at the top right).</p>
      <p>3. Click a <strong>community</strong> (on the map or in the menu) to display <strong>INFO-COMMUNITY</strong>, then adjust the buffer zone.</p>
      <p>4. The <strong>Generate a PDF report</strong> button produces a territory sheet, one sheet per checked community and a legend page.</p>
      <p>The map shows a green-to-red background indicating the forest fire predisposition index (standardized index from 0 to 1, 5-km pixels). The higher the index, the more the territory is predisposed to fires. Hover over the map to read the index value; the mean and standard deviation of the selected territory are shown in the panel.</p>
      <p><strong>Note</strong>: this study relies on scientific data to assess the predisposition of Québec and Indigenous communities to forest fires at two scales of analysis: regional and local. To consider concrete actions to protect communities, contact the competent authorities — see the <span class="lien-onglet" data-goto="ressources">USEFUL RESOURCES</span> tab.</p>
      <p>For more details, see the <span class="lien-onglet" data-goto="intro">INTRODUCTION</span> tab.</p>`,
  'btn.close': 'Close',
  'rep.title': 'PDF report',
  'rep.help': 'Check the communities to include. The report starts with the territory page (RCM / area), followed by one page per checked community (buffer zone of <b id="rep-buf">25</b> km) and a page of legends and explanations.',
  'rep.all': 'Check all', 'rep.none': 'Uncheck all', 'rep.filter': 'Filter…',
  'rep.terrPage': 'Include the territory page (RCM / area)',
  'rep.cancel': 'Cancel', 'rep.go': '⬇ Generate the PDF',
  'intro.body': `<p>In Québec, forest fires are a potentially significant threat to people and infrastructure. The exceptional 2023 season, which burned more than 4.2 million hectares, marked a turning point because of the major pressures it created, including the evacuation of thousands of people — among them several Indigenous communities — and significant property damage. As climate change is expected to intensify these phenomena, it is essential to better prepare communities to face them.</p>
        <p>Forest fire activity varies by region and depends on three main factors. Vegetation type influences fire intensity; landscape fragmentation (water bodies, roads, agricultural and urban areas) limits risk. Weather conditions (heat, drought and wind) increase flammability and rate of spread. Finally, ignition sources differ depending on whether fires are human-caused or caused by lightning.</p>
        <p>This study by the Regional Observatory for Boreal Forest Research assesses the predisposition of non-Indigenous and Indigenous communities in Québec to be affected by forest fires. The index reflects the long-term probability that a populated place is threatened or reached by a forest fire, based on its location, fire history, regional climate and vegetation (fuels).</p>
        <p>To make scientific knowledge on forest fires available to the public, the Observatory produced this application as an interactive map for the regional county municipalities (RCMs) and communities of Québec and Indigenous territories.</p>
        <p>In collaboration with the Société de protection des forêts contre le feu (SOPFEU), the Ministère de la Sécurité intérieure du Québec (MSI) and the Ministère des Ressources naturelles et des Forêts du Québec (MRNF).</p>
        <p style="background:#fff8e1; border-left:3px solid #d4821a; padding:8px 10px; border-radius:0 4px 4px 0;"><strong>Caution</strong>: the indices calculated for the various regions do not indicate an actual fire danger, which varies daily during the season according to weather conditions.</p>`,
  'intro.authors': 'Authors',
  'src.title': 'Data sources',
  'src.fires': 'Forest fires',
  'src.fires.txt': 'Fire origin points (1972-2024) · Forest fires (since 1976) · Historical fires (1887-1975)',
  'src.fuels': 'Forest fuels',
  'src.fuels.txt': 'Fuels 2025 (MRNF, 25 m) · Fire intensity and spread potential 2025-2026',
  'src.admin': 'Administrative boundaries',
  'src.admin.txt': 'RCM · Municipality',
  'src.places': 'Populated places',
  'src.places.txt': 'Indigenous place names: preliminary version, to be validated (FNQLSDI)',
  'btn.info': 'ℹ Instructions', 'btn.reset': '↺ Reset',
  'title.reset': 'Clear the territory and the community, and restore the initial map display',
  'lbl.territory': 'Territory', 'mode.mrc': 'RCM', 'mode.zone': 'Defined area',
  'ph.mrc': 'Type or choose an RCM…',
  'btn.draw': '✏ Draw a rectangle', 'btn.extent': '▭ Map extent',
  'zone.help': 'Draw a rectangle on the map (click and drag) or use the current map extent.',
  'lbl.community': 'Community',
  'idx.label': 'Forest fire predisposition index',
  'title.lpResize': 'Drag to adjust the panel width',
  'title.idxInfo': 'What is the predisposition index?', 'leg.idxTitle': 'Forest fire predisposition index',
  'lowHigh': 'Low → High',
  'box.mrc': 'INFO-RCM', 'box.lh': 'INFO-COMMUNITY',
  'hint.mrc': 'Click INFO-RCM to see the fire history of the territory: number of fires by cause and area burned each year.',
  'hint.lh': 'Click INFO-COMMUNITY to see the fuels and the fire intensity and spread potential within the buffer zone around the community.',
  'btn.enlarge': '⤢ Enlarge', 'btn.legend': '📋 Legend', 'btn.legendLong': '📋 Legend and explanation',
  'title.enlargeMrc': 'Enlarge the regional sheet', 'title.enlargeLh': 'Enlarge the community sheet',
  'title.log': 'Logarithmic scale for burned areas', 'title.legend': 'Legend and explanation',
  'title.toggle': 'Show / hide the charts',
  'btn.report': '⬇ Generate a PDF report',
  'res.intro1': 'Prepare to face a forest fire: know what to do to ensure your safety and that of your loved ones, and to protect your home and property.',
  'res.intro2': 'In collaboration with the Société de protection des forêts contre le feu (SOPFEU), the Ministère de la Sécurité intérieure du Québec (MSI) and the Ministère des Ressources naturelles et des Forêts du Québec (MRNF).',
  'res.gov': 'Government of Québec — Forest fires (quebec.ca, in French)',
  'res.g1': 'Mitigating forest fire risks', 'res.g2': 'Preparing for a forest fire', 'res.g3': 'Protecting your home and property',
  'res.g4': 'Safety instructions during a forest fire', 'res.g5': 'Protecting your health from smoke',
  'res.g6': 'Returning home safely after a forest fire',
  'res.sopfeu': 'SOPFEU — Forest fire protection agency (in French)',
  'res.sub': 'See the following links to learn about:',
  'res.s1': 'Preventing forest fires', 'res.s2': 'Fire danger and current restrictions', 'res.s3': 'Protecting your home',
  'res.go': '→ Consult',
  'draw.hint': 'Click and drag to draw the area · Esc to cancel',
  'lp.title': '☰ Layers',
  'ly.indice': 'Predisposition index (5 km)', 'ly.opacity': 'Opacity', 'ly.indiceNote': 'Hover over the map to read a pixel value.',
  'ly.feux': 'Fire perimeters', 'ly.period': 'Period', 'title.yrA': 'Start year', 'title.yrB': 'End year', 'ly.feuxNote': 'Visible at a regional zoom. Hover over a fire to see its year.',
  'ly.pts': 'Fire origin points (1972-2024)', 'ly.ptsNote': 'Follows the period chosen for perimeters. Hover over a point for the date and cause.',
  'ly.human': 'Human', 'ly.lightning': 'Lightning',
  'ly.comb': 'Fuels 2025', 'ly.pot': 'Fire intensity and spread potential',
  'ly.rasterNote': 'Fuels and potential are mapped within 50 km of populated places.',
  'fiche.title': 'Sheet',
  'leg.mrcTitle': 'Legend — Regional sheet', 'leg.lhTitle': 'Legend — Community sheet',
};
