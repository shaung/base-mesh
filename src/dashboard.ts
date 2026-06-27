import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './log.js';

// ---------------------------------------------------------------------------
// Executor Dashboard — web UI for browsing Claude execution session logs.
// Files: <sessionDir>/<ticketId>/<roundId>.jsonl (one JSONL per round).
// ---------------------------------------------------------------------------

interface SessionEntry {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

function scanSessions(sessionDir: string): { ticketId: string; sessions: string[] }[] {
  if (!existsSync(sessionDir)) return [];
  const entries = readdirSync(sessionDir, { withFileTypes: true });
  const tickets = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const ticketDir = join(sessionDir, entry.name);
    const files = readdirSync(ticketDir).filter(f => f.endsWith('.jsonl'));
    const sessions = files.map(f => join(ticketDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (sessions.length > 0) tickets.set(entry.name, sessions);
  }
  return Array.from(tickets.entries()).map(([ticketId, sessions]) => ({ ticketId, sessions }))
    .sort((a, b) => statSync(b.sessions[0]).mtimeMs - statSync(a.sessions[0]).mtimeMs);
}

function parseSessionFile(path: string): SessionEntry[] {
  try {
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function getRounds(sessionDir: string, ticketId: string) {
  const ticketDir = join(sessionDir, ticketId);
  if (!existsSync(ticketDir)) return [];
  const files = readdirSync(ticketDir).filter(f => f.endsWith('.jsonl'));
  return files.map(f => {
    const path = join(ticketDir, f);
    const entries = parseSessionFile(path);
    entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    return { roundId: f.replace('.jsonl', ''), entries, updatedAt: statSync(path).mtimeMs };
  }).sort((a, b) => a.updatedAt - b.updatedAt);
}

const CSS = `
:root {
  --bg: #0a0a0f; --surface: #13131a; --surface2: #1a1a24; --border: #252530;
  --text: #d4d4dc; --muted: #6b6b7b; --accent: #7c8aff; --green: #44c9a1;
  --amber: #e5a845; --red: #e5535b; --radius: 8px; --font: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font);background:var(--bg);color:var(--text);display:flex;height:100vh;overflow:hidden}
.sidebar{width:280px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sidebar-header{padding:20px 20px 16px;border-bottom:1px solid var(--border)}
.sidebar-header h1{font-size:14px;font-weight:600;color:var(--text);letter-spacing:.5px}
.sidebar-header .stat{font-size:11px;color:var(--muted);margin-top:4px}
.ticket-list{flex:1;overflow-y:auto;padding:8px}
.ticket{display:flex;align-items:flex-start;gap:5px;padding:12px 16px;cursor:pointer;border-radius:var(--radius);margin-bottom:2px;transition:background .15s}
.ticket:hover{background:var(--surface2)}
.ticket.active{background:var(--surface2);box-shadow:inset 2px 0 0 var(--accent)}
.ticket .dot{width:6px;height:6px;border-radius:50%;background:var(--green);margin-top:5px;flex-shrink:0}
.ticket .info{flex:1;min-width:0}
.ticket .tid{font-size:12px;font-weight:600;color:var(--accent);font-family:monospace}
.ticket .meta{font-size:11px;color:var(--muted);margin-top:2px}
.round-list{max-height:0;overflow:hidden;transition:max-height .3s;border-top:1px solid var(--border);padding:0 8px}
.round-list.open{max-height:300px;overflow-y:auto;padding:8px}
.round-entry{display:flex;align-items:flex-start;gap:5px;padding:10px 12px;cursor:pointer;border-radius:var(--radius);margin-bottom:2px;transition:background .15s;font-size:11px}
.round-entry:hover{background:var(--surface2)}
.round-entry .num{color:var(--accent);font-weight:600;font-family:monospace;font-size:11px;white-space:nowrap}
.round-entry .preview{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;margin-left:6px}
.main{flex:1;overflow-y:auto;padding:32px 40px}
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--muted)}
.empty-state .icon{font-size:48px;margin-bottom:16px;opacity:.3}
.empty-state p{font-size:14px}
.round-section{margin-bottom:40px}
.round-header{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.round-number{font-size:11px;font-weight:600;color:var(--accent);text-transform:uppercase;letter-spacing:1px;background:var(--surface2);padding:4px 10px;border-radius:4px}
.round-id{font-size:12px;color:var(--muted);font-family:monospace}
.round-meta{font-size:11px;color:var(--muted)}
.round-turn{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;margin-bottom:16px;font-size:13px}
.round-turn .turn-role{color:var(--green);font-size:11px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
.round-turn .turn-text{color:var(--text);line-height:1.5;white-space:pre-wrap}
.timeline{padding-left:8px}
.entry{display:flex;gap:14px;padding:10px 0;border-bottom:1px solid var(--border);align-items:flex-start}
.entry:last-child{border-bottom:none}
.entry .dot{width:8px;height:8px;border-radius:50%;margin-top:5px;flex-shrink:0;background:var(--muted)}
.entry.assistant .dot{background:var(--accent)}
.entry.tool .dot{background:var(--amber)}
.entry.error .dot{background:var(--red)}
.entry .body{flex:1;min-width:0}
.entry .label{font-size:13px;display:flex;align-items:center;gap:8px}
.entry .label .tag{font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:.5px}
.entry .label .tag.t-assistant{background:rgba(124,138,255,.15);color:var(--accent)}
.entry .label .tag.t-tool{background:rgba(229,168,69,.15);color:var(--amber)}
.entry .label .tag.t-error{background:rgba(229,83,91,.15);color:var(--red)}
.entry .label .tag.t-system{background:rgba(107,107,123,.15);color:var(--muted)}
.entry .time{font-size:11px;color:var(--muted);white-space:nowrap}
.entry .detail{font-size:12px;color:var(--text);line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:3.6em;overflow:hidden;cursor:pointer;background:var(--surface);padding:10px 14px;border-radius:var(--radius);margin-top:4px;position:relative;transition:max-height .3s,background .15s;font-family:monospace}
.entry .detail:hover{background:var(--surface2)}
.entry .detail.expanded{max-height:none}
.entry .detail::after{content:'';position:absolute;bottom:0;left:0;right:0;height:1.8em;background:linear-gradient(transparent,var(--surface));pointer-events:none;transition:opacity .2s}
.entry .detail.expanded::after,.entry .detail:not(.overflow)::after{opacity:0}
.entry .summary{font-size:12px;color:var(--muted);line-height:1.4;margin-top:4px}
@media(max-width:768px){body{flex-direction:column}.sidebar{width:100%;max-height:40vh}.main{padding:20px}}
`;

function html(sessionDir: string): string {
  const tickets = scanSessions(sessionDir);
  const ticketList = tickets.map(t => ({
    ticketId: t.ticketId,
    count: t.sessions.length,
    updated: t.sessions[0] ? new Date(statSync(t.sessions[0]).mtimeMs).toLocaleString('zh') : '',
  }));

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Executor Dashboard</title><style>${CSS}</style></head><body>
<div class="sidebar">
  <div class="sidebar-header"><h1>Executions</h1><div class="stat">${ticketList.length} ticket${ticketList.length!==1?'s':''}</div></div>
  <div class="ticket-list">
    ${ticketList.map(t => `
    <div class="ticket" data-id="${t.ticketId}" onclick="load('${t.ticketId}')">
      <div class="dot"></div>
      <div class="info"><div class="tid">${t.ticketId}</div>
      <div class="meta">${t.count} round${t.count!==1?'s':''} &middot; ${t.updated}</div></div>
    </div>`).join('')}
  </div>
  <div class="round-list" id="round-list"></div>
</div>
<div class="main" id="main"><div class="empty-state"><div class="icon">&#9670;</div><p>Select a ticket from the sidebar</p></div></div>
<script>
  function E(v){return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  function S(v,m){var t=typeof v==='string'?v:(v?JSON.stringify(v,null,2):'');return t.slice(0,m||50000)}
  function tag(c,t){return'<span class="tag t-'+c+'">'+t+'</span>'}

  // Expand a single assistant message.content[] block into one or more timeline entries.
  // Each block (text, tool_use, tool_result, thinking) gets its own row.
  function renderBlocks(container, time) {
    var blocks = [];
    var msg = container.message || {};
    var usage = msg.usage;

    // Build text summary from content blocks
    var texts = [], toolCalls = 0, toolResults = 0, thinkings = 0;
    (msg.content || []).forEach(function (b) {
      if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'tool_use') toolCalls++;
      else if (b.type === 'tool_result') toolResults++;
      else if (b.type === 'thinking') thinkings++;
    });

    // Single summary row
    var lbl = 'Claude';
    var extras = [];
    if (texts.length) extras.push(texts.join(' ').slice(0, 120));
    if (toolCalls) extras.push(toolCalls + ' tool call' + (toolCalls > 1 ? 's' : ''));
    if (toolResults) extras.push(toolResults + ' tool result' + (toolResults > 1 ? 's' : ''));
    if (thinkings) extras.push(thinkings + ' thought' + (thinkings > 1 ? 's' : ''));
    if (usage) extras.push(usage.input_tokens + ' in / ' + usage.output_tokens + ' out');
    lbl += extras.length ? ': ' + extras.join(', ') : '';

    // Detail shows full content of each block
    var det = (msg.content || []).map(function (b) {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return '[Tool: ' + b.name + ']&#10;' + S(b.input, 3000);
      if (b.type === 'tool_result') return '[Result' + (b.is_error ? ' (error)' : '') + ']&#10;' + S(b.content, 3000);
      if (b.type === 'thinking') return '[Thinking]&#10;' + b.thinking;
      return S(b, 1000);
    }).join('&#10;&#10;---&#10;&#10;');

    var row = '<div class="entry assistant"><div class="dot"></div><div class="body"><div class="label"><span class="time">'+time+'</span>'+E(lbl)+'</div>';
    if (det.trim()) row += '<div class="detail">'+E(det)+'</div>';
    row += '</div></div>';
    return row;
  }

  function render(e){
    var cls = '', lbl = '', det = '';
    var time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('zh') : '';

    // Custom log entries
    if (e.type === 'execution-start') {
      cls = 'tool'; lbl = 'Execution started (' + (e.promptLength || 0) + ' chars prompt)';
      det = S(e.prompt, 3000);
    } else if (e.type === 'execution-end') {
      cls = 'tool'; lbl = 'Completed' + (e.exitCode ? ' (exit ' + e.exitCode + ')' : '') + ' in ' + Math.round((e.elapsedMs || 0) / 1000) + 's';
      det = S(e.stdout || e.stderr, 2000);
    } else if (e.type === 'result') {
      cls = 'assistant'; lbl = 'Final result';
      det = e.answer || e.result || '';
    } else if (e.type === 'error') {
      cls = 'error'; lbl = 'Error';
      det = S(e.message || e.error);
    }

    // Claude stream-json events
    else if (e.type === 'assistant') {
      return renderBlocks(e, time);
    } else if (e.type === 'user') {
      // User messages can contain text, images, tool results, documents
      var uc = (e.message && e.message.content) || [];
      var uBlocks = Array.isArray(uc) ? uc : [uc];
      var uTexts = [];
      uBlocks.forEach(function (b) {
        if (typeof b === 'string') uTexts.push(b);
        else if (b.type === 'text') uTexts.push(b.text);
        else if (b.type === 'tool_result') uTexts.push('[Tool result] ' + S(b.content, 200));
        else uTexts.push(S(b, 200));
      });
      cls = 'tool'; lbl = 'User: ' + uTexts.join(', ').slice(0, 120);
      det = uBlocks.map(function (b) {
        if (typeof b === 'string') return b;
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_result') return '[Tool result' + (b.is_error ? ' (error)' : '') + ']&#10;' + S(b.content, 3000);
        return S(b, 2000);
      }).join('&#10;&#10;---&#10;&#10;');
    } else if (e.type === 'tool_use') {
      cls = 'tool'; lbl = 'Tool: ' + (e.name || '');
      det = S(e.input, 3000);
    } else if (e.type === 'tool_result') {
      cls = 'tool'; lbl = 'Tool result' + (e.is_error ? ' (error)' : '');
      det = S(e.content, 3000);
    } else if (e.type === 'stream_event') {
      var se = e.event || {};
      cls = 'tool';
      if (se.delta && se.delta.type === 'text_delta') { lbl = 'Token stream'; det = se.delta.text || ''; }
      else { lbl = 'Stream event'; det = S(se, 2000); }
    } else if (e.type === 'system') {
      cls = 'tool';
      if (e.subtype === 'init') { lbl = 'Session init'; det = 'model: ' + (e.model || '?') + ', tools: ' + S(e.tools, 500); }
      else if (e.subtype === 'turn_duration') { lbl = 'Turn duration: ' + (e.durationMs || 0) + 'ms'; }
      else if (e.subtype === 'thinking_tokens') { return ''; }
      else if (e.subtype === 'api_error') { lbl = 'API error'; det = S(e.error, 2000); }
      else if (e.subtype === 'compact_boundary') { lbl = 'Context compacted'; det = e.content || S(e.compactMetadata, 500); }
      else if (e.subtype === 'informational') { lbl = 'Info'; det = e.content || ''; }
      else { lbl = 'System' + (e.subtype ? ': ' + e.subtype : ''); det = e.content || S(e, 1000); }
    } else if (e.type === 'status') {
      return '';
    } else {
      lbl = e.type || 'event';
      det = S(e, 3000);
    }

    var t = '<div class="entry '+cls+'"><div class="dot"></div><div class="body"><div class="label"><span class="time">'+time+'</span>'+E(lbl)+'</div>';
    if (det.trim()) t += '<div class="detail">'+E(det)+'</div>';
    return t + '</div></div>';
  }

  function roundPreview(rd){
    var preview='',result='';
    var first=rd.entries[0];
    if(first&&first.userTurns&&first.userTurns.length){
      preview=first.userTurns[0].content.slice(0,60);
    }
    for(var ei=0;ei<rd.entries.length;ei++){
      var e=rd.entries[ei];
      if(e.type==='result'&&!result){
        var answer=typeof e.answer==='string'?e.answer:(e.result||'');
        if(answer)result=answer.slice(0,50)+(answer.length>50?'\u2026':'')+'\u00b7 ';
      }
    }
    return{preview:preview||'(no input)'};
  }

  async function load(id){
    document.querySelectorAll('.ticket').forEach(function(el){el.classList.toggle('active',el.dataset.id===id)});
    var rl=document.getElementById('round-list');
    var m=document.getElementById('main');
    m.innerHTML='<div class="empty-state"><p>Loading&hellip;</p></div>';
    try{
      var r=await fetch('/api/sessions/'+id);
      if(!r.ok){m.innerHTML='<div class="empty-state"><p>API error '+r.status+'</p></div>';return}
      var d=await r.json(),rounds=d.rounds||[];
      if(!rounds.length){m.innerHTML='<div class="empty-state"><p>No data yet</p></div>';rl.classList.remove('open');rl.innerHTML='';return}

      rl.innerHTML=rounds.map(function(rd,ri){var pv=roundPreview(rd);return'<div class="round-entry" data-round="'+(ri+1)+'"><span class="num">#'+(ri+1)+'</span><span class="preview">'+E(pv.preview)+'</span></div>'}).join('');
      rl.classList.add('open');

      var h='<h3 style="font-size:14px;color:var(--accent);margin-bottom:24px;font-family:monospace">Ticket '+id+'</h3>';
      for(var ri=0;ri<rounds.length;ri++){
        var rd=rounds[ri];
        var pv=roundPreview(rd);
        h+='<div class="round-section" id="round-'+(ri+1)+'">';
        h+='<div class="round-header"><span class="round-number">Round '+(ri+1)+'</span><span class="round-id">'+rd.roundId+'</span><span class="round-meta">'+rd.entries.length+' entries &middot; '+E(pv.preview)+'</span></div>';
        var start=rd.entries[0];
        if(start&&start.userTurns&&start.userTurns.length){
          for(var ui=0;ui<start.userTurns.length;ui++){
            var ut=start.userTurns[ui];
            h+='<div class="round-turn"><div class="turn-role">User message</div><div class="turn-text">'+E(ut.content)+'</div></div>';
          }
        }
        h+='<div class="timeline">';
        for(var ei=0;ei<rd.entries.length;ei++)h+=render(rd.entries[ei]);
        h+='</div></div>';
      }
      m.innerHTML=h;
    }catch(err){m.innerHTML='<div class="empty-state"><p>Error: '+E(err.message)+'</p></div>';rl.classList.remove('open');rl.innerHTML=''}
  }
  document.addEventListener('click',function(e){if(e.target.classList.contains('detail'))e.target.classList.toggle('expanded');var re=e.target.closest('.round-entry');if(re){var ri=re.dataset.round;if(ri){document.getElementById('round-'+ri).scrollIntoView({behavior:'smooth'})}}})
  setTimeout(function(){var f=document.querySelector('.ticket');if(f)f.click();},100);
</script></body></html>`;
}

export function startDashboard(sessionDir: string, port = 3456): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';
    if (url === '/api/tickets') {
      const tickets = scanSessions(sessionDir).map(t => ({
        ticketId: t.ticketId, sessionCount: t.sessions.length,
        updatedAt: t.sessions[0] ? statSync(t.sessions[0]).mtimeMs : 0,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tickets));
    }
    if (url.startsWith('/api/sessions/')) {
      const ticketId = url.replace('/api/sessions/', '').split('?')[0];
      const rounds = getRounds(sessionDir, ticketId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ticketId, rounds }));
    }
    if (url === '/' || url === '/index.html') {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html(sessionDir));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Error: ' + err.message);
      }
    }
    res.writeHead(404); res.end('Not found');
  });

  server.listen(port, () => console.log(`[dashboard] http://localhost:${port}`));
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') console.log(`[dashboard] port ${port} in use, skipped`);
    else logger.error('[dashboard]', err);
  });
}
