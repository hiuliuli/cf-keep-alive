部署在Cloudflare Workers上的网页保活工具，代码由Gemini 3 Pro Preview生成。
# 界面截图
![界面截图](https://github.com/hiuliuli/cf-keep-alive/blob/main/screenshot.png)
# 部署方法
### 1. 创建 Worker
1. 登录 Cloudflare 仪表板。
2. 进入 **计算和AI** -> **Workers 和 Pages**。
3. 点击 **创建应用程序 (Create application)**，选择从 **Hello World!** 开始。
4. 为 Worker 命名，然后点击 **部署 (Deploy)**。
### 2. 上传代码
1. 创建成功后，点击 **编辑代码 (Edit code)**。
2. 删除编辑器中的默认代码。
3. 复制 [`_worker.js`](https://github.com/hiuliuli/cf-keep-alive/blob/main/_worker.js) 的全部内容，粘贴到编辑器中。
4. 点击 **部署 (Deploy)**。
### 3. 绑定KV
1. 创建KV数据库，进入存**储和数据库**，点击**Workers KV** -> **Create Instance**，名称随意。
2. 返回Workers管理页面，点击**绑定** -> **添加绑定** -> **KV命名空间** -> **添加绑定**。
3. 变量名称**MY_KV**，KV命名空间选择刚刚创建的，最后添加绑定即可。
### 4. 设置定时触发器
1. 在 Worker 的设置页面，添加 **触发事件**。
2. 在 **触发事件** 下，添加一个Corn 触发器。
3. 选择一个合适的执行频率（例如 `每 30 分钟`）。
4. 保存触发器。
#### 完成部署，绑定自定义域名（可选），访问页面，设置密码，进入页面。
