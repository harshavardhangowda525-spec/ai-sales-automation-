import { useEffect, useState } from 'react';
import Icon from './Icon';
import { useToast } from './Toast';
import { api, downloadFile } from '../lib/api';
import { fmtDateTime } from '../lib/format';

export const STAGES = [
  ['NOT_STARTED', 'Not started'],
  ['PROMPT_READY', 'Prompt ready'],
  ['IN_DEVELOPMENT', 'In development'],
  ['IN_REVIEW', 'In review'],
  ['READY', 'Ready'],
  ['DELIVERED', 'Delivered'],
];
export const STAGE_LABEL = Object.fromEntries(STAGES);

/** Website build tracker + Claude Code prompt for one client. */
export default function WebsiteBuild({ client, onChanged, onReady }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [preview, setPreview] = useState(client.website_preview_url || '');
  useEffect(() => setPreview(client.website_preview_url || ''), [client.website_preview_url]);
  const idx = STAGES.findIndex(([k]) => k === client.website_stage);

  async function setStage(stage) {
    if (stage === 'READY') { onReady?.(); return; } // goes through the approval call
    setBusy('stage');
    try {
      await api(`/api/clients/${client.id}`, { method: 'PATCH', body: { website_stage: stage } });
      toast(`Website stage: ${STAGE_LABEL[stage]}`, 'success');
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  }

  async function savePreview() {
    setBusy('preview');
    try {
      await api(`/api/clients/${client.id}`, { method: 'PATCH', body: { website_preview_url: preview.trim() } });
      toast('Preview link saved', 'success');
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  }

  async function regenerate() {
    setBusy('prompt');
    try {
      const r = await api(`/api/clients/${client.id}/website-prompt`, { method: 'POST' });
      toast(r.client.website_prompt_source === 'groq' ? 'New prompt written by Groq' : 'Prompt written from template (add GROQ_API_KEY for tailored prompts)', 'success');
      setShowPrompt(true);
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(client.website_prompt); toast('Prompt copied — paste it into Claude Code', 'success'); }
    catch { toast('Copy failed — use Download instead', 'error'); }
  }

  const fileName = `${client.business_name.replace(/[^\w-]+/g, '-').toLowerCase()}-website-prompt.md`;

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base">Website build</h2>
        <span className="text-xs text-gray-500">{STAGE_LABEL[client.website_stage]}</span>
      </div>

      <ol className="mb-5 grid grid-cols-3 gap-1.5 sm:grid-cols-6" aria-label="Website stages">
        {STAGES.map(([key, label], i) => (
          <li key={key}>
            <button disabled={busy === 'stage' || key === 'DELIVERED'} onClick={() => setStage(key)}
              title={key === 'READY' ? 'Marks ready and asks you on a call before the client gets the link' : key === 'DELIVERED' ? 'Set automatically when the client is sent the link' : `Set stage: ${label}`}
              className={`w-full rounded-md px-1.5 py-2 text-[11px] font-medium leading-tight transition ${
                i < idx ? 'bg-emerald-500/15 text-emerald-300'
                  : i === idx ? 'bg-primary text-white'
                    : 'bg-line/60 text-muted hover:bg-line hover:text-ink'} disabled:cursor-default`}>
              {label}
            </button>
          </li>
        ))}
      </ol>

      <label className="label" htmlFor="preview">Preview / staging link</label>
      <div className="mt-1.5 flex gap-2">
        <input id="preview" className="input" placeholder="https://client-preview.vercel.app" value={preview} onChange={(e) => setPreview(e.target.value)} />
        <button className="btn-ghost" disabled={busy === 'preview' || preview === (client.website_preview_url || '')} onClick={savePreview}>Save</button>
      </div>

      <div className="mt-5 rounded-lg border border-line p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-ink">Claude Code build prompt</p>
            <p className="text-xs text-gray-500">
              {client.website_prompt
                ? `${client.website_prompt_source === 'groq' ? 'Written by Groq' : 'Built-in template'} · ${fmtDateTime(client.website_prompt_at)}`
                : 'Not written yet'}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {client.website_prompt && <>
              <button className="btn-ghost btn-sm" onClick={() => setShowPrompt((s) => !s)}>{showPrompt ? 'Hide' : 'View'}</button>
              <button className="btn-ghost btn-sm" onClick={copy}>Copy</button>
              <button className="btn-ghost btn-sm" onClick={() => downloadFile(`/api/clients/${client.id}/website-prompt.md`, fileName).catch((e) => toast(e.message, 'error'))}>Download .md</button>
            </>}
            <button className="btn-primary btn-sm" disabled={busy === 'prompt'} onClick={regenerate}>
              <Icon name="refresh" className={`h-3.5 w-3.5 ${busy === 'prompt' ? 'animate-spin' : ''}`} /> {client.website_prompt ? 'Rewrite' : 'Write prompt'}
            </button>
          </div>
        </div>
        {showPrompt && client.website_prompt && (
          <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-navy p-4 font-mono text-xs leading-relaxed text-gray-300">{client.website_prompt}</pre>
        )}
        <p className="mt-3 text-xs text-gray-500">
          To build: create an empty folder on your computer, open Claude Code in it, and paste this prompt
          (or save the download as <code className="text-gray-400">CLAUDE.md</code> there and ask Claude to "build the site described in CLAUDE.md").
        </p>
      </div>
    </div>
  );
}
