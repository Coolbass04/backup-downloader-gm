// ==UserScript==
// @name         Backup Sequence Stepper
// @namespace    local.tools
// @version      3.0.0
// @description  Increment the trailing counter in a filter query, then activate the first matching row's link. Runs once per trigger.
// @author       you
// @match        https://thepiratebay.org/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config — the only part you should need to touch.
  // ---------------------------------------------------------------------------
  const CFG = {
    // The filter box that narrows the list as you type.
    filterInput: '#flist',

    // Every row of the list, hidden or not. Must be in display order.
    row: '#torrents li.list-entry',

    // The element inserted banners sit above. Falls back to the input's parent.
    listContainer: '#torrents',

    // The link inside a row to activate. First match inside the row wins.
    // Try several in order, so a row missing one still works.
    rowLinks: ['a[href^="magnet:"]', 'a[href$=".torrent"]', 'a'],

    // 'click'    — synthesize a click. For a magnet this hands off to your
    //              torrent client and leaves the page where it is.
    // 'open'     — window.open in a new tab
    // 'navigate' — set location.href
    // 'copy'     — copy the href to the clipboard, don't leave the page
    action: 'click',

    // How many trailing digits form the counter. 2 means the last two digits
    // of the last number in the query get incremented, whether that's
    // 20260301, 2026March01, or week-01.
    counterDigits: 2,

    // Highest counter value worth trying. Past this the filter can only come
    // back empty, so the script stops instead of running a pointless query.
    // Set to null to keep going until the list comes back empty.
    maxValue: 31,

    // How long to wait for the list to settle after typing, in ms.
    settleQuiet: 150,
    settleTimeout: 3000,

    // Trigger: Ctrl+Shift+D. Set to null to rely on the Tampermonkey menu only.
    hotkey: { key: 'D', ctrl: true, shift: true, alt: false },

    // Where to put the trigger button.
    // 'inline'   — immediately after the filter input
    // 'floating' — fixed in the bottom-right corner
    // 'none'     — no button; use the hotkey or the Tampermonkey menu
    buttonPlacement: 'inline',

    // Button text. Kept short so it sits comfortably beside the input.
    buttonLabel: 'Next',
  };

  const STORE_KEY = 'backup-stepper:last-query';
  const BANNER_ID = 'episode-stepper-banner';
  let running = false;

  // ---------------------------------------------------------------------------
  // Counter handling
  // ---------------------------------------------------------------------------

  // The last run of digits anywhere in the query. The lookahead means "no more
  // digits after this", so trailing text like .tar or _full doesn't matter.
  const TOKEN = /(\d+)(?!.*\d)/;

  // Increments the last counterDigits digits of that run and leaves everything
  // before them alone. 20260301 -> 20260302, 2026March01 -> 2026March02,
  // snapshot-09 -> snapshot-10. Zero padding is preserved.
  function bumpCounter(query) {
    const m = query.match(TOKEN);
    if (!m) return { error: 'no-token' };

    const run = m[1];
    // A short run just gets used whole: "day-9" still steps to "day-10".
    const width = Math.min(CFG.counterDigits, run.length);
    const head = run.slice(0, run.length - width);
    const next = parseInt(run.slice(run.length - width), 10) + 1;

    if (CFG.maxValue !== null && next > CFG.maxValue) {
      return { error: 'past-max', value: next };
    }

    const bumped = head + String(next).padStart(width, '0');
    return {
      query: query.slice(0, m.index) + bumped + query.slice(m.index + run.length),
      counter: bumped,
    };
  }

  // ---------------------------------------------------------------------------
  // Driving the page's own filter
  // ---------------------------------------------------------------------------

  // Assigning .value directly can be ignored by React/Vue and by anything
  // tracking the property. Go through the native setter, then announce it.
  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(input, value);

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        key: 'a',
        code: 'KeyA',
        keyCode: 65,
        which: 65,
      })
    );
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Resolves once the list stops mutating, or when the timeout expires.
  // Handles both synchronous filters (nothing mutates after our keyup) and
  // async ones that fetch.
  function waitForSettle(target) {
    return new Promise((resolve) => {
      let quietTimer = setTimeout(done, CFG.settleQuiet);
      const hardStop = setTimeout(done, CFG.settleTimeout);

      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, CFG.settleQuiet);
      });

      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden'],
      });

      function done() {
        clearTimeout(quietTimer);
        clearTimeout(hardStop);
        observer.disconnect();
        resolve();
      }
    });
  }

  function visibleRows() {
    return Array.from(document.querySelectorAll(CFG.row)).filter((row) => {
      if (row.hidden) return false;
      // offsetParent covers display:none on the row or any ancestor.
      // The computed-style check catches position:fixed rows.
      if (row.offsetParent !== null) return true;
      return getComputedStyle(row).display !== 'none';
    });
  }

  function firstLinkIn(row) {
    for (const sel of CFG.rowLinks) {
      const link = row.querySelector(sel);
      if (link && link.getAttribute('href')) return link;
    }
    return null;
  }

  async function activate(link) {
    const href = link.href;

    switch (CFG.action) {
      case 'open':
        window.open(href, '_blank', 'noopener');
        break;
      case 'navigate':
        location.href = href;
        break;
      case 'copy':
        try {
          await navigator.clipboard.writeText(href);
        } catch {
          showBanner('Copy blocked', 'The browser refused clipboard access. Click the row yourself.');
          return false;
        }
        break;
      default:
        link.click();
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Inline banner
  // ---------------------------------------------------------------------------

  function anchorEl() {
    return (
      document.querySelector(CFG.listContainer) ||
      document.querySelector(CFG.filterInput)?.parentElement ||
      document.body
    );
  }

  function clearBanner() {
    document.getElementById(BANNER_ID)?.remove();
  }

  function showBanner(heading, detail) {
    clearBanner();

    const el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'alert');
    el.innerHTML = `
      <strong class="es-heading"></strong>
      <span class="es-detail"></span>
      <button type="button" class="es-close" aria-label="Dismiss">&times;</button>
    `;
    el.querySelector('.es-heading').textContent = heading;
    el.querySelector('.es-detail').textContent = detail;
    el.querySelector('.es-close').addEventListener('click', clearBanner);

    const anchor = anchorEl();
    anchor.parentNode.insertBefore(el, anchor);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function injectStyles() {
    const css = document.createElement('style');
    css.textContent = `
      #${BANNER_ID} {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin: 14px 0;
        padding: 14px 18px;
        background: #ffe500;
        color: #1a1a00;
        border: 3px solid #d10000;
        border-radius: 3px;
        font: 700 17px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        letter-spacing: 0.01em;
        box-shadow: 0 2px 0 #d10000;
      }
      #${BANNER_ID} .es-heading {
        color: #b00000;
        font-size: 19px;
        white-space: nowrap;
      }
      #${BANNER_ID} .es-detail {
        font-weight: 500;
        flex: 1;
        min-width: 0;
      }
      #${BANNER_ID} .es-close {
        all: unset;
        cursor: pointer;
        padding: 0 6px;
        font-size: 22px;
        line-height: 1;
        color: #b00000;
      }
      #${BANNER_ID} .es-close:focus-visible {
        outline: 2px solid #1a1a00;
        outline-offset: 2px;
      }
      #episode-stepper-btn {
        padding: 4px 12px;
        background: #1a1a1a;
        color: #fff;
        border: 1px solid #555;
        border-radius: 4px;
        cursor: pointer;
        font: 600 13px/1.5 system-ui, sans-serif;
        vertical-align: middle;
      }
      #episode-stepper-btn:hover:not([disabled]) { background: #333; }
      #episode-stepper-btn:focus-visible {
        outline: 2px solid #d10000;
        outline-offset: 2px;
      }
      #episode-stepper-btn[disabled] { opacity: 0.5; cursor: default; }
      #episode-stepper-btn.es-inline { margin: 0 10px 0 6px; }
      #episode-stepper-btn.es-floating {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483000;
        padding: 9px 14px;
      }
    `;
    document.head.appendChild(css);
  }

  // ---------------------------------------------------------------------------
  // The run
  // ---------------------------------------------------------------------------

  async function run() {
    if (running) return;
    running = true;
    setButtonState(false);
    clearBanner();

    try {
      const input = document.querySelector(CFG.filterInput);
      if (!input) {
        showBanner('No filter box', `Nothing on this page matches ${CFG.filterInput}.`);
        return;
      }

      // Use what's in the box. If it's empty, fall back to the last query we ran,
      // which is what you want after a click navigated away and you came back.
      const current = input.value.trim() || (await GM_getValue(STORE_KEY, ''));
      if (!current) {
        showBanner('Nothing to step', 'Type a query ending in a number, then trigger again.');
        return;
      }

      const step = bumpCounter(current);

      if (step.error === 'no-token') {
        showBanner('No number found', `There's no number to increment in "${current}".`);
        return;
      }
      if (step.error === 'past-max') {
        showBanner(
          'End of the run',
          `${step.value} is past the ${CFG.maxValue} limit. Start a new query to keep going.`
        );
        return;
      }

      setInputValue(input, step.query);
      await GM_setValue(STORE_KEY, step.query);
      await waitForSettle(anchorEl());

      const rows = visibleRows();
      if (rows.length === 0) {
        showBanner('No results', `Nothing matches "${step.query}". The filter box is holding that query.`);
        return;
      }

      const link = firstLinkIn(rows[0]);
      if (!link) {
        showBanner('No link in the first row', 'Check the rowLinks selectors in the script config.');
        return;
      }

      await activate(link);
    } catch (err) {
      console.error('[Backup Sequence Stepper]', err);
      showBanner('Script error', String(err && err.message ? err.message : err));
    } finally {
      // The script goes idle here. Nothing re-arms it but you.
      running = false;
      setButtonState(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Triggers
  // ---------------------------------------------------------------------------

  function setButtonState(enabled) {
    const btn = document.getElementById('episode-stepper-btn');
    if (btn) btn.disabled = !enabled;
  }

  function matchesHotkey(e) {
    const k = CFG.hotkey;
    if (!k) return false;
    return (
      e.key.toUpperCase() === k.key.toUpperCase() &&
      e.ctrlKey === !!k.ctrl &&
      e.shiftKey === !!k.shift &&
      e.altKey === !!k.alt
    );
  }

  function init() {
    injectStyles();

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Step to next item', run);
    }

    if (CFG.hotkey) {
      window.addEventListener('keydown', (e) => {
        if (matchesHotkey(e)) {
          e.preventDefault();
          run();
        }
      });
    }

    if (CFG.buttonPlacement !== 'none') addButton();
  }

  function addButton() {
    if (document.getElementById('episode-stepper-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'episode-stepper-btn';
    btn.type = 'button';
    btn.textContent = CFG.buttonLabel;
    btn.title = 'Bump the episode number and open the first match';
    btn.addEventListener('click', run);

    const input =
      CFG.buttonPlacement === 'inline'
        ? document.querySelector(CFG.filterInput)
        : null;

    if (input) {
      btn.classList.add('es-inline');
      // insertAdjacentElement keeps the button a sibling of the input, so it
      // lands between the box and whatever follows it (the quick filters).
      input.insertAdjacentElement('afterend', btn);
    } else {
      // Either the placement is 'floating', or we asked for inline and the
      // input isn't in the DOM yet. Corner button works in both cases.
      btn.classList.add('es-floating');
      document.body.appendChild(btn);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();