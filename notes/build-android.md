# Paseo Android APK 构建链调研（Ubuntu runner 直接出 debug-signed release APK）

> 调研日期：2026-02。基于仓库 commit 时的 `packages/app` 0.9.1 / Expo SDK 54 / RN 0.81.5。
> 结论均已核对仓库源码；引用处以 `路径` 标注。
>
> **补记（调研当日 17:44 UTC）**：调研中途，工作区（未提交）出现 `npm i` 痕迹——`packages/app/package.json` + 根 `package-lock.json` 被（另一 session）加入 `@runanywhere/core`、`@runanywhere/onnx`，以及 `react-native-blob-util`、`react-native-device-info`、`react-native-fs` 三个常规 RN community 模块。三者均为标准 autolinking 模块，不影响本文结论；§6 的 @runanywhere 注意点照常适用。

---

## 0. TL;DR

1. **上游官方发 APK 的方式是 EAS 云构建**（`packages/app/eas.json` 的 `production-apk` profile + `.github/workflows/android-apk-release.yml`），仓库里**没有**现成的"GitHub runner 上跑 gradle"的 workflow —— 想不依赖 EAS/EXPO_TOKEN 自建 APK，需要自己写，下文给出成品。
2. **必须走 expo prebuild**：`android/` 目录不入库（CNG 模式），每次构建用 `expo prebuild --platform android --clean` 重新生成，再 `./gradlew :app:assembleRelease`。仓库自己的 `npm run android:production` 脚本就是这个流程。
3. **签名零处理**：Expo SDK 54 prebuild 模板的 release buildType 默认就用 `debug.keystore` 签名（模板源码已核对），`assembleRelease` 直接产出 debug-signed APK，**不需要 EAS 凭据、不需要自建 keystore**。
4. 新增 `@runanywhere/core` + `@runanywhere/onnx`（Nitro 模块）：app 已有 `react-native-nitro-modules@0.35.5` 且 `newArchEnabled: true`，CNG 流程自动收编；坑在**体积**（两个包解压后共 ~820MB，全是预编译 .so）、**构建期需要 NDK+CMake 3.30.5**（会自动下载）、以及 **nitrogen 0.34 生成物 vs nitro-modules 0.35 运行时**的版本匹配问题。详见 §5。

---

## 1. 调查点 1：app 的构建配置现状

### 1.1 scripts（`packages/app/package.json`）

| script | 内容 |
|---|---|
| `android:production` | `npm --prefix ../.. run build:client` → `APP_VARIANT=production expo prebuild --platform android --clean --non-interactive` → `expo run:android --variant=release` |
| `android:development` | 同上，`APP_VARIANT=development` + `--variant=debug` |
| `android:clear` | 删除生成的 `android/` 目录 |
| `eas-build-post-install` | `npm --prefix ../.. run build:app-deps` + `npm run build:terminal-webview` —— **EAS 云构建在 npm ci 后自动执行的生命周期钩子**，自建 runner 时要手动补跑这两条 |

关键点：官方流程 = **build:client → prebuild → gradle**。`expo run:android` 那步是"装到连着的设备"，CI 上不可用，要拆成 prebuild + `./gradlew` 两步。

### 1.2 expo 配置（`packages/app/app.config.js`）

- **`APP_VARIANT` 环境变量**（默认 `production`）决定变体：`production` → 包名 `sh.paseo`/应用名 "Paseo"；`development` → `sh.paseo.debug`/"Paseo Debug"。**prebuild 和 gradle 打 bundle 时都要有这个变量**（docs/android.md 明确说 flag 必须"两处都在"）。
- `newArchEnabled: true` —— Nitro 模块的前置条件，已满足。
- `autolinking.searchPaths: ["../../node_modules", "./node_modules"]` —— npm workspaces 把 native 依赖提升到根 `node_modules`，新装的 `@runanywhere/*` 提升后自动被扫到。
- `plugins` 里已有的关键插件：
  - `expo-build-properties`：`minSdkVersion 29`、`kotlinVersion 2.1.20`、`usesCleartextTraffic: true`（自托管 daemon 走 HTTP 需要）。
  - `expo-gradle-jvmargs`：Gradle `-Xmx4096m` + metaspace 1024m（写进 gradle.properties，CI 内存够用）。
  - 本地 config plugins：`withPasteInput`、`withAndroidScroll`（注册 `packages/app/modules/paseo-scroll` 本地模块）、`with-android-async-storage-size`。
