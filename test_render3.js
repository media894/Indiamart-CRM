
  const document = {
    querySelector: () => ({ value: '' }),
    getElementById: (id) => {
      return { innerHTML: '', textContent: '' };
    }
  };
  const filterStatus = 'All';
  const currentLeadType = 'W';
  const leads = [{"id":"123","name":"Test Name","company":"Test Co","email":"test@example.com","createdAt":"2026-07-09T10:03:54.601Z","phone":"9999999999","score":null,"clientStatus":"New","status":"New","queryType":"W"}];
  
  function formatLeadTime(value) { return value; }
  function emailValidationBadge(l) { return ''; }
  function scoreHtml(score, id) { return ''; }
  function updateClientStatus(id, val) {}
  
  function test_renderLeads() {
  const q = document.querySelector('.search-box')?.value?.toLowerCase()||'';
  let filtered = leads.filter(l => {
    const type = l.queryType || 'W';
    if (type !== currentLeadType) return false;
    
    if (filterStatus!=='All' && l.status!==filterStatus && l.clientStatus!==filterStatus) return false;
    if (q && !`${l.name} ${l.company} ${l.product} ${l.email}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const tbody = document.getElementById('leads-tbody');
  if (!filtered.length) { tbody.innerHTML=`<tr><td colspan="6"><div class="empty"><svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><p>No leads found</p></div></td></tr>`; return; }
  tbody.innerHTML = filtered.map(l=>`
    <tr>
      <td>
        <div class="lead-name-cell" onclick="viewLead('${l.id}')">${l.name}</div>
        <div class="lead-sub" style="margin-top:2px">
          ${l.company||''} ${l.email?`· ${l.email} ${emailValidationBadge(l)}`:''}
        </div>
        <div class="lead-sub" style="margin-top:2px;color:var(--purple-dk);font-weight:500">
          Lead time: ${formatLeadTime(l.createdAt)}
        </div>
        ${l.phone?`
          <div class="lead-sub" style="display:flex;align-items:center;gap:4px;margin-top:2px">
            <span>📞 ${l.phone}</span>
            ${(() => {
              const st = l.phoneStatus || '';
              const isVerified = l.phoneValid !== false && st && !st.includes('Format Check') && !st.includes('Format check') && !st.includes('Format Only');
              const isFormatOnly = l.phoneValid !== false && st && (st.includes('Format Check') || st.includes('Format check') || st.includes('Format Only') || st.includes('Format valid') || st.includes('API key'));
              const isInvalid = l.phoneValid === false;
              if (!st) return '';
              if (isInvalid) return `<span style="color:var(--red);font-size:10.5px;font-weight:600" title="${st}">❌ Disconnected</span>`;
              if (isFormatOnly) return `<span style="color:var(--amber);font-size:10.5px;font-weight:600" title="Format check only — not carrier verified: ${st}">⚠️ Format Only</span>`;
              return `<span style="color:var(--teal);font-size:10.5px;font-weight:600" title="${st}">✓ Verified Active</span>`;
            })()}
          </div>
          ${(l.phoneLocation || l.phoneCarrier) ? `
            <div class="lead-sub" style="color:var(--green);font-size:11.5px;font-weight:550;margin-top:2px;display:flex;align-items:center;gap:3px">
              <svg style="width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2.2" viewBox="0 0 24 24"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>${l.phoneLocation || 'India'}${l.phoneCarrier ? ` (${l.phoneCarrier})` : ''}</span>
            </div>
          ` : ''}

        `:''}
      </td>
      <td>
        <div style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;font-size:12px">${l.product||'—'}</div>
        <div style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11px">${(l.message||'').slice(0,60)}</div>
      </td>
      <td style="font-size:12px;color:var(--muted)">${[l.city,l.state].filter(Boolean).join(', ')||l.phoneLocation||'—'}</td>
      <td>${scoreHtml(l.score, l.id)}</td>
      <td>
        <select style="font-size:12px;padding:3px 6px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text)" onchange="updateClientStatus('${l.id}',this.value)">
          ${(() => {
            let effectiveStatus = l.clientStatus || 'New';
            if (!l.email) effectiveStatus = 'No Email';
            else if (l.emailValid === false) effectiveStatus = 'Bounced';
            else if (effectiveStatus === 'New' && l.emailSent) effectiveStatus = 'Emailed';
            
            return ['New','Contacted in IndiaMART','Emailed','Auto-Skipped','Replied via Email','Replied in IndiaMART','Negotiating','Lost','Bounced','No Email'].map(s=>{
              let positiveActions = ['Contacted in IndiaMART','Emailed','Auto-Skipped','Replied via Email','Replied in IndiaMART','Negotiating'];
              let isHappened = positiveActions.includes(s) && (
                               (s === 'Emailed' && l.emailSent) || 
                               (s === 'Auto-Skipped' && effectiveStatus === 'Auto-Skipped') ||
                               (l.statusHistory && l.statusHistory.includes(s)) || 
                               (s === effectiveStatus));
              let isSelected = (effectiveStatus === s);
              let style = (isHappened || (isSelected && s !== 'New' && s !== 'Lost' && s !== 'Bounced' && s !== 'No Email')) ? 'color: #10b981; font-weight: bold;' : '';
              if (s === 'Bounced' && isSelected) style = 'color: #ef4444; font-weight: bold;';
              if (s === 'No Email' && isSelected) style = 'color: #f59e0b; font-weight: bold;';
              let label = (isHappened || (isSelected && s !== 'New' && s !== 'Lost' && s !== 'Bounced' && s !== 'No Email')) ? s + ' ✓' : s;
              if (s === 'Bounced' && isSelected) label = 'Bounced ❌';
              if (s === 'No Email' && isSelected) label = 'No Email ⚠️';
              return `<option value="${s}" style="${style}" ${isSelected?'selected':''}>${label}</option>`;
            }).join('');
          })()}
        </select>
      </td>
      <td>
        <div style="display:flex;gap:4px">
          <button class="btn sm" title="View detail" onclick="viewLead('${l.id}')"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button class="btn sm" title="Send email" onclick="openEmail('${l.id}')"><svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></button>
          <button class="btn sm" title="AI Score" onclick="qualify('${l.id}')"><svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>
          <button class="btn sm" title="Edit" onclick="editLead('${l.id}')"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="btn sm danger" title="Delete" onclick="deleteLead('${l.id}')"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>
        </div>
      </td>
    </tr>`).join('');

  console.log('Filtered length:', filtered.length);
  // console.log('tbody length:', tbody.innerHTML.length);
}
test_renderLeads();

