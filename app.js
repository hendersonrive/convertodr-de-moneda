/* =========================================================
   FXFlow – app.js  v5
   Monedas: USD · EUR · VES
   API primaria : https://api.frankfurter.dev  (USD ↔ EUR)
   API VES      : https://pydolarve.org/api/v1/dollar?page=bcv
   ========================================================= */

'use strict';

// ── Solo estas 3 monedas ───────────────────────────────────────────────────
const CURRENCIES = {
  USD: { name: 'Dólar Estadounidense', flag: '🇺🇸', symbol: '$',   code: 'USD' },
  EUR: { name: 'Euro',                 flag: '🇪🇺', symbol: '€',   code: 'EUR' },
  VES: { name: 'Bolívar Venezolano',   flag: '🇻🇪', symbol: 'Bs.', code: 'VES' },
};

const CODES = Object.keys(CURRENCIES); // ['USD', 'EUR', 'VES']

// ── Estado global ──────────────────────────────────────────────────────────
let fromCode = 'USD';
let toCode   = 'VES';
let conversionHistory = [];
let debounceTimer     = null;
let isConverting      = false;
let vesPerUsd         = null; // tasa BCV cacheada

// ── DOM refs ───────────────────────────────────────────────────────────────
const amountInput     = document.getElementById('amount-input');
const swapBtn         = document.getElementById('swap-btn');
const historyToggle   = document.getElementById('history-toggle');
const historyChevron  = document.getElementById('history-chevron');
const historyWrapper  = document.getElementById('history-list-wrapper');
const historyListEl   = document.getElementById('history-list');
const historyEmpty    = document.getElementById('history-empty');

// Resultado
const displayFromAmount = document.getElementById('display-from-amount');
const displayFromCode   = document.getElementById('display-from-code');
const displayToAmount   = document.getElementById('display-to-amount');
const displayToCode     = document.getElementById('display-to-code');
const rateForward       = document.getElementById('rate-forward');
const rateInverse       = document.getElementById('rate-inverse');
const currencySymbol    = document.getElementById('currency-symbol');

// Botones de selector
const fromBtn      = document.getElementById('from-btn');
const toBtn        = document.getElementById('to-btn');
const fromDropdown = document.getElementById('from-dropdown');
const toDropdown   = document.getElementById('to-dropdown');
const fromFlag     = document.getElementById('from-flag');
const fromCodeEl   = document.getElementById('from-code-display');
const fromNameEl   = document.getElementById('from-name-display');
const toFlag       = document.getElementById('to-flag');
const toCodeEl     = document.getElementById('to-code-display');
const toNameEl     = document.getElementById('to-name-display');

// ── Helpers de formato ─────────────────────────────────────────────────────
function fmt(num, decimals = 2) {
  return Number(num).toLocaleString('es-VE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function smartDecimals(num) {
  if (num >= 1000) return 2;
  if (num >= 1)    return 2;
  if (num >= 0.01) return 4;
  return 6;
}

function showSpinner() {
  displayToAmount.innerHTML = '<span class="spinner"></span>';
}

// ── Sync UI de botones ─────────────────────────────────────────────────────
function syncBtnUI() {
  const f = CURRENCIES[fromCode];
  const t = CURRENCIES[toCode];
  fromFlag.textContent = f.flag;
  fromCodeEl.textContent = fromCode;
  fromNameEl.textContent = f.name;
  currencySymbol.textContent = f.symbol;

  toFlag.textContent = t.flag;
  toCodeEl.textContent = toCode;
  toNameEl.textContent = t.name;
}

// ── Dropdown custom ────────────────────────────────────────────────────────
function buildDropdownItems(dropdown, currentCode, onSelect) {
  dropdown.innerHTML = '';
  CODES.forEach(code => {
    const m    = CURRENCIES[code];
    const item = document.createElement('button');
    item.className   = 'dd-item' + (code === currentCode ? ' dd-item--active' : '');
    item.type        = 'button';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', code === currentCode);
    item.innerHTML = `
      <span class="dd-item__flag">${m.flag}</span>
      <span class="dd-item__info">
        <span class="dd-item__code">${code}</span>
        <span class="dd-item__name">${m.name}</span>
      </span>
      ${code === currentCode ? '<span class="dd-item__check">✓</span>' : ''}
    `;
    item.addEventListener('click', () => {
      onSelect(code);
      closeAllDropdowns();
    });
    dropdown.appendChild(item);
  });
}

function openDropdown(btn, dropdown, currentCode, onSelect) {
  const isOpen = dropdown.classList.contains('open');
  closeAllDropdowns();
  if (isOpen) return;
  buildDropdownItems(dropdown, currentCode, onSelect);
  dropdown.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  btn.querySelector('.currency-btn__chevron').style.transform = 'rotate(180deg)';
}

function closeAllDropdowns() {
  [fromDropdown, toDropdown].forEach(d => d.classList.remove('open'));
  [fromBtn, toBtn].forEach(b => {
    b.setAttribute('aria-expanded', 'false');
    b.querySelector('.currency-btn__chevron').style.transform = 'rotate(0deg)';
  });
}

fromBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openDropdown(fromBtn, fromDropdown, fromCode, (code) => {
    if (code === toCode) { toCode = fromCode; }
    fromCode = code;
    syncBtnUI();
    scheduleConvert();
  });
});

toBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openDropdown(toBtn, toDropdown, toCode, (code) => {
    if (code === fromCode) { fromCode = toCode; }
    toCode = code;
    syncBtnUI();
    scheduleConvert();
  });
});

// Cerrar al hacer clic fuera
document.addEventListener('click', closeAllDropdowns);

// ── Obtener tasa VES BCV (pydolarve) ──────────────────────────────────────
async function fetchVesRate() {
  // Intentar pydolarve.org (API pública venezolana con tasa BCV)
  try {
    const res  = await fetch('https://pydolarve.org/api/v1/dollar?page=bcv');
    if (res.ok) {
      const data = await res.json();
      // El precio viene en data.price (USD → VES según BCV)
      if (data && data.price) {
        vesPerUsd = parseFloat(data.price);
        return vesPerUsd;
      }
    }
  } catch (_) {}

  // Fallback: ExchangeRate.host (algunos tienen VES)
  try {
    const res  = await fetch('https://open.er-api.com/v6/latest/USD');
    if (res.ok) {
      const data = await res.json();
      if (data.rates && data.rates.VES) {
        vesPerUsd = data.rates.VES;
        return vesPerUsd;
      }
    }
  } catch (_) {}

  // Fallback final: tasa referencial BCV aproximada
  vesPerUsd = 46.5;
  return vesPerUsd;
}

// ── Obtener tasa entre dos monedas ────────────────────────────────────────
async function fetchRate(from, to) {
  if (from === to) return 1;

  const involveVes = from === 'VES' || to === 'VES';

  if (involveVes) {
    const usdVes = await fetchVesRate();
    if (from === 'USD' && to === 'VES') return usdVes;
    if (from === 'VES' && to === 'USD') return 1 / usdVes;

    // EUR ↔ VES  →  pasar por USD
    const eurUsd = await fetchFrankfurter('EUR', 'USD');
    if (from === 'EUR' && to === 'VES') return eurUsd * usdVes;
    if (from === 'VES' && to === 'EUR') return (1 / usdVes) * (1 / eurUsd);
  }

  return fetchFrankfurter(from, to);
}

async function fetchFrankfurter(from, to) {
  // Primario: frankfurter.dev
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`);
    if (r.ok) {
      const d = await r.json();
      if (d.rates && d.rates[to] !== undefined) return d.rates[to];
    }
  } catch (_) {}
  // Fallback: open.er-api
  const r2 = await fetch(`https://open.er-api.com/v6/latest/${from}`);
  if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
  const d2 = await r2.json();
  if (d2.rates && d2.rates[to] !== undefined) return d2.rates[to];
  throw new Error(`Tasa para ${to} no disponible`);
}

