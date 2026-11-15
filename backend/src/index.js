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
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
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
  if (!config.adminToken) console.warn('⚠️  ADMIN_TOKEN not set — dashboard API is open. Set it in production.');
});

const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => logError(null, 'UNHANDLED_REJECTION', err));

module.exports = app;