- `googleServicesFile` 是**可选的**：`resolveSecretFile()` 找不到 env 也找不到 `.secrets/` 文件就返回 `undefined`，配置里直接不出现 —— 没有它照样 prebuild/编译，只是推送注册运行时不可用（见 §5 坑 2）。
- 版本号：`native-release-version.js` 从 `package.json` 版本推导，`0.9.1 → versionCode 9001`（`major*1_000_000 + minor*1_000 + patch`）。
- 依赖里的 native 模块（Autolinking 对象）：expo-audio、expo-camera、expo-sqlite、@shopify/react-native-skia、react-native-unistyles、`react-native-nitro-modules@0.35.5`（当前由 unistyles 和 app 直接依赖引入）、workspace 内的 `@getpaseo/expo-two-way-audio`（自带 `android/` 源码的 fork）。**Nitro 已是现有构建的一部分**。

### 1.3 其他构建前置

- `npm ci` 触发根 `postinstall`：`scripts/postinstall-patches.mjs`，用 patch-package 打 `patches/*.patch`（unistyles、gesture-handler、svg、paste-input 等 6 个）。**不能用 `--ignore-scripts`**。
- `build:app-deps`（根 package.json）= 依次构建 `highlight`、`client`、`plugin`、`expo-two-way-audio`（tsc 产出 dist/build，Metro 打 bundle 时要）。
- `build:terminal-webview`（app 内）：esbuild 生成 `src/terminal/webview/terminal-emulator-webview-html.ts`。此文件已提交入库，但照抄 `eas-build-post-install` 重跑一遍最保险。
- `build:mermaid-runtime` 的产物 `html.gen.ts` 也已提交，**无需**在 CI 重跑。
- 工具链 pin（`.tool-versions`）：`nodejs 22.20.0`、`java 21`、`android-sdk 21.0`（mise 只装 cmdline-tools，platform/build-tools 由 gradle 自动补）。CI（`.github/workflows/ci.yml`）全部用 Node 22。
- 根 `package-lock.json` 里 **0 处** `npm.pkg.github.com` 引用 —— `android-apk-release.yml` 里的 `registry-url`/`NODE_AUTH_TOKEN` 是历史残留，自建 workflow 不需要任何 npm 鉴权。

---

## 2. 调查点 2：现有 CI 里有没有可复用的 app 构建流程

`.github/workflows/` 下与 app 相关的三个：

| workflow | 干什么 | 可复用度 |
|---|---|---|
| `android-apk-release.yml` | **EAS 云构建**：`npx eas build --platform android --profile production-apk`，等云端出 APK 再下载传 GitHub Release。需要 `EXPO_TOKEN` secret，构建发生在 Expo 的机器上 | 流程参考价值高（lint 跳过参数、tag 语义），但构建本身不可复用 |
| `ci.yml` | 只有 `app-tests` job：`npm run build:app-deps` + vitest，**没有任何 gradle/Android 步骤** | 复用其安装姿势：Node 22 + `node scripts/npm-retry.mjs ci` |
| `deploy-app.yml` | Web 版部署到 Cloudflare Pages | 无关 |

`docs/release.md` L309 也明说：Android APK（GitHub Release 资产）是"本仓库唯一在 Actions 里跑的 Android 相关 workflow"（即上面 EAS 那个），**商店二进制由 Expo 服务器上的 EAS GitHub App 构建，没有 workflow 文件**。

