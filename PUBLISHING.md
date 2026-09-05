# 发布注意事项

仅仓库内文档：本文件不在 `package.json` 的 `files` 白名单里，**不会**被打进 npm 包（白名单外的文件一律不发布，README/LICENSE/package.json 由 npm 恒定携带）。

## 本机环境的坑

- 默认 registry 是 **npmmirror 镜像**（`~/.npmrc` 的 `registry=` 行）。不带参数的 `npm login` / `npm whoami` 会走镜像，而镜像不认 npmjs 的 token，报 `ENEEDAUTH`。
- 登录和验证官方源必须显式指定：

  ```bash
  npm login --registry=https://registry.npmjs.org/
  npm whoami --registry=https://registry.npmjs.org/
  ```

- 在 npmjs.com **网页**上登录不会给 CLI 写 token；`~/.npmrc` 里的 token 只能来自 `npm login` 命令（浏览器授权流程）。
- token 会过期：`whoami` 返回 `E401` 就是过期/被撤销，重新 `npm login` 即可（文件 `~/.npmrc`，无需把 token 给任何人）。
- 发布不受镜像影响：`package.json` 的 `publishConfig.registry` 已固定官方源。

## 发布时的 2FA

- 账号开启了发布时二次验证。`npm publish` 会报 `EOTP` 并给出网页授权 URL，在浏览器完成授权后发布才继续。
- **CLI 进程退出而未完成授权 = 什么都没发出去**。用 `npm view` 确认 registry 上的实际版本，别凭 publish 命令的输出判断。

## publish 报 E404（Not found / no permission）

- 这是**认证通过、鉴权被拒**：npm 对无权限发布统一返回 404 而不是 403。先排除 E401（token 已死，见上）和 EOTP（2FA 未完成）。
- 定案两步（必须在**发布用的那个终端**里跑，官方源）：

  ```bash
  npm whoami --registry=https://registry.npmjs.org/
  npm view dsh-macos-notify maintainers --registry=https://registry.npmjs.org/ --prefer-online
  ```

- **whoami 不是包维护者**：登错号了，`npm logout` 后用维护者账号重登。
- **whoami 是维护者但依然 404**：token 是 granular token 且没给这个包写权限。去 npmjs.com → Access Tokens，把该 token 的 Packages and scopes 改成 Read and write 并覆盖本包；或删掉重走 `npm login` 拿一枚全权限 token。
- 不同终端会话可能用不同凭据（项目级 `.npmrc`、shell 环境变量、publish 时的临时参数）。排障一律以发布终端的 `whoami` 为准，别处的只能参考。

## 发布清单（按序执行）

1. `main` 干净且与 `origin/main` 同步
2. 改 `package.json` 版本号
3. 新增源码文件必须加进 `package.json` 的 `files` 白名单——否则发布出去的包会缺模块（0.4.0 的 `src/state.js` 差点漏掉）
4. `npm run prepublishOnly`（语法检查 + 全量测试；`npm publish` 也会自动跑一遍）
5. `npm pack --dry-run --json` 留档 `integrity`，发布后比对
6. `git commit` + `git tag vX.Y.Z` + 推送（`local` 和 `origin` 都推）
7. `npm publish`（按提示在浏览器完成 2FA）
8. 发布后三件套校验：

   ```bash
   npm view dsh-macos-notify version dist-tags.latest dist.integrity --registry=https://registry.npmjs.org/ --prefer-online
   ```

   `version` / `dist-tags.latest` 应为新版本号，`dist.integrity` 必须与第 5 步留档值逐字一致——一致才能确认 registry 上的就是本地打包内容。

## 历史踩坑记录

- 0.4.0 发布时：先 `EOTP` 中断（进程退出后 registry 仍是 0.3.0），在主检出目录重新 `npm publish` 浏览器授权后成功；integrity 比对通过。
- 0.4.1 发布时：PUT 报 E404。排查确认 `~/.npmrc` 的旧 token 已 E401，发布终端另有会话级凭据（认证通过但无写权限）；registry 保持 0.4.0 未受影响。待 token 权限修复后重发并做三件套校验。
