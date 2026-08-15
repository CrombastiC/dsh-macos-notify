// dsh-macos-notify 的浏览器半：跟踪 tab 焦点/可见性并上报给宿主插件。
// 手写 bundle，零构建；格式即 dsh-client-modules 的 __ModuleLoader__ 包装。
window.__ModuleLoader__.load({
  id: 'dsh-macos-notify',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    // 每个 tab 一个稳定 id，宿主侧按 id 去重；关 tab 后由宿主侧过期清理
    var clientId = crypto.randomUUID()

    exports.apply = function apply(ctx) {
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