**可复用的具体资产**：
- `eas.json` 的 `production-apk` profile 里那段 gradle 命令（见 §3）——含 lint 跳过参数，直接抄。
- `node scripts/npm-retry.mjs ci`（npm ci 带重试，上游 CI 自用）。
- `android-apk-release.yml` 的 tag 触发约定：`v*` 稳定版走全量发布，`beta` 和 `android-v*` 只出 GitHub APK —— 自建 workflow 想接入发布体系可沿用。

---

## 3. 调查点 3：fastlane / eas.json / 官方发布方式

- **根 `fastlane/`**：只有 F-Droid 商店元数据（`fastlane/metadata/android/<locale>/`，标题/截图/changelog），不是构建脚本。docs/android.md 有整节说明。
- **`packages/app/fastlane/`**：`Fastfile` 首行 `default_platform(:ios)`，唯一 lane 是 iOS 提审（TestFlight → App Store review）。`Gemfile` 是配套 bundler。**Android 完全没有 fastlane lane**。
- **`packages/app/eas.json`**：
  - `development`：`assembleDebug`，internal distribution；
  - `production`：Play 商店用（EAS 托管凭据，`resourceClass: large`）；
  - `production-apk`：GitHub Release APK 用 ——
    ```text
    gradleCommand: :app:assembleRelease
                    -x lint -x lintVitalAnalyzeRelease -x lintVitalRelease
                    -x generateReleaseLintModel -x generateReleaseLintVitalModel
    buildType: apk, resourceClass: large
    ```
    **"resourceClass: large" 是官方踩坑证据**：docs/android.md 记载 release 构建在同一 gradle 调用里编 native ABI + Hermes，默认资源规格会 OOM kill Hermes（exit 137）。GitHub ubuntu runner 16GB 内存足够，但这个坑要记着。
- **官方发布全景**（docs/release.md + docs/android.md "Cloud build + submit" 节）：
  - 打 `v*` tag → EAS GitHub App 在 Expo 云上构建 iOS + Android 商店包并自动提审/提交 Play；
  - 同时 `android-apk-release.yml` 在 Actions 上再调一次 EAS 出 APK 传 GitHub Release；
  - beta tag / `android-v*` tag 只触发 APK workflow。
  - 即：**官方从不在 GitHub runner 上编译 Android**，自建 runner 构建是新路子，无现成流程可抄，但所有原材料（prebuild 命令、gradle 命令、JDK/Node 版本）都散落在本地开发文档里。

---

## 4. 调查点 4：要不要 prebuild？要不要处理签名？

### 4.1 prebuild：必须要

- 仓库**不提交** `android/`（工作区里确认无此目录；`android:clear` 脚本专门删它），是纯 CNG（Continuous Native Generation）项目。
- `docs/android.md` 给出的本地命令就是 prebuild + run 的两段式，CI 等价改写为 prebuild + `./gradlew`。

### 4.2 签名：零处理，debug-signed 是默认行为

Expo SDK 54 prebuild 模板 `android/app/build.gradle`（已核对 sdk-54 分支源码）：

```groovy
signingConfigs {
    debug {
        storeFile file('debug.keystore')
        storePassword 'android'
        keyAlias 'androiddebugkey'
        keyPassword 'android'
    }
}
buildTypes {
    debug { signingConfig signingConfigs.debug }
    release {
        // Caution! In production, you need to generate your own keystore file.
        signingConfig signingConfigs.debug   // ← release 也用 debug keystore
        ...
    }
}
```

且模板自带 `android/app/debug.keystore` 文件（随 prebuild 复制进生成目录）。所以：

- `./gradlew :app:assembleRelease` 产出的就是 **debug-signed release APK**，开箱即用，不上商店完全够。
- keystore 固定 → 每次 CI 构建签名一致 → 手机上覆盖安装没问题。
- EAS 商店构建则是构建时注入正式凭据（`serving the same template`），与我们无关。

