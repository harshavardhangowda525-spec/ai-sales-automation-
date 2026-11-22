require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const config = require('./lib/config');
const prisma = require('./lib/prisma');
const { logError } = require('./lib/logger');

const webhookRoutes = require('./routes/webhook');
const dashboardRoutes = require('./routes/dashboard');
const clientRoutes = require('./routes/clients');
const campaignRoutes = require('./routes/campaigns');
const approvalRoutes = require('./routes/approvals');
const calendarRoutes = require('./routes/calendar');
const whatsappLinkRoutes = require('./routes/whatsappLink');
const contactRoutes = require('./routes/contacts');
const waLinked = require('./services/waLinked');
const { startOwnerCallWorker } = require('./services/ownerCalls');

process.env.TZ = 'Asia/Kolkata'; // console timestamps in IST; all date math is explicit IST anyway

const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin(origin, cb) {
    // allow server-to-server calls (no Origin) and configured dashboard origins
    if (!origin || config.frontendUrls.includes(origin.replace(/\/$/, ''))) return cb(null, true);
    return cb(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
// Daily reel upload from GitHub Actions (raw MP4) — must come before the JSON parser.
app.post('/webhook/reels/upload', express.raw({ type: '*/*', limit: '80mb' }), async (req, res) => {
  try {
    if (config.webhookSecret && req.query.secret !== config.webhookSecret) return res.status(401).json({ error: 'bad secret' });
    const failed = req.query.failed === '1';
    if (!failed && (!Buffer.isBuffer(req.body) || req.body.length < 10000)) return res.status(400).json({ error: 'no video' });
    const result = await require('./services/reels').handleReelUpload({
      reelId: String(req.query.reel_id || ''), video: failed ? null : req.body, meta: req.get('x-reel-meta'), runUrl: req.get('x-run-url'), failed,
    });
    res.json(result);
  } catch (err) {
    await logError(null, 'REEL_UPLOAD', err);
    res.status(500).json({ error: err.message });
  }
});

// Public reel videos (UUID URLs) — Instagram downloads the MP4 from here; supports Range for previews.
app.get('/reels/:id.mp4', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).end();
    const r = await prisma.reel.findUnique({ where: { id: req.params.id }, select: { video: true } });
    if (!r?.video?.length) return res.status(404).send('Reel not found');
    const buf = Buffer.from(r.video);
    const range = /bytes=(\d*)-(\d*)/.exec(req.get('range') || '');
    res.set({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' });
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1 });
      return res.end(buf.subarray(start, end + 1));
    }
    res.set('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    next(err);
  }
});

app.use(express.json({ limit: '5mb' }));

app.get('/', (req, res) => res.json({ service: 'Infinity Web & Apps — sales automation', status: 'ok' }));

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: 'up', integrations: { ...config.isConfigured, whatsapp_linked: waLinked.isReady() }, time_ist: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

// Public proposal PDFs (UUID URLs, unguessable) — WhatsApp downloads the document from here.
app.get('/proposals/:id.pdf', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).end();
    const p = await prisma.proposal.findUnique({ where: { id: req.params.id }, include: { client: { select: { business_name: true } } } });
    if (!p || !p.pdf?.length) return res.status(404).send('Proposal not found');
    const filename = `${p.number} - ${p.client.business_name}`.replace(/[^\w\s.-]/g, '').trim();
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': p.pdf.length,
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${filename}.pdf"`,
      'Cache-Control': 'public, max-age=300',
    });
    res.end(Buffer.from(p.pdf));
  } catch (err) {
    next(err);
  }
});

app.use('/webhook', webhookRoutes);

// Dashboard API — protected by ADMIN_TOKEN when set (strongly recommended in production).
function requireAdmin(req, res, next) {
  if (!config.adminToken) return next();
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(token);
  const b = Buffer.from(config.adminToken);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}
