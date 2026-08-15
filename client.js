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

    var inputStyle = {
      width: '140px', padding: '4px 8px', fontSize: '13px',
      border: '1px solid var(--dsw-alias-border-l2, #444)',
      borderRadius: '6px', background: 'transparent', color: 'inherit',
    }
    var buttonStyle = {
      padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2, #444)',
      borderRadius: '6px', background: 'transparent', color: 'inherit',
    }

    function SoundCard(props) {
      var draftsState = React.useState(null)
      var drafts = draftsState[0]
      var setDrafts = draftsState[1]
      var savedState = React.useState(false)
      var saved = savedState[0]
      var setSaved = savedState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]

      React.useEffect(() => {
        props.getSettings().then(function (value) {
          if (value && value.sounds) setDrafts(Object.assign({}, value.sounds))
          else setDrafts({})
        }).catch(function () {
          setDrafts({})
          setError('设置读取失败')
        })
      }, [])

      if (drafts === null) {
        return h('div', { style: { padding: '12px', fontSize: '13px', opacity: 0.6 } }, '加载中…')
      }

      var dirty = SOUND_ROWS.some(function (row) {
        return (drafts[row[0]] || '') !== (props.savedSounds[row[0]] || '')
      })

      var save = function () {
        var next = {
          completed: drafts.completed || '',
          error: drafts.error || '',
          aborted: drafts.aborted || '',
          approval: drafts.approval || '',
        }
        props.saveSettings('sounds', next).then(function (ok) {
          if (ok) {
            setSaved(true)
            setTimeout(function () { setSaved(false) }, 2000)
          } else {
            setError('保存失败')
          }
        })
      }
      var discard = function () { setDrafts(Object.assign({}, props.savedSounds)) }

      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l2, #444)',
          borderRadius: '10px', padding: '14px 16px', fontSize: '13px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        },
      },
        h('div', { style: { fontWeight: 600 } }, 'macOS 通知'),
        h('div', { style: { opacity: 0.6, fontSize: '12px' } },
          '各事件的提示音（macOS 系统声音名，如 Glass / Basso / Ping / Pop；留空为静音）。OSC 9 通道下声音由终端决定。'),
        error ? h('div', { style: { color: '#e5534b', fontSize: '12px' } }, error) : null,
        SOUND_ROWS.map(function (row) {
          var kind = row[0]
          return h('div', {
            key: kind,
            style: { display: 'flex', alignItems: 'center', gap: '8px' },
          },
            h('span', { style: { width: '150px' } }, row[1]),
            h('input', {
              style: inputStyle,
              value: drafts[kind] || '',
              placeholder: '声音名，留空静音',
              onChange: function (e) {
                var next = Object.assign({}, drafts)
                next[kind] = e.target.value
                setDrafts(next)
              },
            }),
            h('button', {
              style: buttonStyle,
              onClick: function () { props.preview(kind) },
            }, '试听'),
          )
        }),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
          h('button', {
            style: Object.assign({}, buttonStyle, { fontWeight: 600 }),
            disabled: !dirty,
            onClick: save,
          }, saved ? '已保存 ✓' : '保存'),
          h('button', { style: buttonStyle, disabled: !dirty, onClick: discard }, '放弃修改'),
        ),
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
            preview: (kind) => {
              call('test', { kind: kind }).catch(function () {})
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
