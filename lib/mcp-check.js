// x402 over MCP: an MCP server takes payment inside a tool call, not on its
// URL, so it never answers the URL with a 402. When the URL speaks MCP
// (Streamable HTTP, JSON-RPC), Doctor checks it the way an x402 MCP client
// pays: initialize, tools/list, then one unpaid tools/call per paid-looking
// tool (at most MAX_CALLS). A paid tool must answer that call with
// isError: true and the PaymentRequired object, as JSON text in content[0]
// (required by the x402 MCP transport) and preferably also as
// structuredContent. Nothing is ever paid.

const PROTOCOL_VERSION = '2025-06-18';
const MAX_CALLS = 2;
// Tool descriptions that say the tool costs money (and don't start with "Free").
const PAID_HINT = /x402|\bpaid\b|\bpay(ment)?\b|usdc|\$\s?\d|\bprice\b|per call/i;
const looksPaid = (t) => {
  const free = [t.title, t.description].some((x) => /^\s*free\b/i.test(x || ''));
  return !free && PAID_HINT.test(`${t.title || ''} ${t.description || ''}`);
};

function addCheck(checks, id, status, message, extra = {}) {
  checks.push({ id, status, message, group: 'mcp', ...extra });
}

// A JSON-RPC answer from a JSON body or an SSE stream (the "data:" lines).
function rpcAnswer(res, id) {
  const text = res.text || '';
  const candidates = [];
  const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
  if (/event-stream/i.test(type) || /^(event|data|id):/m.test(text)) {
    for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) candidates.push(line.slice(5).trim());
  } else candidates.push(text);
  for (const c of candidates) {
    try {
      const msg = JSON.parse(c);
      for (const m of Array.isArray(msg) ? msg : [msg]) if (m && m.jsonrpc === '2.0' && m.id === id) return m;
    } catch {
      // not JSON; try the next line
    }
  }
  return null;
}

function mcpClient(url, safeFetch) {
  let nextId = 1;
  let session = null;
  const headers = () => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    ...(session ? { 'mcp-session-id': session } : {}),
  });
  return {
    get session() { return session; },
    async request(method, params) {
      const id = nextId++;
      const res = await safeFetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      const sid = res.headers && typeof res.headers.get === 'function' && res.headers.get('mcp-session-id');
      if (sid) session = sid;
      return { status: res.status, message: rpcAnswer(res, id), res };
    },
    async notify(method) {
      try {
        await safeFetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', method }) });
      } catch {
        // a notification needs no answer
      }
    },
  };
}

// Example arguments from a tool's inputSchema: required fields only, from
// default / examples / enum / const, else a neutral value of the right type.
const ADDRESS = '0x0000000000000000000000000000000000000001';
const ADDRESS_NAME = /(^|_)(address|token|spender|owner|wallet|contract|account|from|to)$/i;
const AMOUNT_NAME = /(^|_)(amount|value)$/i;
function exampleArgs(schema) {
  const out = {};
  if (!schema || typeof schema !== 'object' || !schema.properties) return out;
  const required = new Set(schema.required || []);
  for (const [name, p] of Object.entries(schema.properties)) {
    // Optional fields only when they look like an address: often required in practice.
    if (required.has(name)) out[name] = exampleValue(p || {}, name);
    else if ((ADDRESS_NAME.test(name) || AMOUNT_NAME.test(name)) && (p || {}).type === 'string') out[name] = exampleValue(p, name);
  }
  return out;
}
function exampleValue(p, name = '') {
  if (p.default !== undefined) return p.default;
  if (Array.isArray(p.examples) && p.examples.length) return p.examples[0];
  if (p.const !== undefined) return p.const;
  if (Array.isArray(p.enum) && p.enum.length) return p.enum[0];
  const type = Array.isArray(p.type) ? p.type.find((t) => t !== 'null') : p.type;
  if (type === 'integer' || type === 'number') return p.minimum ?? 1;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return exampleArgs(p);
  if (typeof p.pattern === 'string' && /0x/.test(p.pattern) && /\{40\}/.test(p.pattern)) return ADDRESS;
  if (typeof p.pattern === 'string' && /0x/.test(p.pattern) && /\{64\}/.test(p.pattern)) return `0x${'0'.repeat(63)}1`;
  if (ADDRESS_NAME.test(name) && type === 'string') return ADDRESS;
  if (AMOUNT_NAME.test(name) && type === 'string') return '1000000';
  if (p.format === 'uri' || p.format === 'url' || /(^|_)(url|uri|endpoint|link)$/i.test(name)) return 'https://example.com';
  return 'test';
}

