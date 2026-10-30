// Small HTML builders shared by the panels.

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function scoreBars(scores, labels, keys = null) {
  const ks = keys || Object.keys(scores);
  return `<div class="bars">${ks.map((k) => {
    const v = Math.max(0, Math.min(1, scores[k] ?? 0));
    return `<div class="bar" title="${esc(labels[k] || k)}: ${Math.round(v * 100)}"><span class="bl">${esc(labels[k] || k)}</span><span class="bt"><i style="width:${(v * 100).toFixed(0)}%"></i></span><span class="bv">${Math.round(v * 100)}</span></div>`;
  }).join('')}</div>`;
}

export function optionCard(o, { selected, thumb, labels, keys, action = 'select-option', stage, extra = '' }) {
  return `<article class="opt ${selected ? 'is-selected' : ''}" data-action="${action}" data-stage="${stage}" data-id="${o.id}">
    <header><span class="opt-id">${esc(o.id)}</span><h4>${esc(o.title)}</h4>${o.recommended ? '<span class="tag rec" title="Highest weighted score for the current intent — a suggestion, not a decision">recommended</span>' : ''}</header>
    ${thumb ? `<div class="opt-thumb">${thumb}</div>` : ''}
    ${o.logic || o.explanation ? `<p class="logic">${esc(o.logic || o.explanation)}</p>` : ''}
    ${o.pros?.length ? `<ul class="pros">${o.pros.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${o.cons?.length ? `<ul class="cons">${o.cons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${o.scores ? `<details class="scores"><summary>Scores · ${Math.round((o.total || 0) * 100)}</summary>${scoreBars(o.scores, labels || {}, keys)}</details>` : ''}
    ${extra}
  </article>`;
}

export function messages({ errors = [], warnings = [], notes = [], ok = [] }) {
  return `${errors.map((m) => `<div class="msg err">${esc(m)}</div>`).join('')}${warnings.map((m) => `<div class="msg warn">${esc(m)}</div>`).join('')}${ok.map((m) => `<div class="msg ok">${esc(m)}</div>`).join('')}${notes.map((m) => `<div class="msg note">${esc(m)}</div>`).join('')}`;
}

export const kv = (rows) => `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;

export const section = (title, body, { open = true, hint = '' } = {}) =>
  `<details class="sec" ${open ? 'open' : ''}><summary>${esc(title)}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</summary><div class="sec-body">${body}</div></details>`;