// ── Conversión principal ───────────────────────────────────────────────────
async function convert(addToHistory = true) {
  const amount = parseFloat(amountInput.value);
  syncBtnUI();

  if (isNaN(amount) || amount < 0) {
    displayFromAmount.textContent = '—';
    displayToAmount.textContent   = '—';
    displayFromCode.textContent   = fromCode;
    displayToCode.textContent     = toCode;
    rateForward.textContent = '';
    rateInverse.textContent = '';
    return;
  }

  if (isConverting) return;
  isConverting = true;
  showSpinner();

  try {
    const rate      = await fetchRate(fromCode, toCode);
    const converted = amount * rate;
    const decimals  = smartDecimals(converted);

    displayFromAmount.textContent = fmt(amount);
    displayFromCode.textContent   = fromCode;
    displayToAmount.textContent   = fmt(converted, decimals);
    displayToCode.textContent     = toCode;

    const fwdDec = smartDecimals(rate);
    const inv    = 1 / rate;
    const invDec = smartDecimals(inv);

    const vesNote = (fromCode === 'VES' || toCode === 'VES') ? ' (BCV ref.)' : '';
    rateForward.textContent = `1 ${fromCode} = ${fmt(rate, fwdDec)} ${toCode}${vesNote}`;
    rateInverse.textContent = `1 ${toCode} = ${fmt(inv, invDec)} ${fromCode}`;

    if (addToHistory) {
      addHistoryEntry(amount, fromCode, converted, decimals, toCode, rate);
    }
  } catch (err) {
    displayToAmount.textContent = 'Error';
    rateForward.textContent     = 'No se pudo obtener el tipo de cambio';
    rateInverse.textContent     = '';
    console.error('Error de conversión:', err);
  } finally {
    isConverting = false;
  }
}

// ── Historial ──────────────────────────────────────────────────────────────
function timeAgo(date) {
  const diff  = Date.now() - date.getTime();
  const secs  = Math.floor(diff / 1000);
  const mins  = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (secs < 10)   return 'Ahora mismo';
  if (secs < 60)   return `Hace ${secs} seg`;
  if (mins < 60)   return `Hace ${mins} min${mins > 1 ? 's' : ''}`;
  if (hours < 24)  return `Hace ${hours} hora${hours > 1 ? 's' : ''}`;
  return date.toLocaleString('es-VE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function addHistoryEntry(fromAmt, fCode, toAmt, toDec, tCode, rate) {
  conversionHistory.unshift({ fromAmt, fCode, toAmt, toDec, tCode, rate, date: new Date() });
  if (conversionHistory.length > 20) conversionHistory.pop();
  renderHistory();
}

function renderHistory() {
  historyListEl.innerHTML = '';
  if (conversionHistory.length === 0) {
    historyListEl.appendChild(historyEmpty);
    return;
  }
  conversionHistory.forEach((e, i) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.setAttribute('role', 'listitem');
    item.style.animationDelay = `${i * 40}ms`;
    const rd = smartDecimals(e.rate);
    const vesNote = (e.fCode === 'VES' || e.tCode === 'VES') ? '<span class="history-item__ves">BCV</span>' : '';
    item.innerHTML = `
      <div class="history-item__left">
        <span class="history-item__conversion">
          ${CURRENCIES[e.fCode].flag} ${fmt(e.fromAmt)} ${e.fCode}
          <span class="history-arrow">→</span>
          ${CURRENCIES[e.tCode].flag} ${fmt(e.toAmt, e.toDec)} ${e.tCode}
        </span>
        <span class="history-item__time" data-ts="${e.date.getTime()}">${timeAgo(e.date)}</span>
      </div>
      <span class="history-item__rate">${fmt(e.rate, rd)} Tasa ${vesNote}</span>
    `;
    historyListEl.appendChild(item);
  });
}

setInterval(() => {
  document.querySelectorAll('.history-item__time[data-ts]').forEach(el => {
    el.textContent = timeAgo(new Date(Number(el.dataset.ts)));
  });
}, 30_000);

// ── Toggle historial ───────────────────────────────────────────────────────
let historyOpen = true;
historyChevron.classList.add('open');
historyToggle.addEventListener('click', () => {
  historyOpen = !historyOpen;
  historyWrapper.classList.toggle('collapsed', !historyOpen);
  historyChevron.classList.toggle('open', historyOpen);
  historyToggle.setAttribute('aria-expanded', historyOpen);
});

// ── Swap ───────────────────────────────────────────────────────────────────
swapBtn.addEventListener('click', () => {
  [fromCode, toCode] = [toCode, fromCode];
  syncBtnUI();
  scheduleConvert();
});

// ── Debounce ───────────────────────────────────────────────────────────────
function scheduleConvert() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => convert(true), 600);
}
amountInput.addEventListener('input', scheduleConvert);

// ── Init ───────────────────────────────────────────────────────────────────
syncBtnUI();
convert(false);
setInterval(() => convert(false), 60_000);
