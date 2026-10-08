/**
 * EPR 被动会话观察器：USB PD 3.1 §6.4.10 / 3.2 §7.30、§9.2.26.3。
 * 只在完整可信且非重传的 SOP 消息上运行；不模拟设备 Policy Engine 或发送消息。
 * 缺少抓包上下文时保留 unknown，能力查询本身不能证明已经进入 EPR。
 */
export function pdCreateEprState(mode = 'unknown') {
  return { mode, phase: 'idle', contract: null, contractKnown: mode !== 'unknown', pending: null,
    lastRequest: null, keepAlive: null, lastTrafficMs: null };
}

const PD_EPR_PHASE_TEXT = {
  idle: '空闲', enter_sent: '已请求进入', enter_acknowledged: '进入请求已确认',
  await_capabilities: '等待 EPR 能力', await_request: '等待 EPR 请求',
  negotiating: '等待 Accept', transitioning: '等待 PS_RDY', ready: '合同已建立',
  failed: '进入失败', await_spr_capabilities: '已退出，等待 SPR 能力', reset_required: '协议异常，预期 Hard Reset',
  fr_swap_source_off: 'FR_Swap 已接受，等待 New Sink PS_RDY', fr_swap_source_on: '等待 New Source PS_RDY 完成 FR_Swap',
  fr_swap_unknown: 'FR_Swap 序列中断，完成状态未知',
};

export function pdDescribeEpr(e, em) {
  em.object('EPR 会话状态');
  em.detail('模式', ({ unknown: '未知（未捕获完整上下文）', spr: 'SPR', epr: 'EPR' })[e.mode]);
  em.detail('阶段', PD_EPR_PHASE_TEXT[e.phase] ?? e.phase);
  em.detail('当前合同', e.contract ? `PDO #${e.contract.position} · ${e.contract.kind} · ${e.contract.range.toUpperCase()}`
    : e.contractKnown ? '尚无已确认合同' : '未知（未捕获 Request → Accept → PS_RDY）');
  if (e.keepAlive) em.detail('Keep Alive', e.keepAlive.pending ? '等待 Source Ack' : '已收到 Source Ack');
}

