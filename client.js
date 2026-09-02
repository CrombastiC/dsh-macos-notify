// dsh-macos-notify Web UI: focus reporting, settings, sound management and diagnostics.
window.__ModuleLoader__.load({
  id: 'dsh-macos-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var SOUND_ROWS = [
      ['completed', '任务完成'], ['error', '出错 / 被阻止'],
      ['aborted', '任务中断'], ['approval', '等待审批'],
    ]
    var FALLBACK_SOUNDS = ['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink']
    var RULE_LABELS = { mute: '全部静音', errors: '仅错误与审批', important: '重要项目（忽略过滤）' }
    var KIND_LABELS = { completed: '完成', error: '错误', aborted: '中断', approval: '审批' }
    var inputStyle = { width: '150px', padding: '5px 8px', fontSize: '12px', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2,#444)', borderRadius: '6px', background: 'transparent', color: 'inherit' }
    var buttonStyle = { padding: '5px 10px', minHeight: '29px', fontSize: '12px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2,#444)', borderRadius: '6px', background: 'transparent', color: 'inherit' }
    var sectionStyle = { borderTop: '1px solid var(--dsw-alias-border-l2,#444)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }
    var rowStyle = { display: 'flex', alignItems: 'center', gap: '9px', minHeight: '30px' }
    var css = [
      '@keyframes dshSaved{0%{box-shadow:0 0 0 0 rgba(46,157,98,.3);border-color:rgba(46,157,98,.7)}100%{box-shadow:0 0 0 5px rgba(46,157,98,0)}}',
      '@keyframes dshShake{0%,100%{transform:translateX(0)}30%{transform:translateX(-3px)}70%{transform:translateX(3px)}}',
      '.dsh-notify-saved{animation:dshSaved 650ms ease-out both}.dsh-notify-error{animation:dshShake 240ms ease-out both}',
      '@media(prefers-reduced-motion:reduce){.dsh-notify-saved,.dsh-notify-error{animation:none!important}}',
    ].join('\n')

    function parseRules(raw) {
      try {
        var value = JSON.parse(raw || '[]')
        return Array.isArray(value) ? value.map(function (rule) { return { path: String(rule.path || ''), mode: String(rule.mode || 'mute') } }) : []
      } catch { return [] }
    }
    function toDraft(settings) {
      return Object.assign({}, settings, { sounds: Object.assign({}, settings.sounds || {}), projectRules: parseRules(settings.projectRulesJson) })
    }
    function toPatch(draft) {
      return {
        onCompleted: !!draft.onCompleted, onError: !!draft.onError, onAborted: !!draft.onAborted, onApproval: !!draft.onApproval,
        minDurationSec: Math.max(0, Number(draft.minDurationSec) || 0), onlyWhenIdleSec: Math.max(0, Number(draft.onlyWhenIdleSec) || 0),
        onlyWhenUnfocused: !!draft.onlyWhenUnfocused, digestMinutes: Math.max(0, Number(draft.digestMinutes) || 0),
        includeSubagents: !!draft.includeSubagents, channel: draft.channel || 'auto', sounds: Object.assign({}, draft.sounds),
        coalesceMs: Math.max(0, Number(draft.coalesceMs) || 0), quietHoursEnabled: !!draft.quietHoursEnabled,
        quietStart: draft.quietStart || '23:00', quietEnd: draft.quietEnd || '08:00', quietAllowCritical: !!draft.quietAllowCritical,
        pauseUntil: Number(draft.pauseUntil) || 0, duplicateWindowSec: Math.max(0, Number(draft.duplicateWindowSec) || 0),
        projectRulesJson: JSON.stringify((draft.projectRules || []).filter(function (rule) { return rule.path.trim() }).map(function (rule) { return { path: rule.path.trim(), mode: rule.mode } })),
      }
    }
    function SectionTitle(props) {
      return h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
        h('strong', null, props.title), props.note ? h('span', { style: { opacity: .55, fontSize: '11px', textAlign: 'right' } }, props.note) : null)
    }
    function Toggle(props) {
      return h('label', { style: rowStyle }, h('input', { type: 'checkbox', checked: !!props.value, disabled: props.disabled, onChange: function (e) { props.onChange(e.target.checked) } }), h('span', { style: { flex: 1 } }, props.label))
    }
    function SettingRow(props) {
      return h('label', { style: rowStyle }, h('span', { style: { flex: 1 } }, props.label, props.note ? h('small', { style: { display: 'block', opacity: .5 } }, props.note) : null), props.children)
    }

    function Card(props) {
      var settingsState = React.useState(null), settings = settingsState[0], setSettings = settingsState[1]
      var draftState = React.useState(null), draft = draftState[0], setDraft = draftState[1]
      var catalogState = React.useState({ names: [], managed: [], limits: {} }), catalog = catalogState[0], setCatalog = catalogState[1]
      var diagState = React.useState({ entries: [], status: {} }), diagnostics = diagState[0], setDiagnostics = diagState[1]
      var editingState = React.useState(false), editing = editingState[0], setEditing = editingState[1]
      var savingState = React.useState(false), saving = savingState[0], setSaving = savingState[1]
      var savedState = React.useState(false), saved = savedState[0], setSaved = savedState[1]
      var importingState = React.useState(false), importing = importingState[0], setImporting = importingState[1]
      var testingState = React.useState(''), testing = testingState[0], setTesting = testingState[1]
      var importTargetState = React.useState('none'), importTarget = importTargetState[0], setImportTarget = importTargetState[1]
      var errorState = React.useState(''), error = errorState[0], setError = errorState[1]
      var fileInput = React.useRef(null), savedTimer = React.useRef(null), testTimer = React.useRef(null)

      var loadSettings = function () { return props.call('settings', { op: 'get' }).then(function (value) { setSettings(value); setDraft(toDraft(value)); return value }) }
      var loadCatalog = function () { return props.call('sounds', {}).then(function (value) { if (value && Array.isArray(value.names)) setCatalog(value); return value }) }
      var loadDiagnostics = function () {
        if (document.hidden) return Promise.resolve()
        return props.call('diagnostics', { op: 'get' }).then(function (next) {
          if (document.hidden) return
          setDiagnostics(function (prev) { return JSON.stringify(prev) === JSON.stringify(next) ? prev : next })
        }).catch(function () {})
      }
      React.useEffect(function () {
        Promise.all([loadSettings(), loadCatalog(), loadDiagnostics()]).catch(function (err) { setError(String(err && err.message || '设置读取失败')) })
        var timer = setInterval(loadDiagnostics, 5000)
        return function () { clearInterval(timer); if (savedTimer.current) clearTimeout(savedTimer.current); if (testTimer.current) clearTimeout(testTimer.current) }
      }, [])
      if (!settings || !draft) return h('div', { style: { padding: '12px', opacity: .6 } }, '加载中…')

      var patch = toPatch(draft), dirty = JSON.stringify(patch) !== JSON.stringify(toPatch(toDraft(settings)))
      var status = diagnostics.status || {}, pauseActive = Number(status.pauseUntil) > Date.now()
      var focusCount = Number(status.focusedTabs) || 0
      var statusNotes = []
      if (status.quietActive) statusNotes.push('勿扰时段中')
      if (pauseActive) statusNotes.push('通知已暂停')
      if (focusCount > 0) statusNotes.push(focusCount + ' 个标签页聚焦中，完成通知将被抑制')
      var statusNote = statusNotes.length ? statusNotes.join('；') : '运行正常'
      var availableSounds = catalog.names.length ? catalog.names : FALLBACK_SOUNDS
      var change = function (field, value) { setDraft(Object.assign({}, draft, { [field]: value })) }
      var changeSound = function (kind, value) { setDraft(Object.assign({}, draft, { sounds: Object.assign({}, draft.sounds, { [kind]: value }) })) }
      var NUMBER_BOUNDS = { minDurationSec: [0, 3600], onlyWhenIdleSec: [0, 3600], digestMinutes: [0, 1440], coalesceMs: [0, 60000], duplicateWindowSec: [0, 86400] }
      var clampNumber = function (field, raw) {
        var bounds = NUMBER_BOUNDS[field] || [0, Infinity]
        var num = Math.floor(Number(raw))
        if (!Number.isFinite(num)) num = bounds[0]
        return Math.min(bounds[1], Math.max(bounds[0], num))
      }
      // 读视图下的单字段即时保存：与快捷暂停同走 op:'set'；批量编辑期间退回草稿模式
      var saveNow = function (field, value) {
        setSaving(true); setError('')
        props.call('settings', { op: 'set', field: field, value: value }).then(function (next) {
          setSettings(next); setDraft(toDraft(next)); setSaved(true); loadDiagnostics()
          if (savedTimer.current) clearTimeout(savedTimer.current)
          savedTimer.current = setTimeout(function () { setSaved(false) }, 1800)
        }).catch(function (err) { setError(String(err && err.message || '保存失败')) }).finally(function () { setSaving(false) })
      }
      var previewSound = function (name) {
        if (!name || testing) return
        setTesting('preview:' + name); setError('')
        props.call('sound/preview', { name: name }).catch(function (err) { setError(String(err && err.message || '试听失败')) }).finally(function () { setTesting('') })
      }
      var customPauseState = React.useState('30'), customPause = customPauseState[0], setCustomPause = customPauseState[1]
      var humanizeDuration = function (ms) {
        var minutes = Math.max(1, Math.round(ms / 60000))
        if (minutes < 60) return minutes + ' 分钟'
        var hours = Math.floor(minutes / 60), rest = minutes % 60
        return rest ? hours + ' 小时 ' + rest + ' 分钟' : hours + ' 小时'
      }
      var beginEdit = function () { setDraft(toDraft(settings)); setEditing(true); setSaved(false); setError('') }
      var cancel = function () { if (dirty && !window.confirm('放弃未保存的修改？')) return; setDraft(toDraft(settings)); setEditing(false); setError('') }
      var save = function () {
        if (!dirty || saving) return
        setSaving(true); setError('')
        props.call('settings', { op: 'patch', value: patch }).then(function (value) {
          setSettings(value); setDraft(toDraft(value)); setEditing(false); setSaved(true); loadDiagnostics()
          if (savedTimer.current) clearTimeout(savedTimer.current)
          savedTimer.current = setTimeout(function () { setSaved(false) }, 1800)
        }).catch(function (err) { setError(String(err && err.message || '保存失败')) }).finally(function () { setSaving(false) })
      }
      var test = function (kind, sound) {
        setTesting(kind); setError('')
        props.call('test', { kind: kind, sound: sound }).then(loadDiagnostics).catch(function (err) { setError(String(err && err.message || '测试失败')) })
        if (testTimer.current) clearTimeout(testTimer.current)
        testTimer.current = setTimeout(function () { setTesting('') }, 1200)
      }
      var pause = function (duration) {
        var until = duration ? Date.now() + duration : 0
        props.call('settings', { op: 'set', field: 'pauseUntil', value: until }).then(function () {
          setSettings(Object.assign({}, settings, { pauseUntil: until }))
          setDraft(Object.assign({}, draft, { pauseUntil: until }))
          return loadDiagnostics()
        }).catch(function (err) { setError(String(err && err.message || '暂停设置失败')) })
      }
      var importFile = function (event) {
        var file = event.target.files && event.target.files[0]; event.target.value = ''
        if (!file) return
        if (file.size > 5 * 1024 * 1024) { setError('声音文件不能超过 5MB'); return }
        setImporting(true); setError('')
        var reader = new FileReader()
        reader.onload = function () {
          props.call('sound/import', { filename: file.name, data: String(reader.result || '').split(',')[1] || '' }).then(function (result) {
            if (!result || !result.name) throw new Error('导入结果无效')
            if (importTarget !== 'none') changeSound(importTarget, result.name)
            return loadCatalog()
          }).catch(function (err) { setError(String(err && err.message || '导入失败')) }).finally(function () { setImporting(false) })
        }
        reader.onerror = function () { setImporting(false); setError('声音文件读取失败') }
        reader.readAsDataURL(file)
      }
      var deleteSound = function (name, force) {
        props.call('sound/delete', { name: name, force: !!force }).then(function (result) {
          if (result && result.requiresConfirmation) {
            var used = result.inUse.map(function (kind) { return KIND_LABELS[kind] || kind }).join('、')
            if (window.confirm('“' + name + '”正在用于' + used + '通知。删除后会改为静音，继续吗？')) return deleteSound(name, true)
            return
          }
          var nextSavedSounds = Object.assign({}, settings.sounds)
          var nextDraftSounds = Object.assign({}, draft.sounds)
          Object.keys(nextSavedSounds).forEach(function (kind) { if (nextSavedSounds[kind] === name) nextSavedSounds[kind] = '' })
          Object.keys(nextDraftSounds).forEach(function (kind) { if (nextDraftSounds[kind] === name) nextDraftSounds[kind] = '' })
          setSettings(Object.assign({}, settings, { sounds: nextSavedSounds }))
          setDraft(Object.assign({}, draft, { sounds: nextDraftSounds }))
          return loadCatalog()
        }).catch(function (err) { setError(String(err && err.message || '删除失败')) })
      }
      var updateRule = function (index, field, value) { var rules = draft.projectRules.slice(); rules[index] = Object.assign({}, rules[index], { [field]: value }); change('projectRules', rules) }
      var removeRule = function (index) { change('projectRules', draft.projectRules.filter(function (_, candidate) { return candidate !== index })) }
      var addRule = function () { change('projectRules', draft.projectRules.concat({ path: props.getCurrentCwd() || '', mode: 'mute' })) }

      return h('div', { className: saved ? 'dsh-notify-saved' : '', style: { border: '1px solid var(--dsw-alias-border-l2,#444)', borderRadius: '10px', padding: editing ? '14px 16px 52px' : '14px 16px', fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('style', null, css),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
          h('div', null, h('strong', null, 'macOS 通知'), h('div', { style: { opacity: .55, fontSize: '11px', marginTop: '2px' } }, '通道：' + (status.channel || settings.channel) + ' · 诊断记录 ' + diagnostics.entries.length + ' 条')),
          editing ? [h('span', { style: { padding: '3px 7px', borderRadius: '99px', fontSize: '11px', background: 'rgba(47,111,237,.1)' } }, '整体编辑中'), dirty ? h('span', { style: { padding: '3px 7px', borderRadius: '99px', fontSize: '11px', background: 'rgba(179,107,0,.15)', color: '#b36b00' } }, '未保存') : null] : h('button', { style: buttonStyle, disabled: saved, onClick: beginEdit }, saved ? '已保存 ✓' : '编辑全部')),
        error ? h('div', { className: 'dsh-notify-error', role: 'alert', style: { padding: '7px 9px', borderRadius: '6px', color: '#d94b43', background: 'rgba(217,75,67,.1)' } }, error) : null,

        h('div', { style: sectionStyle }, h(SectionTitle, { title: '运行状态与测试', note: statusNote }),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, ['completed', 'error', 'approval', 'aborted', 'coalesced', 'digest'].map(function (kind) {
            var names = { completed: '完成', error: '错误', approval: '审批', aborted: '中断', coalesced: '合并', digest: '摘要' }
            return h('button', { key: kind, style: buttonStyle, onClick: function () { test(kind, draft.sounds[kind]) } }, testing === kind ? '发送中…' : '测试' + names[kind])
          })),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } }, h('small', { style: { opacity: .55 } }, pauseActive ? '暂停至 ' + new Date(status.pauseUntil).toLocaleString() + '（剩余约 ' + humanizeDuration(status.pauseUntil - Date.now()) + '）' : '临时暂停：'),
            h('button', { style: buttonStyle, onClick: function () { pause(30 * 60 * 1000) } }, '30 分钟'), h('button', { style: buttonStyle, onClick: function () { pause(60 * 60 * 1000) } }, '1 小时'), h('button', { style: buttonStyle, onClick: function () { pause(24 * 60 * 60 * 1000) } }, '24 小时'),
            h('input', { 'aria-label': '自定义暂停分钟数', style: Object.assign({}, inputStyle, { width: '76px' }), type: 'number', min: 1, max: 10080, value: customPause, onChange: function (e) { setCustomPause(e.target.value) } }),
            h('button', { style: buttonStyle, onClick: function () { var minutes = Math.floor(Number(customPause)); if (minutes > 0) pause(Math.min(minutes, 10080) * 60000) } }, '暂停'),
            pauseActive ? h('button', { style: buttonStyle, onClick: function () { pause(0) } }, '立即恢复') : null)),

        h('div', { style: sectionStyle }, h(SectionTitle, { title: '通知事件与过滤' }),
          [['onCompleted', '任务完成'], ['onError', '错误与阻止'], ['onApproval', '等待审批'], ['onAborted', '用户中断']].map(function (row) { return h(Toggle, { key: row[0], disabled: saving, value: draft[row[0]], label: row[1], onChange: function (value) { if (editing) change(row[0], value); else saveNow(row[0], value) } }) }),
          h(Toggle, { disabled: saving, value: draft.onlyWhenUnfocused, label: '仅在 DSH 页面未聚焦时发送完成通知', onChange: function (value) { if (editing) change('onlyWhenUnfocused', value); else saveNow('onlyWhenUnfocused', value) } }),
          h(Toggle, { disabled: saving, value: draft.includeSubagents, label: '包含子 Agent 会话', onChange: function (value) { if (editing) change('includeSubagents', value); else saveNow('includeSubagents', value) } }),
          [['minDurationSec', '完成通知最短耗时（秒）', 3600], ['onlyWhenIdleSec', '键鼠空闲门槛（秒）', 3600], ['digestMinutes', '摘要间隔（分钟）', 1440], ['coalesceMs', '合并窗口（毫秒）', 60000], ['duplicateWindowSec', '重复错误抑制（秒）', 86400]].map(function (row) { return h(SettingRow, { key: row[0], label: row[1] }, h('input', { style: inputStyle, type: 'number', min: 0, max: row[2], disabled: !editing, value: draft[row[0]], onChange: function (e) { change(row[0], clampNumber(row[0], e.target.value)) } })) }),
          h(SettingRow, { label: '通知通道', note: 'OSC 9 仅支持 iTerm2、WezTerm、Kitty、Ghostty、Warp' }, h('select', { style: inputStyle, disabled: saving, value: draft.channel, onChange: function (e) { var value = e.target.value; if (editing) change('channel', value); else saveNow('channel', value) } }, h('option', { value: 'auto' }, '自动'), h('option', { value: 'osascript' }, 'osascript'), h('option', { value: 'osc9' }, 'OSC 9')))),

        h('div', { style: sectionStyle }, h(SectionTitle, { title: '每日勿扰', note: '使用本机时间' }),
          h(Toggle, { disabled: saving, value: draft.quietHoursEnabled, label: '启用每日勿扰时段', onChange: function (value) { if (editing) change('quietHoursEnabled', value); else saveNow('quietHoursEnabled', value) } }),
          h(SettingRow, { label: '时段' }, h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, h('input', { 'aria-label': '勿扰开始时间', style: Object.assign({}, inputStyle, { width: '104px' }), type: 'time', disabled: !editing, value: draft.quietStart, onChange: function (e) { change('quietStart', e.target.value) } }), h('span', null, '至'), h('input', { 'aria-label': '勿扰结束时间', style: Object.assign({}, inputStyle, { width: '104px' }), type: 'time', disabled: !editing, value: draft.quietEnd, onChange: function (e) { change('quietEnd', e.target.value) } }))),
          draft.quietHoursEnabled && draft.quietStart === draft.quietEnd ? h('small', { style: { opacity: .7, color: '#b36b00' } }, '开始与结束时间相同视为未启用') : null,
          h(Toggle, { disabled: saving, value: draft.quietAllowCritical, label: '勿扰时仍允许错误、阻止和审批', onChange: function (value) { if (editing) change('quietAllowCritical', value); else saveNow('quietAllowCritical', value) } })),

        h('div', { style: sectionStyle }, h(SectionTitle, { title: '提示音', note: '单个≤5MB/10秒；最多20个/50MB' }),
          status.channel === 'osc9' ? h('small', { style: { opacity: .55 } }, '当前经 OSC 9 输出：通知声音由终端控制；此处设置对 osascript 通道生效，试听为本地播放') : null,
          editing ? h('div', { style: rowStyle }, h('input', { ref: fileInput, type: 'file', accept: '.aac,.aif,.aiff,.caf,.flac,.m4a,.mp3,.oga,.ogg,.opus,.wav,audio/*', style: { display: 'none' }, onChange: importFile }), h('button', { style: buttonStyle, disabled: importing, onClick: function () { if (fileInput.current) fileInput.current.click() } }, importing ? '导入中…' : '导入声音'), h('select', { style: Object.assign({}, inputStyle, { width: '150px' }), value: importTarget, onChange: function (e) { setImportTarget(e.target.value) } }, h('option', { value: 'none' }, '导入后不指派'), SOUND_ROWS.map(function (row) { return h('option', { key: row[0], value: row[0] }, '并指派给' + row[1]) })), h('small', { style: { opacity: .55 } }, '已管理 ' + catalog.managed.length + ' 个')) : null,
          SOUND_ROWS.map(function (row) { var kind = row[0], value = draft.sounds[kind] || '', choices = availableSounds.includes(value) || !value ? availableSounds : [value].concat(availableSounds); return h('div', { key: kind, style: rowStyle }, h('span', { style: { width: '110px' } }, row[1]), h('select', { style: Object.assign({}, inputStyle, { flex: 1, width: 'auto' }), disabled: saving, value: value, onChange: function (e) { var next = e.target.value; if (editing) changeSound(kind, next); else saveNow('sounds', Object.assign({}, draft.sounds, { [kind]: next })) } }, h('option', { value: '' }, '静音'), choices.map(function (name) { return h('option', { key: name, value: name }, name) })), h('button', { style: buttonStyle, disabled: !value, onClick: function () { previewSound(value) } }, testing === 'preview:' + value ? '播放中…' : '试听')) }),
          catalog.managed.length ? h('div', { style: { padding: '8px', borderRadius: '7px', background: 'rgba(127,127,127,.06)' } }, catalog.managed.map(function (item) { return h('div', { key: item.name, style: rowStyle }, h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, item.name), h('small', { style: { opacity: .5 } }, (item.bytes / 1024).toFixed(0) + 'KB'), editing ? h('button', { style: Object.assign({}, buttonStyle, { color: '#d94b43' }), onClick: function () { deleteSound(item.name, false) } }, '删除') : null) })) : null),

        h('div', { style: sectionStyle }, h(SectionTitle, { title: '项目规则', note: '更具体的路径优先' }),
          h('datalist', { id: 'dsh-notify-cwds' }, (props.getSessionCwds ? props.getSessionCwds() : []).map(function (cwd) { return h('option', { key: cwd, value: cwd }) })),
          draft.projectRules.length ? draft.projectRules.map(function (rule, index) { return h('div', { key: index, style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 150px auto', gap: '6px' } }, h('input', { style: Object.assign({}, inputStyle, { width: '100%' }), disabled: !editing, value: rule.path, list: 'dsh-notify-cwds', placeholder: '/Users/name/project', onChange: function (e) { updateRule(index, 'path', e.target.value) } }), h('select', { style: Object.assign({}, inputStyle, { width: '100%' }), disabled: !editing, value: rule.mode, onChange: function (e) { updateRule(index, 'mode', e.target.value) } }, Object.keys(RULE_LABELS).map(function (mode) { return h('option', { key: mode, value: mode }, RULE_LABELS[mode]) })), editing ? h('button', { style: Object.assign({}, buttonStyle, { color: '#d94b43' }), onClick: function () { removeRule(index) } }, '移除') : h('span')) }) : h('small', { style: { opacity: .55 } }, '尚未配置项目规则'),
          editing ? h('button', { style: Object.assign({}, buttonStyle, { alignSelf: 'flex-start' }), onClick: addRule }, props.getCurrentCwd() ? '添加当前项目' : '添加规则') : null),

        h('div', { style: sectionStyle }, h(SectionTitle, { title: '最近通知诊断', note: '当前进程最近50条' }),
          diagnostics.entries.length ? diagnostics.entries.slice(0, 12).map(function (entry) { var colors = { sent: '#238452', suppressed: '#b36b00', queued: '#3867c8', error: '#d94b43' }, labels = { sent: '已发送', suppressed: '已抑制', queued: '排队中', error: '失败' }; return h('div', { key: entry.id, style: { display: 'grid', gridTemplateColumns: '58px minmax(0,1fr) auto', gap: '7px', padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,.12)' } }, h('span', { style: { color: colors[entry.status], fontSize: '11px', fontWeight: 600 } }, labels[entry.status] || entry.status), h('span', null, h('b', null, entry.label || entry.title || entry.kind), h('small', { style: { display: 'block', opacity: .55 } }, entry.detail)), h('small', { style: { opacity: .45, whiteSpace: 'nowrap' } }, new Date(entry.time).toLocaleTimeString())) }) : h('small', { style: { opacity: .55 } }, '暂无记录，可以点击上方测试按钮。'),
          diagnostics.entries.length ? h('button', { style: Object.assign({}, buttonStyle, { alignSelf: 'flex-start' }), onClick: function () { if (!window.confirm('清空全部诊断记录？')) return; props.call('diagnostics', { op: 'clear' }).then(setDiagnostics) } }, '清空记录') : null),

        editing ? h('div', { style: { position: 'sticky', bottom: '8px', display: 'flex', gap: '8px', padding: '9px', borderRadius: '8px', background: 'var(--dsw-alias-bg-primary,#1d1d1d)', border: '1px solid var(--dsw-alias-border-l2,#444)', boxShadow: '0 5px 18px rgba(0,0,0,.18)' } }, h('button', { style: Object.assign({}, buttonStyle, { fontWeight: 650 }), disabled: !dirty || saving || importing, onClick: save }, saving ? '保存中…' : dirty ? '保存全部' : '没有改动'), h('button', { style: buttonStyle, disabled: saving || importing, onClick: cancel }, '取消')) : null)
    }

    exports.inject = ['connection', 'slots', 'sessions']
    exports.apply = function apply(ctx) {
      var clientId = crypto.randomUUID()
      var report = function () { ctx.connection.rpc.call('/macos-notify', 'visibility', { id: clientId, focused: document.visibilityState === 'visible' && document.hasFocus() }).catch(function () {}) }
      report(); document.addEventListener('visibilitychange', report); window.addEventListener('focus', report); window.addEventListener('blur', report)
      var timer = setInterval(report, 30000)
      var call = function (endpoint, payload) { return ctx.connection.rpc.call('/macos-notify', endpoint, payload).then(function (result) { if (!result || result.ok !== true) throw new Error(result && result.error && result.error.message || 'RPC 调用失败'); return result.value }) }
      var getCurrentCwd = function () { try { var state = ctx.sessions.list.getSnapshot(); return state.current && state.byId[state.current] && state.byId[state.current].cwd || '' } catch { return '' } }
      var getSessionCwds = function () { try { var state = ctx.sessions.list.getSnapshot(); var seen = {}, cwds = []; Object.keys(state.byId || {}).forEach(function (id) { var cwd = state.byId[id] && state.byId[id].cwd; if (cwd && !seen[cwd]) { seen[cwd] = true; cwds.push(cwd) } }); return cwds } catch { return [] } }
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'macos-notify',
          order: 100,
          label: 'macOS 通知',
          inject: function () { return { call: call, getCurrentCwd: getCurrentCwd, getSessionCwds: getSessionCwds } },
        }, Card)
      })
      ctx.effect(function () { return function () { clearInterval(timer); document.removeEventListener('visibilitychange', report); window.removeEventListener('focus', report); window.removeEventListener('blur', report) } })
    }
    return module.exports
  },
})
