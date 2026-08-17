// dsh-macos-notify 的浏览器半：
// 1. 跟踪 tab 焦点/可见性并上报给宿主插件（焦点抑制用）
// 2. 在 设置 → 插件 → 可配置 里注册提示音卡片（settings.plugin.item slot）
// 设置读写走自有 RPC（macos-notify/settings）：官方 settings.describe/mutate
// 线面对命名空间有硬编码白名单，第三方插件暂时上不去。
// 手写 bundle，零构建；格式即 dsh-client-modules 的 __ModuleLoader__ 包装。
window.__ModuleLoader__.load({
  id: 'dsh-macos-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var SOUND_ROWS = [
      ['completed', '任务完成'],
      ['error', '出错 / 被阻止 / 限流'],
      ['aborted', '任务中断'],
      ['approval', '等待审批'],
    ]
    var FALLBACK_SOUND_NAMES = [
      'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero',
      'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink',
    ]

    var inputStyle = {
      width: '140px', padding: '4px 8px', fontSize: '13px',
      border: '1px solid var(--dsw-alias-border-l2, #444)',
      borderRadius: '6px', background: 'transparent', color: 'inherit',
    }
    var buttonStyle = {
      padding: '4px 10px', fontSize: '12px', cursor: 'pointer', minHeight: '28px',
      border: '1px solid var(--dsw-alias-border-l2, #444)',
      borderRadius: '6px', background: 'transparent', color: 'inherit',
      transition: 'background-color 160ms ease, border-color 160ms ease, color 160ms ease, transform 120ms ease',
    }

    var feedbackCss = [
      '@keyframes dshNotifyCardSaved { 0% { box-shadow: 0 0 0 0 rgba(46, 157, 98, .28); border-color: rgba(46, 157, 98, .65); } 100% { box-shadow: 0 0 0 5px rgba(46, 157, 98, 0); } }',
      '@keyframes dshNotifyWave { 0%, 100% { transform: scaleY(.35); opacity: .55; } 50% { transform: scaleY(1); opacity: 1; } }',
      '@keyframes dshNotifyErrorShake { 0%, 100% { transform: translateX(0); } 30% { transform: translateX(-3px); } 70% { transform: translateX(3px); } }',
      '.dsh-notify-card-saved { animation: dshNotifyCardSaved 650ms ease-out both; }',
      '.dsh-notify-error { animation: dshNotifyErrorShake 240ms ease-out both; }',
      '.dsh-notify-wave { display: inline-flex; align-items: center; gap: 2px; height: 12px; }',
      '.dsh-notify-wave > i { width: 2px; height: 10px; border-radius: 2px; background: currentColor; transform-origin: center; animation: dshNotifyWave 620ms ease-in-out infinite; }',
      '.dsh-notify-wave > i:nth-child(2) { animation-delay: 110ms; }',
      '.dsh-notify-wave > i:nth-child(3) { animation-delay: 220ms; }',
      '@media (prefers-reduced-motion: reduce) { .dsh-notify-card-saved, .dsh-notify-error, .dsh-notify-wave > i { animation: none !important; } }',
    ].join('\n')

    function SoundCard(props) {
      var draftsState = React.useState(null)
      var drafts = draftsState[0]
      var setDrafts = draftsState[1]
      var soundNamesState = React.useState([])
      var soundNames = soundNamesState[0]
      var setSoundNames = soundNamesState[1]
      var editingState = React.useState(false)
      var editing = editingState[0]
      var setEditing = editingState[1]
      var savedState = React.useState(false)
      var saved = savedState[0]
      var setSaved = savedState[1]
      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]
      var importingState = React.useState(false)
      var importing = importingState[0]
      var setImporting = importingState[1]
      var importedNameState = React.useState('')
      var importedName = importedNameState[0]
      var setImportedName = importedNameState[1]
      var previewingState = React.useState('')
      var previewing = previewingState[0]
      var setPreviewing = previewingState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var savedTimer = React.useRef(null)
      var previewTimer = React.useRef(null)
      var fileInput = React.useRef(null)

      React.useEffect(() => {
        props.getSettings().then(function (value) {
          if (value && value.sounds) setDrafts(Object.assign({}, value.sounds))
          else setDrafts({})
        }).catch(function () {
          setDrafts({})
          setError('设置读取失败')
        })
        props.listSounds().then(function (names) {
          if (Array.isArray(names) && names.length) setSoundNames(names)
        }).catch(function () {})
        return function () {
          if (savedTimer.current) clearTimeout(savedTimer.current)
          if (previewTimer.current) clearTimeout(previewTimer.current)
        }
      }, [])

      if (drafts === null) {
        return h('div', { style: { padding: '12px', fontSize: '13px', opacity: 0.6 } }, '加载中…')
      }

      var availableSounds = soundNames.length ? soundNames : FALLBACK_SOUND_NAMES
      var dirty = SOUND_ROWS.some(function (row) {
        return (drafts[row[0]] || '') !== (props.savedSounds[row[0]] || '')
      })

      var beginEdit = function () {
        setDrafts(Object.assign({}, props.savedSounds))
        setSaved(false)
        setError('')
        setImportedName('')
        setEditing(true)
      }
      var save = function () {
        if (saving) return
        var next = {
          completed: drafts.completed || '',
          error: drafts.error || '',
          aborted: drafts.aborted || '',
          approval: drafts.approval || '',
        }
        setSaving(true)
        setError('')
        props.saveSettings('sounds', next).then(function (ok) {
          setSaving(false)
          if (ok) {
            setEditing(false)
            setSaved(true)
            setImportedName('')
            if (savedTimer.current) clearTimeout(savedTimer.current)
            savedTimer.current = setTimeout(function () { setSaved(false) }, 1800)
          } else {
            setError('保存失败，请重试')
          }
        })
      }
      var discard = function () {
        setDrafts(Object.assign({}, props.savedSounds))
        setEditing(false)
        setError('')
        setImportedName('')
      }
      var preview = function (kind, sound) {
        setPreviewing(kind)
        setError('')
        if (previewTimer.current) clearTimeout(previewTimer.current)
        Promise.resolve(props.preview(kind, sound)).catch(function () {
          setError('试听失败，请检查通知权限')
        })
        previewTimer.current = setTimeout(function () { setPreviewing('') }, 1200)
      }
      var chooseFile = function () {
        if (!importing && fileInput.current) fileInput.current.click()
      }
      var handleFile = function (event) {
        var file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        if (file.size > 5 * 1024 * 1024) {
          setError('声音文件不能超过 5MB')
          return
        }
        setImporting(true)
        setImportedName('')
        setError('')
        var reader = new FileReader()
        reader.onload = function () {
          var encoded = String(reader.result || '').split(',')[1] || ''
          props.importSound({ filename: file.name, data: encoded }).then(function (result) {
            var name = result && result.name
            if (!name) throw new Error('导入结果无效')
            setSoundNames(function (current) {
              return current.includes(name) ? current : current.concat(name).sort(function (a, b) { return a.localeCompare(b, 'en') })
            })
            setDrafts(function (current) { return Object.assign({}, current, { completed: name }) })
            setImportedName(name)
          }).catch(function (err) {
            setError(String(err && err.message || '声音导入失败'))
          }).finally(function () {
            setImporting(false)
          })
        }
        reader.onerror = function () {
          setImporting(false)
          setError('声音文件读取失败')
        }
        reader.readAsDataURL(file)
      }

      return h('div', {
        className: saved ? 'dsh-notify-card-saved' : '',
        style: {
          border: '1px solid var(--dsw-alias-border-l2, #444)',
          borderRadius: '10px', padding: '14px 16px', fontSize: '13px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        },
      },
        h('style', null, feedbackCss),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
          h('div', { style: { fontWeight: 600 } }, 'macOS 通知'),
          editing
            ? h('span', {
                style: {
                  padding: '3px 7px', borderRadius: '999px', fontSize: '11px',
                  background: 'rgba(47, 111, 237, 0.1)', border: '1px solid rgba(47, 111, 237, 0.24)',
                },
              }, '编辑中')
            : h('button', {
                style: Object.assign({}, buttonStyle, saved ? {
                  color: '#238452', background: 'rgba(46, 157, 98, 0.12)',
                  borderColor: 'rgba(46, 157, 98, 0.45)', cursor: 'default',
                } : {}),
                disabled: saved,
                onClick: beginEdit,
              }, saved ? '已保存 ✓' : '编辑'),
        ),
        h('div', { style: { opacity: 0.6, fontSize: '12px' } },
          '从这台 Mac 的系统声音中选择；静音不会播放声音。OSC 9 通道下声音由终端决定。'),
        editing ? h('div', {
          style: {
            padding: '8px 9px', borderRadius: '7px', background: 'rgba(127, 127, 127, 0.06)',
            border: '1px solid var(--dsw-alias-border-l2, #444)',
          },
        },
          h('input', {
            ref: fileInput,
            type: 'file',
            accept: '.aac,.aif,.aiff,.caf,.flac,.m4a,.mp3,.oga,.ogg,.opus,.wav,audio/*',
            style: { display: 'none' },
            onChange: handleFile,
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
            h('span', { style: { fontSize: '12px', opacity: 0.7, lineHeight: 1.4 } },
              '支持常见音频，最大 5MB、10 秒；导入后自动用于任务完成。'),
            h('button', {
              style: Object.assign({}, buttonStyle, { flex: '0 0 auto', whiteSpace: 'nowrap' }),
              disabled: importing,
              onClick: chooseFile,
            }, importing ? '导入中…' : '导入声音'),
          ),
          importedName ? h('div', {
            role: 'status',
            style: { marginTop: '7px', color: '#238452', fontSize: '12px' },
          }, `✓ 已导入 ${importedName}`) : null,
        ) : null,
        error ? h('div', {
          className: 'dsh-notify-error', role: 'alert',
          style: {
            padding: '7px 9px', borderRadius: '6px', color: '#d94b43', fontSize: '12px',
            background: 'rgba(217, 75, 67, 0.1)', border: '1px solid rgba(217, 75, 67, 0.24)',
          },
        }, error) : null,
        SOUND_ROWS.map(function (row) {
          var kind = row[0]
          var value = editing ? (drafts[kind] || '') : (props.savedSounds[kind] || '')
          var isPreviewing = previewing === kind
          var choices = availableSounds.includes(value) || !value
            ? availableSounds
            : [value].concat(availableSounds)
          return h('div', {
            key: kind,
            style: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%' },
          },
            h('span', { style: { width: '72px', flex: '0 0 72px', lineHeight: 1.35 } }, row[1]),
            editing
              ? h('select', {
                  style: Object.assign({}, inputStyle, { width: 'auto', minWidth: 0, flex: '1 1 100px' }),
                  value: value,
                  'aria-label': row[1] + '提示音',
                  onChange: function (e) {
                    var next = Object.assign({}, drafts)
                    next[kind] = e.target.value
                    setDrafts(next)
                  },
                },
                  h('option', { value: '' }, '静音'),
                  choices.map(function (name) { return h('option', { key: name, value: name }, name) }))
              : h('span', {
                  style: {
                    minWidth: 0, flex: '1 1 100px', padding: '4px 8px', borderRadius: '6px',
                    background: 'rgba(127, 127, 127, 0.08)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  },
                }, value || '静音'),
            h('button', {
              style: Object.assign({}, buttonStyle, {
                width: '68px', flex: '0 0 68px', padding: '4px 6px', whiteSpace: 'nowrap',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                borderColor: isPreviewing ? 'rgba(46, 157, 98, 0.5)' : 'var(--dsw-alias-border-l2, #444)',
                background: isPreviewing ? 'rgba(46, 157, 98, 0.12)' : 'transparent',
                color: isPreviewing ? '#238452' : 'inherit',
              }),
              'aria-label': row[1] + '提示音试听',
              onClick: function () { preview(kind, value) },
            },
              isPreviewing ? h('span', { className: 'dsh-notify-wave', 'aria-hidden': 'true' },
                h('i'), h('i'), h('i')) : null,
              isPreviewing ? '播放中' : '试听'),
          )
        }),
        editing ? h('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
          h('button', {
            style: Object.assign({}, buttonStyle, { fontWeight: 600, minWidth: '72px' }),
            disabled: !dirty || saving || importing,
            onClick: save,
          }, saving ? '保存中…' : '保存'),
          h('button', { style: buttonStyle, disabled: saving || importing, onClick: discard }, '取消'),
        ) : null,
      )
    }

    // 卡片外层的受控封装：持有「已保存的 sounds」，让脏检测有据可依
    function SoundCardContainer(props) {
      var savedState = React.useState({})
      var savedSounds = savedState[0]
      var setSavedSounds = savedState[1]
      var getSettings = function () {
        return props.call('settings', { op: 'get' }).then(function (value) {
          if (value && value.sounds) setSavedSounds(Object.assign({}, value.sounds))
          return value
        })
      }
      var saveSettings = function (field, value) {
        return props.call('settings', { op: 'set', field: field, value: value }).then(function () {
          setSavedSounds(Object.assign({}, value))
          return true
        }).catch(function () { return false })
      }
      return h(SoundCard, {
        getSettings: getSettings,
        importSound: function (payload) { return props.call('sound/import', payload) },
        listSounds: function () { return props.call('sounds', {}) },
        saveSettings: saveSettings,
        savedSounds: savedSounds,
        preview: props.preview,
      })
    }

    exports.inject = ['connection', 'slots']

    exports.apply = function apply(ctx) {
      // —— 焦点上报 ——
      // 每个 tab 一个稳定 id，宿主侧按 id 去重；关 tab 后由宿主侧过期清理
      var clientId = crypto.randomUUID()
      var report = function () {
        var focused = document.visibilityState === 'visible' && document.hasFocus()
        ctx.connection.rpc.call('/macos-notify', 'visibility', {
          id: clientId,
          focused: focused,
        }).catch(function () {})
      }
      report()
      document.addEventListener('visibilitychange', report)
      window.addEventListener('focus', report)
      window.addEventListener('blur', report)
      // 心跳：让宿主侧能区分「tab 还开着但没焦点」和「tab 已关闭」
      var timer = setInterval(report, 30000)

      // —— 设置卡片 ——
      var call = function (endpoint, payload) {
        return ctx.connection.rpc.call('/macos-notify', endpoint, payload).then(function (result) {
          if (!result || result.ok !== true) throw new Error((result && result.error && result.error.message) || 'rpc failed')
          return result.value
        })
      }
      // settings.plugin.item 由「可配置」标签页声明，必须用 slots.inject 挂进去
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          id: 'macos-notify',
          order: 100,
          inject: () => ({
            call: call,
            preview: (kind, sound) => {
              return call('test', { kind: kind, sound: sound })
            },
          }),
        }, SoundCardContainer)
      })

      ctx.effect(function () {
        return function () {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', report)
          window.removeEventListener('focus', report)
          window.removeEventListener('blur', report)
        }
      })
    }

    return module.exports
  },
})
