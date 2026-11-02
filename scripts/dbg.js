import { loadParams } from '../lib/params.js';
import { normalizeShipment, runScenario } from '../lib/engine/quote.js';
import { buildReport } from '../lib/report.js';
import { loadFacts } from '../lib/unresolved.js';

const params = loadParams();
const facts = loadFacts();
const input = { country: 'US', hsCode: '8708.91', fob: 48000, freight: 2400, qty: 1200, channel: 'B2B', exportDate: '2026-10-05', declarationDate: '2026-10-20', entryDate: '2026-10-22', metalContentPct: 0.62 };
const { shipment } = normalizeShipment(input, params);

const base = runScenario({ shipment, params });
const alt = runScenario({ shipment, params, opts: { ignoreTransitExempt: true } });
console.log('base', base.landedCost.toFixed2(), 'surtax', base.surtaxTotal.toFixed2());
console.log('alt ', alt.landedCost.toFixed2(), 'surtax', alt.surtaxTotal.toFixed2());
console.log('base lines', base.surtax.lines.map((l) => `${l.lineCode}:${l.amount.toFixed2()}:skip=${l.skipped}`));
console.log('alt  lines', alt.surtax.lines.map((l) => `${l.lineCode}:${l.amount.toFixed2()}:skip=${l.skipped}`));

const r = buildReport({ input, params, facts, reportId: 'dbg', today: params.asOf });
console.log('sensitivity', r.report.sensitivity.map((s) => [s.id, s.delta, s.metric]));
