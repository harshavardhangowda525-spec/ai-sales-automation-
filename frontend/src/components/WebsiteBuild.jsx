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
      toast(client.github_repo ? 'Brief rewritten — click "Update CLAUDE.md in repo" to push it' : 'CLAUDE.md brief rewritten', 'success');
      setShowPrompt(true);
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(client.website_prompt); toast('Brief copied — paste it into Claude Code', 'success'); }
    catch { toast('Copy failed — use Download instead', 'error'); }
  }

  const fileName = 'CLAUDE.md';
  const [kind, setKind] = useState('website');
  const [instructions, setInstructions] = useState('');

  async function build() {
    setBusy('build');
    try {
      await api(`/api/clients/${client.id}/claude-build`, { method: 'POST', body: { kind, instructions } });
      toast('Claude has started building — you\'ll get a WhatsApp when it\'s done', 'success');
      setInstructions('');
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  }

  async function repo() {
    setBusy('repo');
    try {
      const r = await api(`/api/clients/${client.id}/github-repo`, { method: 'POST' });
      toast(client.github_repo ? 'CLAUDE.md updated in the repo' : `Private repo ${r.client.github_repo} created`, 'success');
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  }

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
            <p className="text-sm font-medium text-ink">Claude Code brief (CLAUDE.md)</p>
            <p className="text-xs text-gray-500">
              {client.website_prompt
                ? `Written ${fmtDateTime(client.website_prompt_at)}`
                : 'Not written yet'}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {client.website_prompt && <>
              <button className="btn-ghost btn-sm" onClick={() => setShowPrompt((s) => !s)}>{showPrompt ? 'Hide' : 'View'}</button>
              <button className="btn-ghost btn-sm" onClick={copy}>Copy</button>
              <button className="btn-ghost btn-sm" onClick={() => downloadFile(`/api/clients/${client.id}/website-prompt.md`, fileName).catch((e) => toast(e.message, 'error'))}>Download</button>
            </>}
            <button className="btn-primary btn-sm" disabled={busy === 'prompt'} onClick={regenerate}>
              <Icon name="refresh" className={`h-3.5 w-3.5 ${busy === 'prompt' ? 'animate-spin' : ''}`} /> {client.website_prompt ? 'Rewrite' : 'Write brief'}
            </button>
          </div>
        </div>
        {showPrompt && client.website_prompt && (
          <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-navy p-4 font-mono text-xs leading-relaxed text-gray-300">{client.website_prompt}</pre>
        )}
      </div>

      <div className="mt-4 rounded-lg border border-line p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">GitHub repo</p>
            {client.github_repo
              ? <a href={client.github_repo_url} target="_blank" rel="noreferrer" className="break-all text-xs text-blue-400 hover:underline">{client.github_repo} (private)</a>
              : <p className="text-xs text-gray-500">One private repo per client — keeps every site's code separate</p>}
          </div>
          <button className="btn-ghost btn-sm" disabled={busy === 'repo' || !client.website_prompt} onClick={repo}>
            {busy === 'repo' ? 'Working…' : client.github_repo ? 'Update CLAUDE.md in repo' : 'Create GitHub repo'}
          </button>
        </div>
        <div className="mt-3 rounded-lg bg-navy p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-ink">Build with Claude</p>
              <p className="text-xs text-gray-500">
                {client.build_status === 'running' ? 'Claude is building it now…'
                  : client.build_status === 'success' ? `Last build finished ${fmtDateTime(client.build_finished_at)}`
                    : client.build_status === 'failure' ? 'Last build failed — see the run'
                      : 'Claude builds and commits it in this client\'s repo (GitHub Actions)'}
                {client.build_run_url && <> · <a href={client.build_run_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">runs</a></>}
              </p>
            </div>
            <div className="flex gap-1.5">
              <select className="input w-auto py-1 text-xs" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Build type">
                <option value="website">Website</option>
                <option value="app">Web app</option>
              </select>
              <button className="btn-primary btn-sm" disabled={busy === 'build' || client.build_status === 'running'} onClick={build}>
                {busy === 'build' ? 'Starting…' : client.build_status === 'running' ? 'Building…' : 'Build now'}
              </button>
            </div>
          </div>
          <input className="input mt-2 text-xs" placeholder="Optional instructions, e.g. add a festival offers banner" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </div>
        <ol className="mt-3 list-decimal space-y-1 pl-4 text-xs text-gray-400">
          <li>{client.github_repo ? 'Repo is ready with CLAUDE.md.' : 'Create the repo (it gets this CLAUDE.md and a README).'}</li>
          <li>Open it in Claude Code: <a href="https://claude.ai/code" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">claude.ai/code</a> → choose the repo (or <code className="text-gray-300">claude</code> in a local clone).</li>
          <li>Say <span className="text-gray-200">"Build the website described in CLAUDE.md."</span> Claude plans in PLAN.md, then builds and commits there.</li>
          <li>Paste the preview link above and move the stage to In review → Ready.</li>
        </ol>
      </div>
    </div>
  );
}