**两个附带提醒**：
1. production variant 包名是 `sh.paseo`，与 Play 商店版**同包名**。如果手机上装着商店版/EAS 签名版，sideload 前要先卸载（签名不同无法共存/覆盖）。想要共存，可临时用 `APP_VARIANT=development`（`sh.paseo.debug`）出包，但那是 dev-client 变体，不是日常可用的 app。
2. debug.keystore 是 Expo 模板的公开 keystore，绝对不能拿去发商店；若以后想要自己的稳定签名，生成一个 keystore 后用小 config plugin 改写 release signingConfig 即可（无需动模板）。

---

## 5. 推荐的 GitHub Actions workflow（可直接照做）

放在你 fork 的 `.github/workflows/android-apk-local.yml`（与上游 workflow 不冲突）。目标：**ubuntu runner 上出 `sh.paseo` production 变体、debug-signed 的 release APK，上传 artifact**。

```yaml
name: Android APK (self-hosted runner build)

on:
  workflow_dispatch:
  push:
    branches:
      - main            # 按需改成你的分支或 tags: ['android-v*']

concurrency:
  group: android-apk-${{ github.ref }}
  cancel-in-progress: true

env:
  # packages/app/app.config.js 读它决定变体；production => sh.paseo / "Paseo"
  # prebuild 和 gradle 打 bundle 两步都必须带着（docs/android.md 的要求）
  APP_VARIANT: production
  EXPO_NO_TELEMETRY: "1"

jobs:
  build-apk:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node 22
        uses: actions/setup-node@v4
        with:
          node-version: "22"        # .tool-versions pin nodejs 22.20.0；上游 ci.yml 同款
          cache: "npm"

      - name: Setup JDK 21
        uses: actions/setup-java@v4
        with:
          distribution: "temurin"
          java-version: "21"        # .tool-versions pin java 21（RN 0.81 最低 17）
          cache: "gradle"           # 缓存 ~/.gradle（wrapper/AGP/kotlin/依赖），二次构建省 ~10min

      - name: Install JS dependencies
        run: node scripts/npm-retry.mjs ci
        # npm ci 会触发根 postinstall(scripts/postinstall-patches.mjs) 打 patches/*.patch，不能 --ignore-scripts

      - name: Build workspace JS deps
        # 等价于 packages/app package.json 里的 eas-build-post-install 钩子（EAS 会自动跑，这里手动跑）
        run: |
          npm run build:app-deps
          npm run build:terminal-webview --workspace=@getpaseo/app

      - name: Expo prebuild (CNG: 生成 android/)
        working-directory: packages/app
        run: npx expo prebuild --platform android --clean --non-interactive

      - name: Gradle assembleRelease
        working-directory: packages/app/android
        run: >
          ./gradlew :app:assembleRelease
          -x lint -x lintVitalAnalyzeRelease -x lintVitalRelease
          -x generateReleaseLintModel -x generateReleaseLintVitalModel
          --stacktrace
        # ↑ lint 跳过参数逐字抄自 packages/app/eas.json 的 production-apk profile
        #
        # 可选（APK 体积/时长大降）：只出 arm64 单 ABI。
        # runanywhere 的 build.gradle、Skia、Nitro 都认 rootProject 的 reactNativeArchitectures 属性：
        #   ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a ...

      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: paseo-android-apk
          path: packages/app/android/app/build/outputs/apk/release/app-release.apk
          if-no-files-found: error
```

### 每步依据速查

