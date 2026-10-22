# 日志配置与发布规则

日志配置统一在 `core/constants.js` 的 `LOG_CONFIG`，不通过用户设置页或浏览器存储修改。

```js
const LOG_CONFIG = Object.freeze({
  environment: "development",
  level: "debug"
});
```

| 级别 | 输出范围 |
| --- | --- |
| off | 全部关闭 |
| error | error |
| warn | error、warn |
| info | error、warn、info |
| debug | 全部，包括逐任务诊断和补翻扫描 |

只有 `environment: "development"` 允许主动日志。`production` 或未知环境强制静默，即使把 level 写成 debug 也不输出；未知等级同样关闭。配置在每个上下文加载时确定，修改后需重新加载扩展并刷新网页。

## 开发使用

- 日常观察使用 info，查看整页启动/完成信息。
- 排查排队、实际并发、分块、AI HTTP 耗时和保护标记问题时使用 debug。
- F12 控制台选择包含 Verbose/详细的级别，否则浏览器可能隐藏 console.debug。筛选 `[页知译]`；阶段诊断可筛选 `[页知译][诊断]`。
- 调用统一入口 `BT_LOG.error/warn/info/debug`，禁止运行代码直接调用 console。错误对象可能包含私密内容，不直接打印；源文、译文、密钥、完整 URL/请求体和内部凭据作用域不得写入日志。
- debug 关闭时不注册后台诊断回调，也不向页面发送诊断消息；错误状态、限流状态和用户可见提示照常处理。
- 修改日志级别不会改变请求频率、并发、缓存和重试。

## 发布流程

执行 `npm run package`：

1. 将运行白名单复制到临时目录，不修改本地开发文件。
2. 在副本中强制设置 `environment: "production"`、`level: "off"`。
3. 执行日志模块并调用全部级别，确认无主动输出。
4. 压缩后读取 ZIP 内实际配置，再验证一次才报告打包成功。
5. 清理本轮临时目录；已有同名 ZIP 仍拒绝覆盖，历史安装包不会自动变更。

商店上传经过此流程生成的新包。直接手动压缩开发源码不会自动执行发布转换。发布配置和开发源码的 constants.js 有意不同，文件一致性核对应当以发布转换后的副本为准。

“关闭日志”指本扩展代码主动打印。网页自身、Chrome 自身及未处理异常可能仍由浏览器输出；不替换全局 console、不隐藏异常，也不撤销用户可见的错误提示。代码本身可被本地修改，生产模式不是防篡改机制。

验证入口：`node tests/logging.cjs`、`npm run check`、`npm test`；完整扩展集成测试同时支持开发诊断与生产无诊断两种配置。