/** e.request / e.extBytes 由解码器的完整语义解析结果提供。 */
export function pdTrackEpr(st, em, m) {
  const e = st.epr;
  const bad = (text, code = 'EPR_SEQUENCE') => em.warn?.(text, code);
  const isData = !m.ext && m.count > 0;
  const isControl = !m.ext && !m.count;
  const source = m.sender === 1;
  if (e.mode === 'epr') e.lastTrafficMs = m.endTimeMs;
  if (st.sourceCapQuery && source && !(isControl && [1, 5].includes(m.type)) && !(isData && m.type === 1)) st.sourceCapQuery = false;

  if (isData && m.type === 10) {
    const action = m.words[0] >>> 24, data = m.words[0] >>> 16 & 255;
    // Invalid Action 或错误方向应忽略，保留原状态。Reserved Data 不影响合法 Action。
    if (action < 1 || action > 5 || action === 1 && source || [2, 3, 4].includes(action) && !source) return;
    if (action === 1) {
      if (e.mode === 'epr') { bad('已处于 EPR 模式时再次请求 Enter'); return; }
      if (e.contractKnown && (!e.contract || e.contract.range !== 'spr')) bad('EPR Enter 前未观察到 SPR 显式合同', 'EPR_PREREQUISITE');
      if (e.pending) bad('EPR Enter 前的电源合同协商尚未完成', 'EPR_PREREQUISITE');
      const first = st.capabilities.spr.source?.pdoMeta[1];
      if (first && !(first.raw & 0x800000)) bad('最近 SPR 5V PDO 未置 EPR Capable', 'EPR_PREREQUISITE');
      if (st.lastSprRequest && !st.lastSprRequest.eprCapable) bad('最近 Request 的 RDO 未置 EPR Capable', 'EPR_PREREQUISITE');
      if (st.sinkOperationalPdp !== undefined && data !== st.sinkOperationalPdp) bad('EPR Enter PDP 与最近 Sink_Capabilities_Extended 的 Operational PDP 不一致', 'EPR_PDP');
      e.mode = 'spr'; e.phase = 'enter_sent'; e.pending = null; e.keepAlive = null;
    } else if (action === 2) {
      if (e.mode === 'epr') { bad('已处于 EPR 模式时收到 Enter Acknowledged'); return; }
      e.mode = 'spr'; e.phase = 'enter_acknowledged'; e.pending = null;
    } else if (action === 3) {
      if (e.mode === 'epr') { bad('已处于 EPR 模式时重复 Enter Succeeded'); return; }
      if (e.phase === 'enter_sent') bad('Enter Succeeded 前未观察到 Enter Acknowledged');
      e.mode = 'epr'; e.phase = 'await_capabilities'; e.pending = null; e.lastTrafficMs = m.endTimeMs;
    } else if (action === 4) {
      if (e.mode === 'epr') { bad('已处于 EPR 模式时收到 Enter Failed'); return; }
      e.mode = 'spr'; e.phase = 'failed'; e.pending = null; e.keepAlive = null;
    } else {
      const invalidExit = e.contractKnown && (!e.contract || e.contract.range !== 'spr');
      if (invalidExit) bad('EPR Exit 前必须先建立 SPR PDO/APDO 合同，预期 Hard Reset', 'EPR_EXIT');
      e.mode = 'spr'; e.phase = invalidExit ? 'reset_required' : 'await_spr_capabilities'; e.pending = null; e.keepAlive = null;
    }
    return;
  }

  if (isControl && m.type === 13) {
    e.pending = null; e.keepAlive = null;
    // Soft Reset 保留当前显式合同和已经进入的 EPR 模式，终止未完成的 Enter AMS。
    e.phase = e.mode === 'epr' ? 'await_capabilities' : 'idle';
    st.pendingSwap = null; st.sourceCapQuery = false;
    return;
  }

  if (isControl && m.type === 7) { st.sourceCapQuery = !source; e.pending = null; return; }
  if (isData && m.type === 1 && source) {
    if (e.mode === 'epr' && !st.sourceCapQuery) bad('EPR 模式中的普通 Source_Capabilities 未对应 Get_Source_Cap，预期 Hard Reset', 'EPR_MODE');
    st.sourceCapQuery = false;
    if (e.phase === 'await_spr_capabilities') e.phase = 'idle';
    // EPR 中用于查询的 SPR 能力响应不改变正在协商的 EPR 合同。
    if (e.mode !== 'epr') e.pending = null;
    return;
  }

  if (m.ext && m.type === 15 && m.extBytes && !source && m.extBytes.length >= 24 && m.extBytes[10] === 1) {
    const b = m.extBytes;
    if (b.slice(18, 21).every(v => v <= 100) && b.slice(21, 24).every(v => v <= 240)
      && b[18] <= b[19] && b[19] <= b[20] && b[21] <= b[22] && b[22] <= b[23]) {
      st.sinkOperationalPdp = b[22]; st.sinkMaximumPdp = b[23];
      for (const p of Object.values(st.capabilities.epr.sink?.pdoMeta ?? {})) {
        if (p.kind === 'epr_avs' && p.power > b[23]) bad('EPR Sink AVS Maximum Power 超过 Sink_Capabilities_Extended 的 EPR Maximum PDP', 'AVS_CAP');
      }
    }
  }
  if (m.ext && m.type === 17 && m.extBytes && source && e.mode === 'epr') {
    e.phase = 'await_request'; e.pending = null;
  }
  if (m.ext && m.type === 16 && m.extBytes?.length === 2) {
    const [type, data] = m.extBytes;
    if (data || ![3, 4].includes(type)) return;
    if ((type === 3) === source) { bad('EPR Keep Alive 应由 Sink 发送，Ack 应由 Source 发送', 'ROLE'); return; }
    if (e.mode === 'spr') { bad('在已观察到的 SPR 模式中发送 EPR Keep Alive/Ack', 'EPR_MODE'); return; }
    if (type === 3) e.keepAlive = { pending: true, sentAtMs: m.endTimeMs, ackAtMs: null };
    else e.keepAlive = { pending: false, sentAtMs: e.keepAlive?.sentAtMs ?? null, ackAtMs: m.endTimeMs };
    return;
  }

  if (isData && [2, 9].includes(m.type) && !source && m.request) {
    const r = { ...m.request, message: m.type === 9 ? 'EPR_Request' : 'Request' };
    if ((m.type === 9 && e.mode === 'spr') || (m.type === 2 && e.mode === 'epr')) {
      bad(`${r.message} 与已观察到的 ${e.mode.toUpperCase()} 模式不符`, 'EPR_MODE'); r.valid = false;
    }
    if (m.type === 2) st.lastSprRequest = r;
    e.lastRequest = r; e.pending = { ...r, stage: 'requested' }; e.phase = 'negotiating';
    return;
  }

  if (isControl && [3, 4, 12, 16].includes(m.type) && source && e.pending) {
    if (m.type === 3) {
      e.pending.stage = 'accepted'; e.phase = 'transitioning';
      if (!e.pending.valid) bad('Source Accept 了无效的电源请求', 'EPR_REQUEST');
    } else { e.pending = null; e.phase = e.contract ? 'ready' : 'idle'; }
    return;
  }
  if (isControl && m.type === 6 && source && e.pending?.stage === 'accepted') {
    if (e.pending.valid) {
      const { stage, valid, ...contract } = e.pending;
      e.contract = contract; e.contractKnown = true;
      e.mode = contract.message === 'EPR_Request' ? 'epr' : 'spr';
    }
    e.pending = null; e.phase = e.contract ? 'ready' : 'idle';
    return;
  }

  if (isControl && m.type === 10 && e.mode === 'epr') bad('EPR 模式禁止 PR_Swap，接收方应 Reject', 'EPR_PR_SWAP');
  // GoodCRC、Ping、分块传输保持未完成协商；其他 AMS 的 PS_RDY 不能确认电源请求。
  if ((isControl && [9, 10, 11, 19].includes(m.type)) || isData || (m.ext && m.extBytes && ![16, 17, 18].includes(m.type))) {
    e.pending = null;
    if (['negotiating', 'transitioning'].includes(e.phase)) e.phase = e.contract ? 'ready' : 'idle';
  }
}

/** 接受电源交换后原合同/能力失效，FR_Swap 同时隐式退出 EPR。 */
export function pdEprPowerSwap(st) {
  st.epr = pdCreateEprState('spr');
  st.capabilities = { spr: { source: null, sink: null }, epr: { source: null, sink: null } };
  delete st.sinkOperationalPdp;
  delete st.sinkMaximumPdp;
  delete st.lastSprRequest;
  st.sourceCapQuery = false;
}