| 步骤 | 依据 |
|---|---|
| Node 22 | `.tool-versions` `nodejs 22.20.0`；`.github/workflows/ci.yml` 所有 job 用 `"22"` |
| JDK 21 (temurin) | `.tool-versions` `java 21`；`docs/android.md` "Prerequisites" 节同 pin；runner 预装 17 默认，显式 21 与上游一致 |
| `npm-retry.mjs ci` | `ci.yml`/`android-apk-release.yml`/`deploy-app.yml` 三处同款；postinstall 补丁见 `scripts/postinstall-patches.mjs` |
| `build:app-deps` + `build:terminal-webview` | `packages/app/package.json` → `eas-build-post-install`（EAS post-install 钩子逐字对应）；`ci.yml` app-tests 也先跑 `build:app-deps` |
| `expo prebuild --platform android --clean --non-interactive` | `packages/app/package.json` → `android:production`；`docs/android.md` 本地命令节 |
| `:app:assembleRelease` + `-x lint...` | `packages/app/eas.json` → `production-apk.android.gradleCommand` |
| 不需要任何 secrets | 签名=模板 debug.keystore（§4.2）；npm 无私有源（package-lock 0 处 npm.pkg.github.com）；googleServicesFile 可选（app.config.js `resolveSecretFile`） |
| 无 EXPO_TOKEN / eas-cli | 上游 workflow 用 EAS 是因为构建在云端；本地 runner 构建用不到 `expo/expo-github-action` |

首次构建预计 30–60 分钟（下载 Gradle 8.14.3 wrapper、AGP、Kotlin 2.1.20、NDK、CMake），之后有 gradle cache 约 20–35 分钟。

---

## 6. 坑清单（自建构建 + 新增 @runanywhere 都覆盖）

### 通用坑

1. **内存与 exit 137**：release 构建在同一个 gradle 调用里做 native 编译 + Hermes bundling。docs/android.md 明确记载默认 worker 配置会把 Hermes kill 掉（EAS 因此用 large resource class，8GB）。app 已通过 `expo-gradle-jvmargs` 插件把 Gradle 堆设为 4096m（app.config.js plugins），GH runner 16GB 一般够；若复现 OOM，加 `--max-workers=2` 或限制 ABI。
2. **google-services 缺失**：无 `GOOGLE_SERVICES_FILE_PROD` secret/文件时推送注册运行时不可用（编译不受影响；F-Droid 源码构建干脆整个排除 expo-notifications，可见无 Firebase 也能编译）。自用 APK 接自托管 daemon 不需要推送，可无视。
3. **lint 任务**：不跳过的话 `lintVitalRelease` 可能因第三方库 metadata 误报挂构建 —— 上游 EAS 配置已经全部 `-x`，照抄即可（§5 已含）。
4. **首构建的自动下载**：runner 预装 NDK 默认版是 27.3.13750724，而 RN 0.81 项目 `ndkVersion` 是 27.1.x → AGP 自动下载 ~2GB；Gradle wrapper 8.14.3、Kotlin 2.1.20 同理。都自动、都成功，只是首跑慢；`setup-java` 的 gradle cache 不覆盖 NDK（在 ANDROID_HOME 下），在意可另加 `actions/cache` 缓存 `$ANDROID_HOME/ndk/*`。
5. **React 版本锁死**：`react`/`react-dom` 必须与 RN 0.81 内嵌版本 19.1.0 锁死，乱升 patch 会编译通过但启动即崩（docs/android.md "React version lockstep"，有血泪记载）。
6. **版本号**：versionCode 由 `packages/app/native-release-version.js` 从 `package.json` 版本推导，别在 workflow 里另行注入/递增，否则和上游 F-Droid/商店版本号体系打架。

### @runanywhere / Nitro 专项（调查点 5：CNG 流程）

**CNG 流程本身**（新增任意第三方 native 模块通用）：

```bash
npm i @runanywhere/core @runanywhere/onnx -w packages/app   # 只动 package.json + package-lock
# 提交后，每次构建时：
npx expo prebuild --platform android --clean                 # 重新生成 android/
./gradlew :app:assembleRelease                               # autolinking 已把新模块编进去
```

- 不提交 `android/`、不手改生成物；模块有无 `expo-module.config.json` 决定走 Expo 原生模块协议还是 RN community autolinking（Expo autolinking 对后者透明兼容）。
- 验证：prebuild 后查 `packages/app/android/settings.gradle` 是否注入了新模块的 `include`。
- 本地自研模块的参照物：`packages/app/modules/paseo-scroll`（package.json + expo-module.config.json + app.plugin.js，经 `app.config.js` 的 `withAndroidScroll` 插件注册）。