app.get('/api/auth/check', requireAdmin, (req, res) => res.json({ ok: true }));
app.use('/api/dashboard', requireAdmin, dashboardRoutes);
app.use('/api/clients', requireAdmin, clientRoutes);
app.use('/api/campaigns', requireAdmin, campaignRoutes);
app.use('/api/campaign', requireAdmin, campaignRoutes);
app.use('/api/approvals', requireAdmin, approvalRoutes);
app.use('/api/calendar', requireAdmin, calendarRoutes);
app.use('/api/whatsapp', requireAdmin, whatsappLinkRoutes);
app.use('/api/reels', requireAdmin, require('./routes/reels'));
// Infinity Voice: dashboard API (admin) + local voice gateway API (its own token)
app.use('/api/voice', requireAdmin, require('./routes/voice').adminRouter);
app.use('/voice-gateway', require('./routes/voice').gatewayRouter);
// UGC robot (ugc-robot/ on the Oracle machine): bearer UGC_ROBOT_TOKEN
app.use('/ugc-robot', express.json({ limit: '100kb' }), (req, res, next) => {
  const t = config.reels.robotToken;
  if (!t) return res.status(503).json({ error: 'UGC_ROBOT_TOKEN is not set on the server' });
  if (req.get('authorization') !== `Bearer ${t}`) return res.status(401).json({ error: 'bad token' });
  next();
}, (() => {
  const r = express.Router();
  const robot = require('./services/ugcRobot');
  r.post('/heartbeat', async (req, res, next) => { try { await robot.heartbeat(req.body || {}); res.json({ ok: true, engine: config.reels.engine }); } catch (e) { next(e); } });
  r.post('/next', async (req, res, next) => { try { res.json({ job: await robot.nextJob() }); } catch (e) { next(e); } });
  return r;
})());
// Weekly report preview / send now
app.get('/api/reports/weekly', requireAdmin, async (req, res, next) => {
  try { res.json(await require('./services/weeklyReport').buildWeeklyReport()); } catch (err) { next(err); }
});
app.post('/api/reports/instagram/call', requireAdmin, async (req, res, next) => {
  try { res.json(await require('./services/weeklyReport').sendInstagramBriefing()); } catch (err) { next(err); }
});
app.post('/api/reports/weekly/send', requireAdmin, async (req, res, next) => {
  try { const r = await require('./services/weeklyReport').sendWeeklyReport('dashboard'); res.json({ ok: true, spoken: r.spoken }); } catch (err) { next(err); }
});
app.use('/api/contacts', requireAdmin, contactRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use(async (err, req, res, next) => {
  const clientId = /^[0-9a-f-]{36}$/i.test(req.params?.id || '') ? req.params.id : null;
  await logError(clientId, `HTTP_${req.method}`, err);
  const status = err.status || (err.code === 'P2025' ? 404 : 500);
  res.status(status).json({ error: status === 500 && config.nodeEnv === 'production' ? 'Internal server error' : err.message });
});

const server = app.listen(config.port, () => {
  console.log(`🚀 Infinity automation backend on :${config.port}`);
  console.log(`   Webhook: ${config.publicBaseUrl}/webhook/sarvam${config.webhookSecret ? '?secret=…' : ''}`);
  console.log('   Integrations:', config.isConfigured);
  startOwnerCallWorker();
  waLinked.resumeIfLinked().catch((err) => console.error('[whatsapp] resume failed:', err.message));
  // Render's free plan sleeps after ~15 min without inbound traffic — and a sleeping server misses the
  // 7:30 PM reel, Jarvis's calls and the WhatsApp link. Ping our own public URL every 10 minutes so it
  // never goes idle (the request goes through Render's edge, so it counts as traffic).
  if (/^https:\/\//.test(config.publicBaseUrl || '')) {
    const keepAwake = setInterval(() => {
      fetch(`${config.publicBaseUrl}/health`, { signal: AbortSignal.timeout(20000) }).catch(() => {});
    }, 10 * 60000);
    keepAwake.unref?.();
  }
  if (!config.adminToken) console.warn('⚠️  ADMIN_TOKEN not set — dashboard API is open. Set it in production.');
});

const shutdown = async () => {
  server.close();
  await waLinked.stop().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => logError(null, 'UNHANDLED_REJECTION', err));

module.exports = app;