// An HTTP 402 answer to the tools/call request: PAYMENT-REQUIRED header
// (base64 or plain JSON) or a JSON body with accepts[].
function paymentRequiredOfHttp(res) {
  const header = res && res.headers && typeof res.headers.get === 'function' && (res.headers.get('payment-required') || res.headers.get('x-payment-required'));
  for (const raw of [header, res && res.text].filter(Boolean)) {
    for (const decode of [(v) => JSON.parse(v), (v) => JSON.parse(Buffer.from(v, 'base64').toString('utf8'))]) {
      try {
        const pr = asPaymentRequired(decode(String(raw).trim()));
        if (pr) return { found: pr, where: raw === header ? 'the PAYMENT-REQUIRED header' : 'the response body' };
      } catch {
        // next decoding
      }
    }
  }
  return null;
}

// A PaymentRequired object: x402Version plus an accepts[] array.
function asPaymentRequired(obj) {
  return obj && typeof obj === 'object' && Array.isArray(obj.accepts) && obj.x402Version !== undefined ? obj : null;
}
function paymentRequiredOf(result) {
  if (!result || !result.isError) return { found: null };
  const structured = asPaymentRequired(result.structuredContent);
  let inText = null;
  const first = Array.isArray(result.content) ? result.content[0] : null;
  if (first && first.type === 'text') {
    try {
      inText = asPaymentRequired(JSON.parse(first.text));
    } catch {
      // not JSON
    }
  }
  return { found: structured || inText, structured: Boolean(structured), inText: Boolean(inText) };
}

/**
 * Checks the URL as an x402 MCP server. Returns null when it does not speak
 * MCP; otherwise { challenge, mcp } where challenge is the first tool's
 * PaymentRequired (for the accepts[] checks) or null.
 */