**@runanywhere 两个包的实测情况**（npm tarball 解包核对，0.20.27）：

1. **它们是 Nitro 模块但不是 Expo 模块**：无 `expo-module.config.json`，靠 `react-native.config.js` + `nitrogen/generated/android/*+autolinking.gradle` 走 RN autolinking；运行时依赖 `project(":react-native-nitro-modules")` —— app 已装 `react-native-nitro-modules@0.35.5`（`packages/app/package.json`），前置条件齐。
2. **体积爆炸**：`@runanywhere/core` 解压 446MB、`@runanywhere/onnx` 371MB，主体是 `android/src/main/jniLibs/<abi>/*.so`（RACommons、onnxruntime、sherpa-onnx，默认捆绑 arm64-v8a/armeabi-v7a/x86_64 三个 ABI）。→ npm ci 时间显著变长、node_modules +~1GB；**强烈建议构建时传 `-PreactNativeArchitectures=arm64-v8a`**（它们的 build.gradle 明确支持覆盖，见其 `reactNativeArchitectures()` 函数），最终 APK 能小一半以上。
3. **gradle 阶段还会联网**：两个包的 `downloadNativeLibs` task 在 `preBuild` 前检查 jniLibs——npm 包已捆绑齐 3 个 ABI 时走 "bundled" 分支不下载；一旦你用 `reactNativeArchitectures` 过滤了 ABI，"部分捆绑" 分支会尝试从 `github.com/RunanywhereAI/runanywhere-sdks` Releases 补下载缺的 ABI。GHA 网络没问题，但要知道构建依赖 GitHub Releases 可达（离线/内网 runner 会挂）。
4. **构建工具链要求更高**：`@runanywhere/core` 的 build.gradle 硬编码 `cmake version = "3.30.5"`（runner 预装 3.31.5/4.1.2，SDK manager 会自动补装 3.30.5）；C++ 经 CMake+NDK 编译（cpp-adapter + prefab 对接 Nitro），NDK 用 app 的 `rootProject.ext.ndkVersion`。Java 17 source/target，JDK 21 无冲突。
5. **Nitro 版本匹配**：包内 nitrogen 生成物是 `^0.34.1` 代码生成器产出，运行时是 `react-native-nitro-modules@0.35.5`。Nitro 生态对生成器/运行时次版本匹配有要求——装完先 `npm ls react-native-nitro-modules` 看警告，必要时把 app 的 nitro-modules pin 到 runanywhere README 指定的版本。这是**唯一一个可能要动 package.json 版本号的点**。
6. minSdk：包默认 24，app 已设 29（expo-build-properties），包的 `getExtOrIntegerDefault` 会读 rootProject ext，以 app 为准，无冲突。

### 上游 workflow 里的历史残留（别照抄）

`android-apk-release.yml` 的 `registry-url: https://npm.pkg.github.com` + `scope: @boudra` + `NODE_AUTH_TOKEN`：`package-lock.json` 中 0 处引用该 registry，纯残留，不需要任何 token。

---

## 7. 本地等价命令（想在任何 Linux 机器手动复现）

```bash
# 前置：node 22 / java 21 / ANDROID_HOME 指向带 cmdline-tools 的 SDK，license 已接受
npm ci                                   # 根目录
npm run build:app-deps
npm run build:terminal-webview --workspace=@getpaseo/app
cd packages/app
APP_VARIANT=production npx expo prebuild --platform android --clean --non-interactive
cd android
APP_VARIANT=production ./gradlew :app:assembleRelease \
  -x lint -x lintVitalAnalyzeRelease -x lintVitalRelease \
  -x generateReleaseLintModel -x generateReleaseLintVitalModel
# 产物：android/app/build/outputs/apk/release/app-release.apk（debug-signed, sh.paseo, versionCode 9001）
```
