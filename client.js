// dsh-macos-notify 的浏览器半：
// 1. 跟踪 tab 焦点/可见性并上报给宿主插件（焦点抑制用）
// 2. 在 设置 → 插件 → 可配置 里注册提示音卡片（settings.plugin.item slot）
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
      var scope = props.scope
      var snap = React.useSyncExternalStore(
        scope.subscribe.bind(scope),
        scope.getSnapshot.bind(scope),
      )
      var sounds = (snap.value && snap.value.sounds) || {}
      var draftsState = React.useState(null)
      var drafts = draftsState[0]
      var setDrafts = draftsState[1]
      var savedState = React.useState(false)
      var setSaved = savedState[1]

      // 快照首次就绪时用当前值初始化草稿；之后草稿归用户，不被快照覆盖
      React.useEffect(() => {
        if (snap.status === 'ready' && drafts === null) {
          setDrafts(Object.assign({}, sounds))
        }
      }, [snap.status])

      if (snap.status === 'loading' || drafts === null) {
        return h('div', { style: { padding: '12px', fontSize: '13px', opacity: 0.6 } }, '加载中…')
      }

      var dirty = SOUND_ROWS.some(function (row) {
        return (drafts[row[0]] || '') !== (sounds[row[0]] || '')
      })

      var save = function () {
        scope.set('sounds', {
          completed: drafts.completed || '',
          error: drafts.error || '',
          aborted: drafts.aborted || '',
          approval: drafts.approval || '',
        }).then(function () {
          setSaved(true)
          setTimeout(function () { setSaved(false) }, 2000)
        })
      }
      var discard = function () { setDrafts(Object.assign({}, sounds)) }
      var preview = function (kind) {
        props.preview(kind)
      }

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
              onClick: function () { preview(kind) },
            }, '试听'),
          )
        }),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
          h('button', {
            style: Object.assign({}, buttonStyle, { fontWeight: 600 }),
            disabled: !dirty,
            onClick: save,
          }, savedState[0] ? '已保存 ✓' : '保存'),
          h('button', { style: buttonStyle, disabled: !dirty, onClick: discard }, '放弃修改'),
        ),
      )
    }

    exports.apply = function apply(ctx) {
      // —— 焦点上报 ——
      // 每个 tab 一个稳定 id，宿主侧按 id 去重；关 tab 后由宿主侧过期清理
      var clientId = crypto.randomUUID()
      var report = function () {
        var focused = document.visibilityState === 'visible' && document.hasFocus()
        ctx.connection.call('/api', 'macos-notify/visibility', {
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
      var scope = ctx.settingsScope.bind({ namespace: 'macos-notify' })
      void scope.load()
      ctx.slots.register({
        name: 'settings.plugin.item',
        id: 'macos-notify',
        order: 100,
        inject: () => ({
          scope: scope,
          preview: (kind) => {
            ctx.connection.call('/api', 'macos-notify/test', { kind: kind }).catch(function () {})
          },
        }),
      }, SoundCard)

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
