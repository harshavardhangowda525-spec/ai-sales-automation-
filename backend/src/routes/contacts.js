const express = require('express');
const prisma = require('../lib/prisma');
const { toE164 } = require('../lib/phone');
const { callContact } = require('../services/relayCalls');

const router = express.Router();
const clean = (b = {}) => {
  const phone = String(b.phone || '').replace(/\D/g, '');
  return {
    name: String(b.name || '').trim().slice(0, 80),
    aliases: String(b.aliases || '').trim().slice(0, 300) || null,
    phone: phone.length >= 10 ? toE164(phone) : null,
    notes: String(b.notes || '').trim().slice(0, 1000) || null,
  };
};

// GET /api/contacts
router.get('/', async (req, res, next) => {
  try {
    const contacts = await prisma.contact.findMany({ orderBy: { name: 'asc' } });
    const recent = await prisma.relayCall.findMany({ orderBy: { created_at: 'desc' }, take: 10 });
    res.json({ contacts, recent_calls: recent });
  } catch (err) { next(err); }
});

// POST /api/contacts { name, phone, aliases?, notes? }
router.post('/', async (req, res, next) => {
  try {
    const d = clean(req.body);
    if (!d.name || !d.phone) return res.status(400).json({ error: 'Name and a valid phone number are required' });
    res.status(201).json(await prisma.contact.create({ data: d }));
  } catch (err) { next(err); }
});

// PATCH /api/contacts/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const d = clean(req.body);
    if (!d.name || !d.phone) return res.status(400).json({ error: 'Name and a valid phone number are required' });
    res.json(await prisma.contact.update({ where: { id: req.params.id }, data: d }));
  } catch (err) { next(err); }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.contact.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/contacts/:id/call { message } — same as asking Jarvis, from the dashboard
router.post('/:id/call', async (req, res, next) => {
  try {
    const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'What should Jarvis say?' });
    res.json({ ok: true, relay: await callContact({ contact, message }) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
