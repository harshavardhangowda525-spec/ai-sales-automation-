// AI provider abstraction for Infinity Voice: ClaudeProvider (Anthropic API, preferred) and
// MockProvider (deterministic, free — for pipeline tests without paid inference).
// Both return the same normalized shape:
//   { content: <blocks to append as the assistant turn>, text, toolUses: [{id,name,input}], stopReason, usage, latencyMs, provider }
const Anthropic = require('@anthropic-ai/sdk');

const AnthropicClient = Anthropic.default || Anthropic;

class ClaudeProvider {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.VOICE_CLAUDE_MODEL || 'claude-opus-5-5', effort = process.env.VOICE_CLAUDE_EFFORT || 'low' } = {}) {
    this.name = 'claude';
    this.model = model;
    this.effort = effort;
    // Keep timeouts short: a caller is waiting on the line. 1 retry for transient errors.
    this.client = new AnthropicClient({ apiKey, timeout: 20000, maxRetries: 1 });
  }

  static isConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async respond({ system, messages, tools }) {
    const t0 = Date.now();
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 2048,
      system,
      messages,
      ...(tools?.length ? { tools } : {}),
      // Low effort keeps phone replies quick; thinking stays adaptive (always on for this model).
      output_config: { effort: this.effort },
      // If a safety classifier declines, the API re-runs the turn on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    const toolUses = response.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    return {
      provider: this.name,
      model: response.model,
      content: response.content,
      text,
      toolUses,
      stopReason: response.stop_reason,
      usage: {
        input_tokens: response.usage?.input_tokens || 0,
        output_tokens: response.usage?.output_tokens || 0,
        cache_read_input_tokens: response.usage?.cache_read_input_tokens || 0,
      },
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * Deterministic stand-in: understands a few phrases so the state machine, tools and CRM writes can be
 * tested end to end without spending money. Clearly labelled as simulated everywhere it is used.
 */
class MockProvider {
  constructor() {
    this.name = 'mock';
    this.model = 'mock';
  }

  async respond({ messages }) {
    const t0 = Date.now();
    const last = messages[messages.length - 1];
    const id = () => `mock_${Math.random().toString(36).slice(2, 10)}`;
    const out = (content, stopReason) => ({
      provider: this.name, model: 'mock', content, stopReason, latencyMs: Date.now() - t0,
      text: content.filter((b) => b.type === 'text').map((b) => b.text).join(' '),
      toolUses: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input })),
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    });
    // After a tool ran, speak about its result.
    if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
      const r = String(last.content[0].content || '');
      let slots = null;
      try { slots = JSON.parse(r).slots; } catch { /* not JSON */ }
      if (slots?.length) return out([{ type: 'text', text: `(simulated) I can do ${slots.slice(0, 2).map((s) => s.label).join(' or ')}. Which suits you?` }], 'end_turn');
      return out([{ type: 'text', text: `(simulated) Done — ${r.slice(0, 120)}` }], 'end_turn');
    }
    const said = String(typeof last.content === 'string' ? last.content : last.content?.[0]?.text || '').toLowerCase();
    if (/stop calling|don.?t call|remove my number|opt out/.test(said)) {
      return out([{ type: 'tool_use', id: id(), name: 'record_opt_out', input: { reason: 'Customer asked not to be called' } }], 'tool_use');
    }
    if (/meeting|appointment|meet|book|demo|consultation/.test(said)) {
      return out([{ type: 'tool_use', id: id(), name: 'check_availability', input: { days: 5 } }], 'tool_use');
    }
    if (/discount|cheaper|reduce the price/.test(said)) {
      return out([{ type: 'tool_use', id: id(), name: 'request_owner_approval', input: { kind: 'discount', request: 'Customer asked for a discount', details: said.slice(0, 200) } }], 'tool_use');
    }
    if (/bye|thank you|that.?s all/.test(said)) {
      return out([{ type: 'tool_use', id: id(), name: 'end_call', input: { outcome: 'INFO_ONLY', summary: 'Simulated conversation ended by the customer.', next_action: '' } }], 'tool_use');
    }
    return out([{ type: 'text', text: '(simulated) Got it. Websites start at ₹4,999 and go live in about 7 days. Would you like a free 15-minute consultation with our founder?' }], 'end_turn');
  }
}

function getProvider(preferred = process.env.VOICE_AI_PROVIDER) {
  if (preferred === 'mock') return new MockProvider();
  return ClaudeProvider.isConfigured() ? new ClaudeProvider() : new MockProvider();
}

module.exports = { ClaudeProvider, MockProvider, getProvider };
