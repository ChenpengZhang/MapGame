# 邮件模板（腾讯云邮件推送）

这里存放**手工粘贴到腾讯云控制台的邮件模板内容**，不是运行时资源——后端代码不会读取本目录的任何文件。

## 为什么放在这里

- 它不是代码，`src/` 放不合适；后端启动也不会 import 它。
- 它也不进发行包（`build-release.js` 只打包运行必需的文件），所以放 `backend/` 下不会被误打包。
- 但它和 `src/infrastructure/mail.js` 里的 `TemplateData` **变量名强绑定**，改一边必须改另一边，所以放在后端旁边最容易发现。

> 备选位置是 `backend/deploy/`（那里放着 `nginx.conf.example`，同属「手工配置」类）。我选了 `templates/`，因为它自我说明、以后加别的邮件模板（欢迎信、爬塔成绩通知等）也能直接往里放。

## 文件

| 文件 | 粘贴到控制台的哪一格 |
|---|---|
| `verification-code.html` | 邮件推送 → 模板管理 → 新建模板 → **HTML 正文** |
| `verification-code.txt` | 同一模板的 **纯文本正文** |

## 变量契约（改这里 = 改代码）

模板变量由 `backend/src/infrastructure/mail.js` 传入：

```js
TemplateData: JSON.stringify({ action, code, url })
```

| 变量 | 含义 | 取值 |
|---|---|---|
| `{{action}}` | 本次操作名 | `邮箱验证` 或 `重置密码` |
| `{{code}}` | 6 位数字验证码 | 由 better-auth 生成 |
| `{{url}}` | 链接（备用） | 目前是空字符串，模板里没用它 |

> `url` 对应的「发链接」分支在 `mail.js` 里其实走不到——`sendMail` 目前只有 `auth.js` 一处调用，且必定带 `otp`。保留它只是为了少改一次代码。

**邮件主题不由模板决定**，而是代码里写的：

- 邮箱验证 → `MapGame：邮箱验证码`
- 重置密码 → `MapGame：重置密码验证码`

所以控制台如果要求填主题，填上面两条中任一条即可（真实发送时以代码传的为准）。

## 操作步骤

1. 邮件推送控制台 → **模板管理 → 新建模板**
2. 模板名称：`MapGame验证码`
3. HTML 正文：粘贴 `verification-code.html` 全文
4. 纯文本正文：粘贴 `verification-code.txt` 全文
5. 提交审核，通过后记下**模板 ID**，填进 `backend/.env` 的 `TENCENT_SES_TEMPLATE_ID`

## 注意

- 腾讯云 API 发信**强制使用模板**（新账号不能用 `SendEmail` 的 `Simple` 字段），所以这个模板不是可选项。
- 模板要过审。如果因为样式或「验证码」相关规则被驳回，可以把 HTML 简化（去掉圆角、彩色条等装饰，只留纯文本 + 验证码），纯文本内容一般都能过。
- 模板正文里的变量**只能是简单值**，不能塞 HTML 片段。
- 改动变量的名字时，务必同步改 `mail.js` 里的 `TemplateData`，否则邮件里会渲染成空字符串且**不会报错**——这种问题很难发现。