async function checkMcp(url, safeFetch, checks) {
  const client = mcpClient(url, safeFetch);
  let init;
  try {
    init = await client.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x402-doctor', version: '1' } });
  } catch (err) {
    if (err.code === 'EBLOCKED') throw err;
    return null;
  }
  const info = init.message && init.message.result;
  if (!info || !(info.serverInfo || info.protocolVersion)) return null;

  const name = info.serverInfo ? `${info.serverInfo.name || 'unnamed'}${info.serverInfo.version ? ` ${info.serverInfo.version}` : ''}` : 'unnamed';
  await client.notify('notifications/initialized');
  const mcp = { server: info.serverInfo || null, protocolVersion: info.protocolVersion || null, session: Boolean(client.session), tools: [], calls: [] };

  const listed = await client.request('tools/list', {}).catch((err) => ({ error: err }));
  const tools = listed.message && listed.message.result && Array.isArray(listed.message.result.tools) ? listed.message.result.tools : null;
  if (!tools) {
    const why = listed.error ? listed.error.message : listed.message && listed.message.error ? listed.message.error.message : `HTTP ${listed.status}`;
    addCheck(checks, 'mcp-server', 'warn', `MCP server ${name} (protocol ${mcp.protocolVersion || '?'}), but tools/list failed: ${why}.`, {
      hint: 'x402 MCP clients list the tools before calling one; tools/list should work without payment.',
    });
    return { challenge: null, mcp };
  }
  mcp.tools = tools.map((t) => ({ name: t.name, paid_hint: looksPaid(t) }));
  addCheck(checks, 'mcp-server', 'pass', `MCP server ${name} (protocol ${mcp.protocolVersion || '?'}${mcp.session ? ', with session' : ''}): ${tools.length} tool${tools.length === 1 ? '' : 's'}, tools/list works without payment.`);

  // Only tools that say they are paid, never ones marked destructive.
  const candidates = tools.filter((t) => looksPaid(t) && !(t.annotations && t.annotations.destructiveHint === true)).slice(0, MAX_CALLS);
  if (!candidates.length) {
    addCheck(checks, 'mcp-paid-tools', 'warn', 'No tool description mentions payment (x402, USDC, a price), so Doctor did not call any tool.', {
      hint: 'Say in the tool description that it is paid and what it costs; agents choose tools by their description.',
    });
    return { challenge: null, mcp };
  }

  let challenge = null;
  for (const tool of candidates) {
    const args = exampleArgs(tool.inputSchema);
    let call;
    try {
      call = await client.request('tools/call', { name: tool.name, arguments: args });
    } catch (err) {
      if (err.code === 'EBLOCKED') throw err;
      addCheck(checks, 'mcp-payment-required', 'fail', `tools/call ${tool.name} (unpaid) failed: ${err.message}.`);
      mcp.calls.push({ tool: tool.name, error: err.message });
      continue;
    }
    const result = call.message && call.message.result;
    const rpcError = call.message && call.message.error;
    const pr = paymentRequiredOf(result);
    const http402 = call.status === 402 ? paymentRequiredOfHttp(call.res) : null;
    mcp.calls.push({ tool: tool.name, arguments: args, http: call.status, payment_required: Boolean(pr.found || (http402 && http402.found)), structured: Boolean(pr.structured), in_text: Boolean(pr.inText), http_402: Boolean(http402) });
    if (call.status === 402) {
      if (http402) {
        addCheck(checks, 'mcp-payment-required', 'warn',
          `tools/call ${tool.name} without payment answers HTTP 402 with an x402 v${http402.found.x402Version} payment requirement in ${http402.where} (${http402.found.accepts.length} option${http402.found.accepts.length === 1 ? '' : 's'}), not inside the tool result. HTTP x402 clients (fetch wrappers that retry with PAYMENT-SIGNATURE) can pay; MCP clients built on @x402/mcp expect it in the tool result and see a transport error instead.`,
          { hint: 'To serve both: keep HTTP 200 for tools/call and return { isError: true, structuredContent: paymentRequired, content: [{ type: "text", text: JSON.stringify(paymentRequired) }] }; read the payment from _meta["x402/payment"] (and keep accepting the PAYMENT-SIGNATURE header).' });
        if (!challenge) challenge = http402.found;
      } else {
        addCheck(checks, 'mcp-payment-required', 'fail', `tools/call ${tool.name} without payment answers HTTP 402 without a readable payment requirement (no PAYMENT-REQUIRED header, no accepts[] in the body).`, {
          hint: 'x402 MCP clients read the payment requirement from the tool result (@x402/mcp); HTTP clients from the PAYMENT-REQUIRED header.',
        });
      }
    } else if (pr.found) {
      const version = pr.found.x402Version;
      addCheck(checks, 'mcp-payment-required', version === 2 ? 'pass' : 'warn',
        `tools/call ${tool.name} without payment returns the x402 v${version} payment requirement (${pr.found.accepts.length} option${pr.found.accepts.length === 1 ? '' : 's'}) with isError: true.`,
        version === 2 ? {} : { hint: 'Migrate to x402 v2 (@x402/mcp).' });
      if (!pr.inText) {
        addCheck(checks, 'mcp-payment-text', 'fail', `${tool.name}: the payment requirement is only in structuredContent; the x402 MCP transport requires it as JSON text in content[0].`, {
          hint: '@x402/mcp sends both; if you build the result yourself, add { type: "text", text: JSON.stringify(paymentRequired) }.',
        });
      } else if (!pr.structured) {
        addCheck(checks, 'mcp-payment-structured', 'warn', `${tool.name}: the payment requirement is only JSON text in content[0], not also in structuredContent (preferred by x402 MCP clients).`, {
          hint: 'Add structuredContent: paymentRequired next to the text content.',
        });
      }
      if (!challenge) challenge = pr.found;
    } else if (rpcError) {
      addCheck(checks, 'mcp-payment-required', 'fail', `tools/call ${tool.name} without payment gave a JSON-RPC error (${rpcError.code}: ${rpcError.message}) instead of a payment requirement. x402 MCP clients only pay when the tool result carries one.`, {
        hint: 'Return { isError: true, structuredContent: paymentRequired, content: [{ type: "text", text: JSON.stringify(paymentRequired) }] }, as @x402/mcp does.',
      });
    } else if (result && result.isError) {
      const text = String((Array.isArray(result.content) && result.content[0] && result.content[0].text) || '');
      if (/invalid|must be|required|expected|missing|not a valid/i.test(text) && !/pay|x402|402/i.test(text)) {
        addCheck(checks, 'mcp-payment-required', 'warn', `tools/call ${tool.name}: Doctor's example arguments were refused before the payment step (${text.slice(0, 160)}), so the payment answer could not be checked for this tool.`, {
          hint: 'Checking input before asking for payment is right. An "examples" entry in the inputSchema properties lets Doctor (and agents) send valid arguments.',
        });
      } else {
        addCheck(checks, 'mcp-payment-required', 'fail', `tools/call ${tool.name} without payment returned an error without a payment requirement${text ? `: ${text.slice(0, 160)}` : ''}.`, {
          hint: 'Return the PaymentRequired object in the tool result: { isError: true, structuredContent: paymentRequired, content: [{ type: "text", text: JSON.stringify(paymentRequired) }] }.',
        });
      }
    } else if (result) {
      addCheck(checks, 'mcp-payment-required', 'warn', `tools/call ${tool.name} answered without payment, although its description says it is paid.`, {
        hint: 'Wrap the tool with the x402 payment check (@x402/mcp createPaymentWrapper), or correct the description.',
      });
    } else {
      addCheck(checks, 'mcp-payment-required', 'fail', `tools/call ${tool.name}: no JSON-RPC answer (HTTP ${call.status}).`);
    }
  }
  return { challenge, mcp };
}

module.exports = { checkMcp, exampleArgs, paymentRequiredOf, rpcAnswer };
